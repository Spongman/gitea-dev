import type { WorkspaceFs } from '../../packages/gitea-vscode-web/src/shell/fs.js';

const FILE = 1;
const DIRECTORY = 2;
const SYMBOLIC_LINK = 64;

type Node = { kind: 'file'; content: Uint8Array } | { kind: 'directory' } | { kind: 'link'; target?: 'file' | 'directory' };

/** Same `code` values as vscode.FileSystemError. */
export class FakeFileSystemError extends Error {
	constructor(readonly code: 'FileNotFound' | 'FileExists' | 'FileIsADirectory' | 'FileNotADirectory' | 'NoPermissions' | 'Unavailable', path: string) {
		super(`${code}: ${path}`);
	}
}

const enc = new TextEncoder();

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

/** Models the behavior of the gitea-vfs provider seen through vscode.workspace.fs. URIs are '/a/b' strings. */
export class FakeWorkspaceFs implements WorkspaceFs<string> {
	readonly nodes = new Map<string, Node>([['/', { kind: 'directory' }]]);
	readonly calls: string[] = [];
	readonly readonly = new Set<string>();

	constructor(files: Record<string, string | { link: 'file' | 'directory' | undefined }> = {}) {
		for (const [path, value] of Object.entries(files)) {
			const full = `/${path}`;
			for (let dir = parentOf(full); dir !== '/'; dir = parentOf(dir)) this.nodes.set(dir, { kind: 'directory' });
			this.nodes.set(full, typeof value === 'string' ? { kind: 'file', content: enc.encode(value) } : { kind: 'link', target: value.link });
		}
	}

	text(path: string): string | undefined {
		const node = this.nodes.get(`/${path}`);
		return node?.kind === 'file' ? new TextDecoder().decode(node.content) : undefined;
	}

	#node(uri: string): Node {
		const node = this.nodes.get(uri);
		if (node === undefined) throw new FakeFileSystemError('FileNotFound', uri);
		return node;
	}

	#requireParent(uri: string): void {
		const parent = this.nodes.get(parentOf(uri));
		if (parent === undefined) throw new FakeFileSystemError('FileNotFound', uri);
		if (parent.kind !== 'directory') throw new FakeFileSystemError('FileNotADirectory', uri);
	}

	async stat(uri: string) {
		this.calls.push(`stat ${uri}`);
		const node = this.#node(uri);
		const permissions = this.readonly.has(uri) ? 1 : undefined;
		const base = { size: node.kind === 'file' ? node.content.length : 0, mtime: 1_700_000_000_000, ...(permissions ? { permissions } : {}) };
		if (node.kind === 'file') return { ...base, type: FILE };
		if (node.kind === 'directory') return { ...base, type: DIRECTORY };
		return { ...base, type: SYMBOLIC_LINK | (node.target === 'file' ? FILE : node.target === 'directory' ? DIRECTORY : 0) };
	}

	async readDirectory(uri: string): Promise<[string, number][]> {
		this.calls.push(`readDirectory ${uri}`);
		const node = this.#node(uri);
		if (node.kind !== 'directory') throw new FakeFileSystemError('FileNotADirectory', uri);
		const prefix = uri === '/' ? '/' : `${uri}/`;
		const rows: [string, number][] = [];
		for (const [path, child] of this.nodes) {
			if (path === uri || !path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
			const type = child.kind === 'file' ? FILE : child.kind === 'directory' ? DIRECTORY : SYMBOLIC_LINK | (child.target === 'file' ? FILE : child.target === 'directory' ? DIRECTORY : 0);
			rows.push([path.slice(prefix.length), type]);
		}
		return rows;
	}

	async readFile(uri: string): Promise<Uint8Array> {
		this.calls.push(`readFile ${uri}`);
		const node = this.#node(uri);
		if (node.kind === 'directory') throw new FakeFileSystemError('FileIsADirectory', uri);
		if (node.kind === 'link') throw new FakeFileSystemError('Unavailable', uri);
		return node.content.slice();
	}

	async writeFile(uri: string, content: Uint8Array): Promise<void> {
		this.calls.push(`writeFile ${uri}`);
		this.#requireParent(uri);
		if (this.readonly.has(uri)) throw new FakeFileSystemError('NoPermissions', uri);
		if (this.nodes.get(uri)?.kind === 'directory') throw new FakeFileSystemError('FileIsADirectory', uri);
		this.nodes.set(uri, { kind: 'file', content: content.slice() });
	}

	async createDirectory(uri: string): Promise<void> {
		this.calls.push(`createDirectory ${uri}`);
		this.#requireParent(uri);
		if (this.nodes.has(uri)) throw new FakeFileSystemError('FileExists', uri);
		this.nodes.set(uri, { kind: 'directory' });
	}

	async delete(uri: string, options?: { recursive?: boolean }): Promise<void> {
		this.calls.push(`delete ${uri}`);
		const node = this.#node(uri);
		if (node.kind === 'directory') {
			const below = [...this.nodes.keys()].filter((path) => path.startsWith(`${uri}/`));
			if (below.length > 0 && !options?.recursive) throw new FakeFileSystemError('NoPermissions', uri);
			for (const path of below) this.nodes.delete(path);
		}
		this.nodes.delete(uri);
	}

	async rename(source: string, target: string, options?: { overwrite?: boolean }): Promise<void> {
		this.calls.push(`rename ${source} ${target}`);
		const node = this.#node(source);
		this.#requireParent(target);
		if (this.nodes.has(target) && !options?.overwrite) throw new FakeFileSystemError('FileExists', target);
		const moved = [...this.nodes].filter(([path]) => path === source || path.startsWith(`${source}/`));
		for (const [path] of moved) this.nodes.delete(path);
		this.nodes.delete(target);
		for (const [path, value] of moved) this.nodes.set(target + path.slice(source.length), value);
		void node;
	}
}

export const fakeUri = (path: string): string => `/${path}`;
