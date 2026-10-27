import type { StorageFiles } from '../../packages/gitea-vscode-web/src/storage.js';

/** In-memory StorageFiles; `files` is shared by every store built on it, like one browser profile. */
export class MemoryStorageFiles implements StorageFiles {
	readonly files = new Map<string, Uint8Array>();

	async read(path: string): Promise<Uint8Array | undefined> {
		return this.files.get(path)?.slice();
	}

	async write(path: string, data: Uint8Array): Promise<void> {
		this.files.set(path, data.slice());
	}

	async delete(path: string): Promise<void> {
		this.files.delete(path);
	}

	async list(directory: string): Promise<string[]> {
		const prefix = `${directory}/`;
		return [...this.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map((path) => path.slice(prefix.length));
	}
}
