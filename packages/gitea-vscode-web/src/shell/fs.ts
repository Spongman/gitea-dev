import type { FsStat, IFileSystem } from 'just-bash/browser';

// vscode.FileType bits (vscode.d.ts: File 1, Directory 2, SymbolicLink 64) and
// FilePermission.Readonly; numeric so this file runs without the vscode module.
const FILE = 1;
const DIRECTORY = 2;
const SYMBOLIC_LINK = 64;
const READONLY = 1;

/** The part of `vscode.workspace.fs` the shell uses; `U` is `vscode.Uri` in the extension. */
export interface WorkspaceFs<U> {
	stat(uri: U): PromiseLike<{ type: number; size: number; mtime: number; permissions?: number }>;
	readDirectory(uri: U): PromiseLike<[string, number][]>;
	readFile(uri: U): PromiseLike<Uint8Array>;
	writeFile(uri: U, content: Uint8Array): PromiseLike<void>;
	createDirectory(uri: U): PromiseLike<void>;
	delete(uri: U, options?: { recursive?: boolean; useTrash?: boolean }): PromiseLike<void>;
	rename(source: U, target: U, options?: { overwrite?: boolean }): PromiseLike<void>;
}

type Errno = 'ENOENT' | 'EEXIST' | 'EISDIR' | 'ENOTDIR' | 'ENOTEMPTY' | 'EACCES' | 'EPERM' | 'EINVAL' | 'ENOTSUP' | 'EIO';

const TEXT: Record<Errno, string> = {
	ENOENT: 'no such file or directory',
	EEXIST: 'file already exists',
	EISDIR: 'illegal operation on a directory',
	ENOTDIR: 'not a directory',
	ENOTEMPTY: 'directory not empty',
	EACCES: 'permission denied',
	EPERM: 'operation not permitted',
	EINVAL: 'invalid argument',
	ENOTSUP: 'operation not supported',
	EIO: 'i/o error',
};

/** just-bash derives its "No such file or directory" style messages from the leading code. */
export class ShellFsError extends Error {
	readonly code: Errno;

	constructor(code: Errno, op: string, path: string, detail?: string) {
		super(`${code}: ${TEXT[code]}, ${op} '${path}'${detail === undefined ? '' : `: ${detail}`}`);
		this.name = 'ShellFsError';
		this.code = code;
	}
}

const BY_FILE_SYSTEM_ERROR: Record<string, Errno> = {
	FileNotFound: 'ENOENT',
	FileExists: 'EEXIST',
	FileIsADirectory: 'EISDIR',
	FileNotADirectory: 'ENOTDIR',
	NoPermissions: 'EACCES',
};

/** Maps a `vscode.FileSystemError` (by its `code`) or any other error to an errno error. */
export function toShellError(error: unknown, op: string, path: string): ShellFsError {
	if (error instanceof ShellFsError) return error;
	const code = (error as { code?: unknown } | null)?.code;
	const detail = error instanceof Error ? error.message : String(error);
	const errno = typeof code === 'string' ? BY_FILE_SYSTEM_ERROR[code] : undefined;
	return errno === undefined ? new ShellFsError('EIO', op, path, detail) : new ShellFsError(errno, op, path, errno === 'EACCES' ? detail : undefined);
}

/** Normalized absolute path: '/', '/a/b'. */
function absolute(path: string): string {
	const out: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return `/${out.join('/')}`;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Encoding = 'utf8' | 'utf-8' | 'ascii' | 'binary' | 'base64' | 'hex' | 'latin1';
type EncodingArg = { encoding?: Encoding | null } | Encoding | null | undefined;

function encodingOf(arg: EncodingArg): Encoding {
	const value = typeof arg === 'string' ? arg : arg?.encoding;
	return value ?? 'utf8';
}

function toBytes(content: string | Uint8Array, encoding: Encoding): Uint8Array {
	if (typeof content !== 'string') return content;
	switch (encoding) {
		case 'binary':
		case 'latin1':
		case 'ascii': {
			const out = new Uint8Array(content.length);
			let length = 0;
			for (const ch of content) out[length++] = ch.charCodeAt(0) & 0xff;
			return length === out.length ? out : out.slice(0, length);
		}
		case 'hex':
			return Uint8Array.from(content.match(/../g) ?? [], (byte) => parseInt(byte, 16));
		case 'base64': {
			const binary = atob(content);
			const out = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
			return out;
		}
		default:
			return encoder.encode(content);
	}
}

/** One char per byte, built in slices so no per-byte string or argument list gets large. */
function byteString(bytes: Uint8Array): string {
	const slices: string[] = [];
	for (let i = 0; i < bytes.length; i += 8192) slices.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
	return slices.join('');
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

function fromBytes(bytes: Uint8Array, encoding: Encoding): string {
	switch (encoding) {
		case 'binary':
		case 'latin1':
		case 'ascii':
			return byteString(bytes);
		case 'hex':
			return Array.from(bytes, (byte) => HEX[byte]).join('');
		case 'base64':
			return btoa(byteString(bytes));
		default:
			return decoder.decode(bytes);
	}
}

/**
 * just-bash file system over the `gitea-vfs` workspace folder (mounted at the root of the
 * folder), so every write goes through the file system provider into the change overlay.
 * What the overlay cannot represent (links, modes, times) fails with a clear error.
 */
export class VfsFileSystem<U> implements IFileSystem {
	readonly #fs: WorkspaceFs<U>;
	readonly #uri: (path: string) => U;
	/** Absolute paths seen so far, for the synchronous getAllPaths. */
	readonly #known = new Set<string>(['/']);
	/** Known children by parent directory, so a subtree is found without scanning every path. */
	readonly #children = new Map<string, Set<string>>();

	/** `uri` maps a repository-relative path ('' is the root) to a workspace URI. */
	constructor(fs: WorkspaceFs<U>, uri: (path: string) => U) {
		this.#fs = fs;
		this.#uri = uri;
	}

	/** Records paths (repository-relative or absolute) and their ancestors. */
	learn(paths: Iterable<string>): void {
		for (const path of paths) {
			for (let p = absolute(path); p !== '/' && !this.#known.has(p); p = parentOf(p)) {
				this.#known.add(p);
				const parent = parentOf(p);
				const siblings = this.#children.get(parent);
				if (siblings === undefined) this.#children.set(parent, new Set([p]));
				else siblings.add(p);
			}
		}
	}

	/** A known path and everything known below it. */
	#subtree(root: string): string[] {
		const found: string[] = [];
		for (const stack = [root]; stack.length > 0; ) {
			const path = stack.pop() as string;
			found.push(path);
			for (const child of this.#children.get(path) ?? []) stack.push(child);
		}
		return found;
	}

	/** Drops a path and everything below it. */
	forget(path: string): void {
		const root = absolute(path);
		if (root === '/' || !this.#known.has(root)) return;
		for (const known of this.#subtree(root)) {
			this.#known.delete(known);
			this.#children.delete(known);
		}
		const siblings = this.#children.get(parentOf(root));
		siblings?.delete(root);
		if (siblings?.size === 0) this.#children.delete(parentOf(root));
	}

	/** Drops every learned path, for a new base commit. */
	reset(): void {
		this.#known.clear();
		this.#known.add('/');
		this.#children.clear();
	}

	#at(path: string): U {
		return this.#uri(absolute(path).slice(1));
	}

	async #stat(path: string, follow: boolean, op: string): Promise<FsStat> {
		let stat;
		try {
			stat = await this.#fs.stat(this.#at(path));
		} catch (error) {
			throw toShellError(error, op, path);
		}
		const link = (stat.type & SYMBOLIC_LINK) !== 0;
		const directory = (stat.type & DIRECTORY) !== 0;
		const file = (stat.type & FILE) !== 0;
		if (link && follow && !directory && !file) throw new ShellFsError('ENOENT', op, path, 'broken link');
		const readonly = stat.permissions === READONLY;
		const mode = link ? 0o777 : directory ? (readonly ? 0o555 : 0o755) : readonly ? 0o444 : 0o644;
		const asLink = link && !follow;
		return {
			isFile: file && !asLink,
			isDirectory: directory && !asLink,
			isSymbolicLink: asLink,
			mode,
			size: stat.size,
			mtime: new Date(stat.mtime),
		};
	}

	stat(path: string): Promise<FsStat> {
		return this.#stat(path, true, 'stat');
	}

	lstat(path: string): Promise<FsStat> {
		return this.#stat(path, false, 'lstat');
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.#fs.stat(this.#at(path));
			return true;
		} catch {
			return false;
		}
	}

	async readFile(path: string, options?: EncodingArg): Promise<string> {
		return fromBytes(await this.readFileBuffer(path), encodingOf(options));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		try {
			return await this.#fs.readFile(this.#at(path));
		} catch (error) {
			throw toShellError(error, 'open', path);
		}
	}

	/** Encodes content for a write; text that is not valid in its encoding is EINVAL, not a raw DOMException. */
	#encode(content: string | Uint8Array, options: EncodingArg, op: string, path: string): Uint8Array {
		try {
			return toBytes(content, encodingOf(options));
		} catch (error) {
			throw new ShellFsError('EINVAL', op, path, error instanceof Error ? error.message : String(error));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, options?: EncodingArg): Promise<void> {
		const bytes = this.#encode(content, options, 'open', path);
		try {
			await this.#fs.writeFile(this.#at(path), bytes);
		} catch (error) {
			throw toShellError(error, 'open', path);
		}
		this.learn([path]);
	}

	async appendFile(path: string, content: string | Uint8Array, options?: EncodingArg): Promise<void> {
		let existing: Uint8Array = new Uint8Array(0);
		try {
			existing = await this.#fs.readFile(this.#at(path));
		} catch (error) {
			if ((error as { code?: unknown } | null)?.code !== 'FileNotFound') throw toShellError(error, 'write', path);
		}
		const added = this.#encode(content, options, 'write', path);
		const joined = new Uint8Array(existing.length + added.length);
		joined.set(existing);
		joined.set(added, existing.length);
		await this.writeFile(path, joined);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const target = absolute(path);
		const missing: string[] = [];
		for (let p = target; ; p = parentOf(p)) {
			const found = await this.#statOrUndefined(p, 'mkdir');
			if (found === undefined) {
				missing.unshift(p);
				if (p === '/') break;
				continue;
			}
			if (!found.isDirectory) throw new ShellFsError(p === target ? 'EEXIST' : 'ENOTDIR', 'mkdir', path);
			if (p === target) {
				if (options?.recursive) return;
				throw new ShellFsError('EEXIST', 'mkdir', path);
			}
			break;
		}
		if (!options?.recursive && missing.length > 1) throw new ShellFsError('ENOENT', 'mkdir', path);
		for (const p of missing) {
			try {
				await this.#fs.createDirectory(this.#at(p));
			} catch (error) {
				throw toShellError(error, 'mkdir', path);
			}
		}
		this.learn([target]);
	}

	async #statOrUndefined(path: string, op: string): Promise<FsStat | undefined> {
		try {
			return await this.#stat(path, true, op);
		} catch (error) {
			if (error instanceof ShellFsError && error.code === 'ENOENT') return undefined;
			throw error;
		}
	}

	async readdir(path: string): Promise<string[]> {
		return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
	}

	async readdirWithFileTypes(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
		let rows: [string, number][];
		try {
			rows = await this.#fs.readDirectory(this.#at(path));
		} catch (error) {
			throw toShellError(error, 'scandir', path);
		}
		const entries = rows.map(([name, type]) => {
			const link = (type & SYMBOLIC_LINK) !== 0;
			return { name, isFile: !link && (type & FILE) !== 0, isDirectory: !link && (type & DIRECTORY) !== 0, isSymbolicLink: link };
		});
		this.learn(entries.map((entry) => `${absolute(path)}/${entry.name}`));
		return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		let stat: FsStat;
		try {
			stat = await this.#stat(path, false, 'rm');
		} catch (error) {
			if (options?.force && error instanceof ShellFsError && error.code === 'ENOENT') return;
			throw error;
		}
		if (stat.isDirectory && !options?.recursive && (await this.readdir(path)).length > 0) {
			throw new ShellFsError('ENOTEMPTY', 'rm', path);
		}
		try {
			await this.#fs.delete(this.#at(path), { recursive: true, useTrash: false });
		} catch (error) {
			throw toShellError(error, 'rm', path);
		}
		this.forget(path);
	}

	async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
		const stat = await this.#stat(src, true, 'cp');
		if (!stat.isDirectory) {
			await this.writeFile(dest, await this.readFileBuffer(src));
			return;
		}
		if (!options?.recursive) throw new ShellFsError('EISDIR', 'cp', src);
		const from = absolute(src);
		const to = absolute(dest);
		if (to === from || to.startsWith(`${from}/`)) throw new ShellFsError('EINVAL', 'cp', src, `cannot copy into itself, '${dest}'`);
		await this.mkdir(to, { recursive: true });
		for (const name of await this.readdir(from)) await this.cp(`${from}/${name}`, `${to}/${name}`, options);
	}

	async mv(src: string, dest: string): Promise<void> {
		const from = absolute(src);
		const to = absolute(dest);
		const source = await this.#stat(from, false, 'mv');
		if (from === to) return;
		if (source.isDirectory && to.startsWith(`${from}/`)) throw new ShellFsError('EINVAL', 'mv', src, `cannot move into itself, '${dest}'`);
		const target = await this.#statOrUndefined(to, 'mv');
		if (target?.isDirectory && !source.isDirectory) throw new ShellFsError('EISDIR', 'mv', dest);
		if (target && !target.isDirectory && source.isDirectory) throw new ShellFsError('ENOTDIR', 'mv', dest);
		if (target?.isDirectory && (await this.readdir(to)).length > 0) throw new ShellFsError('ENOTEMPTY', 'mv', dest);
		try {
			await this.#fs.rename(this.#at(from), this.#at(to), { overwrite: true });
		} catch (error) {
			throw toShellError(error, 'mv', src);
		}
		const moved = this.#known.has(from) ? this.#subtree(from) : [];
		this.forget(from);
		this.learn(moved.map((known) => to + known.slice(from.length)));
		this.learn([to]);
	}

	resolvePath(base: string, path: string): string {
		return absolute(path.startsWith('/') ? path : `${base}/${path}`);
	}

	getAllPaths(): string[] {
		return [...this.#known].sort();
	}

	async chmod(path: string, _mode: number): Promise<void> {
		await this.#stat(path, true, 'chmod');
		throw new ShellFsError('EPERM', 'chmod', path, 'the repository overlay does not track file modes');
	}

	async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
		await this.#stat(path, true, 'utimes');
		throw new ShellFsError('EPERM', 'utimes', path, 'the repository overlay does not track modification times');
	}

	async symlink(_target: string, linkPath: string): Promise<void> {
		throw new ShellFsError('ENOTSUP', 'symlink', linkPath, 'symbolic links cannot be created in the repository overlay');
	}

	async link(_existingPath: string, newPath: string): Promise<void> {
		throw new ShellFsError('ENOTSUP', 'link', newPath, 'hard links cannot be created in the repository overlay');
	}

	async readlink(path: string): Promise<string> {
		const stat = await this.#stat(path, false, 'readlink');
		if (!stat.isSymbolicLink) throw new ShellFsError('EINVAL', 'readlink', path);
		throw new ShellFsError('ENOTSUP', 'readlink', path, 'link targets are not readable through the workspace file system');
	}

	/** Existence check only: links are followed by the overlay and cannot be resolved here. */
	async realpath(path: string): Promise<string> {
		await this.#stat(path, true, 'realpath');
		return absolute(path);
	}
}
