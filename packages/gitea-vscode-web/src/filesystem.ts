import * as vscode from 'vscode';
import type { EntryType } from '../../gitea-repository/src/index.js';
import { descriptorAuthority, SCHEME } from './descriptor.js';
import { fileTypeBits } from './file-type.js';
import { OverlayError, type ChangeType, type FileChange, type LinkTarget } from './overlay.js';
import type { Session } from './session.js';
import type { SessionRegistry } from './sessions.js';
import { parentOf, pathOf } from './util.js';

function fileType(type: EntryType, target?: LinkTarget): vscode.FileType {
	return fileTypeBits(type, target) as vscode.FileType;
}

function toFileSystemError(error: unknown, uri: vscode.Uri): Error {
	if (error instanceof vscode.FileSystemError) return error;
	if (error instanceof OverlayError) {
		switch (error.code) {
			case 'NotFound':
				return vscode.FileSystemError.FileNotFound(uri);
			case 'Exists':
				return vscode.FileSystemError.FileExists(uri);
			case 'IsDirectory':
				return vscode.FileSystemError.FileIsADirectory(uri);
			case 'NotDirectory':
				return vscode.FileSystemError.FileNotADirectory(uri);
			case 'Unsupported':
				return vscode.FileSystemError.Unavailable(error.message);
			case 'BrokenLink':
				return vscode.FileSystemError.Unavailable(error.message);
			default:
				return vscode.FileSystemError.NoPermissions(error.message);
		}
	}
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	switch (code) {
		case 'not-found':
			return vscode.FileSystemError.FileNotFound(uri);
		case 'is-a-directory':
			return vscode.FileSystemError.FileIsADirectory(uri);
		case 'not-a-directory':
			return vscode.FileSystemError.FileNotADirectory(uri);
		case 'unauthenticated':
		case 'forbidden':
			return vscode.FileSystemError.NoPermissions(message);
		default:
			return vscode.FileSystemError.Unavailable(message);
	}
}

export function vfsUri(session: Session, path: string, scheme: string = SCHEME): vscode.Uri {
	return vscode.Uri.from({ scheme, authority: descriptorAuthority(session.descriptor), path: `/${path}` });
}

const CHANGE_TYPES: Record<ChangeType, vscode.FileChangeType> = {
	created: vscode.FileChangeType.Created,
	changed: vscode.FileChangeType.Changed,
	deleted: vscode.FileChangeType.Deleted,
};

/** gitea-vfs: the immutable remote tree merged with the local overlay. */
export class GiteaFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
	readonly #emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly #disposables: vscode.Disposable[] = [this.#emitter];
	readonly onDidChangeFile = this.#emitter.event;
	readonly #registry: SessionRegistry;

	constructor(registry: SessionRegistry) {
		this.#registry = registry;
		this.#disposables.push(
			{ dispose: registry.onDidOpen((session) => this.#attach(session)) },
		);
		for (const session of registry.sessions) this.#attach(session);
	}

	dispose(): void {
		for (const disposable of this.#disposables) disposable.dispose();
	}

	/** Fires file events for overlay changes, plus parent directories and the root as needed. */
	#attach(session: Session): void {
		const off = session.overlay.onDidChange((event) => {
			const changes = new Map<string, ChangeType>();
			for (const change of event.changes) changes.set(change.path, change.type);
			const touched: FileChange[] = [...event.changes];
			for (const change of touched) {
				if (change.type === 'changed') continue;
				for (let dir = parentOf(change.path); ; dir = parentOf(dir)) {
					if (!changes.has(dir)) changes.set(dir, 'changed');
					if (dir === '') break;
				}
			}
			if (event.reason !== 'edit' && event.reason !== 'conflicts' && !changes.has('')) changes.set('', 'changed');
			if (changes.size === 0) return;
			this.#emitter.fire(
				[...changes].map(([path, type]) => ({ type: CHANGE_TYPES[type], uri: vfsUri(session, path) })),
			);
		});
		this.#disposables.push({ dispose: off });
	}

	async #session(uri: vscode.Uri): Promise<{ session: Session; path: string }> {
		try {
			const session = await this.#registry.resolveUri(uri);
			return { session, path: uri.path };
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	/** Tells the workbench the tree at this URI may have changed, e.g. after sign-in. */
	refresh(uri: vscode.Uri): void {
		this.#emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const { session, path } = await this.#session(uri);
		try {
			const stat = await session.overlay.stat(path);
			const readonly = stat.readonly || session.readonlyHint;
			return {
				type: fileType(stat.type, stat.target),
				ctime: stat.ctime,
				mtime: stat.mtime,
				size: stat.size,
				...(readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
			};
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const { session, path } = await this.#session(uri);
		try {
			return (await session.overlay.readDirectory(path)).map((item) => [item.name, fileType(item.type, item.target)]);
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const { session, path } = await this.#session(uri);
		try {
			return await session.overlay.readFile(path);
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		const { session, path } = await this.#session(uri);
		this.#requireWritable(session, uri);
		try {
			await session.overlay.writeFile(path, content, options);
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		const { session, path } = await this.#session(uri);
		this.#requireWritable(session, uri);
		try {
			await session.overlay.createDirectory(path);
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
		const { session, path } = await this.#session(uri);
		this.#requireWritable(session, uri);
		try {
			await session.overlay.delete(path, options);
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		const { session, path } = await this.#session(oldUri);
		const target = await this.#session(newUri);
		if (target.session !== session) throw vscode.FileSystemError.NoPermissions('Cannot move across repositories.');
		this.#requireWritable(session, oldUri);
		try {
			await session.overlay.rename(path, target.path, options);
		} catch (error) {
			throw toFileSystemError(error, oldUri);
		}
	}

	#requireWritable(session: Session, uri: vscode.Uri): void {
		if (session.readonlyHint) throw vscode.FileSystemError.NoPermissions(`Read-only: ${uri.path}`);
	}
}

/** gitea-base: read-only original content at the base commit, for diffs and quick diff. */
export class GiteaBaseFileSystemProvider implements vscode.FileSystemProvider {
	readonly #registry: SessionRegistry;
	readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

	constructor(registry: SessionRegistry) {
		this.#registry = registry;
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		try {
			const session = await this.#registry.resolveUri(uri);
			const entry = await session.repository.getEntry(pathOf(uri));
			return {
				type: fileType(entry.type),
				ctime: 0,
				mtime: 0,
				size: entry.size,
				permissions: vscode.FilePermission.Readonly,
			};
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	async readDirectory(): Promise<[string, vscode.FileType][]> {
		return [];
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		try {
			const session = await this.#registry.resolveUri(uri);
			return (await session.repository.readFile(pathOf(uri))).content;
		} catch (error) {
			throw toFileSystemError(error, uri);
		}
	}

	createDirectory(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	writeFile(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
}
