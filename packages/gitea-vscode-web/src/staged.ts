import { fileName, type StorageFiles } from './storage.js';

/** Staged change paths per repository ref; a write is durable before it resolves. */
export interface StagedStore {
	load(identity: string): Promise<string[]>;
	/** Replaces the staged set; an empty set removes it. */
	save(identity: string, paths: readonly string[]): Promise<void>;
}

/** One JSON file per identity, `staged/<identity>`. */
export class FileStagedStore implements StagedStore {
	readonly #files: StorageFiles;

	constructor(files: StorageFiles) {
		this.#files = files;
	}

	async load(identity: string): Promise<string[]> {
		const bytes = await this.#files.read(`staged/${await fileName(identity)}`);
		if (bytes === undefined) return [];
		const paths: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return Array.isArray(paths) ? (paths as string[]) : [];
	}

	async save(identity: string, paths: readonly string[]): Promise<void> {
		const path = `staged/${await fileName(identity)}`;
		if (paths.length === 0) await this.#files.delete(path);
		else await this.#files.write(path, new TextEncoder().encode(JSON.stringify(paths)));
	}
}
