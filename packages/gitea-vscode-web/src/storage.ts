export type OverlayRecord = FileRecord | DeletedRecord | DirectoryRecord;

export interface FileRecord {
	kind: 'file';
	state: 'created' | 'modified';
	content: Uint8Array;
	/** Blob sha at the base commit; immutable once set. */
	originalSha?: string;
	/** Base path this created file was renamed from; originalSha is that file's blob sha. */
	renamedFrom?: string;
	ctime: number;
	mtime: number;
}

interface DeletedRecord {
	kind: 'deleted';
	originalSha: string;
	ctime: number;
	mtime: number;
}

/** Local-only empty directory; never committed. */
interface DirectoryRecord {
	kind: 'directory';
	/** Blob sha of the base file this directory replaced; that file is pending deletion. */
	originalSha?: string;
	ctime: number;
	mtime: number;
}

export interface StoredRecord {
	/** JSON of [instance, owner, repository, ref]. */
	identity: string;
	baseCommit: string;
	path: string;
	record: OverlayRecord;
}

export interface StoredKey {
	identity: string;
	baseCommit: string;
	path: string;
}

export interface OverlayStorage {
	loadIdentity(identity: string): Promise<StoredRecord[]>;
	/** Applies puts, then deletes; durable when it resolves. A key in both is kept. */
	apply(puts: StoredRecord[], deletes: StoredKey[]): Promise<void>;
}

function copyRecord(record: OverlayRecord): OverlayRecord {
	return record.kind === 'file' ? { ...record, content: record.content.slice() } : { ...record };
}

export class MemoryOverlayStorage implements OverlayStorage {
	readonly #rows = new Map<string, StoredRecord>();

	async loadIdentity(identity: string): Promise<StoredRecord[]> {
		return [...this.#rows.values()]
			.filter((row) => row.identity === identity)
			.map((row) => ({ ...row, record: copyRecord(row.record) }));
	}

	async apply(puts: StoredRecord[], deletes: StoredKey[]): Promise<void> {
		for (const key of deletes) this.#rows.delete(JSON.stringify([key.identity, key.baseCommit, key.path]));
		for (const row of puts) {
			this.#rows.set(JSON.stringify([row.identity, row.baseCommit, row.path]), {
				...row,
				record: copyRecord(row.record),
			});
		}
	}
}

/**
 * Files under the extension's global storage. In the editor these live in the page's IndexedDB
 * (VS Code's `vscode-userdata` file system), so they do not depend on the extension host origin.
 */
export interface StorageFiles {
	/** Undefined when the file is missing. */
	read(path: string): Promise<Uint8Array | undefined>;
	/** Durable when it resolves. */
	write(path: string, data: Uint8Array): Promise<void>;
	/** No-op when the file is missing. */
	delete(path: string): Promise<void>;
	/** File names in a directory; empty when it is missing. */
	list(directory: string): Promise<string[]>;
}

/** Hex SHA-256 of a string; names files after keys of any length or character set. */
export async function fileName(key: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const MAX_PARALLEL_FILES = 16;

async function eachLimit<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_FILES, items.length) }, worker));
}

/** One record per file: a 4-byte header length, the JSON header, then the file content if any. */
function encodeRow(row: StoredRecord): Uint8Array {
	const { content, ...record } = row.record as FileRecord;
	const header = new TextEncoder().encode(JSON.stringify({ ...row, record }));
	const body = content ?? new Uint8Array(0);
	const out = new Uint8Array(4 + header.byteLength + body.byteLength);
	new DataView(out.buffer).setUint32(0, header.byteLength);
	out.set(header, 4);
	out.set(body, 4 + header.byteLength);
	return out;
}

function decodeRow(bytes: Uint8Array): StoredRecord {
	const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	const row = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as StoredRecord;
	if (row.record.kind === 'file') row.record.content = bytes.slice(4 + length);
	return row;
}

/**
 * Pending changes as one file per record, `overlay/<identity>/<base commit and path>`. A put is
 * written before any delete, so a failure part-way can leave a change in two places but never in
 * none. Concurrent tabs follow last-writer-wins per record.
 */
export class FileOverlayStorage implements OverlayStorage {
	readonly #files: StorageFiles;

	constructor(files: StorageFiles) {
		this.#files = files;
	}

	async #path(key: StoredKey): Promise<string> {
		return `overlay/${await fileName(key.identity)}/${await fileName(JSON.stringify([key.baseCommit, key.path]))}`;
	}

	async loadIdentity(identity: string): Promise<StoredRecord[]> {
		const directory = `overlay/${await fileName(identity)}`;
		const rows: StoredRecord[] = [];
		await eachLimit(await this.#files.list(directory), async (name) => {
			const bytes = await this.#files.read(`${directory}/${name}`);
			if (bytes === undefined) return;
			const row = decodeRow(bytes);
			if (row.identity === identity) rows.push(row);
		});
		return rows;
	}

	async apply(puts: StoredRecord[], deletes: StoredKey[]): Promise<void> {
		const written = new Set<string>();
		await eachLimit(puts, async (row) => {
			const path = await this.#path(row);
			written.add(path);
			await this.#files.write(path, encodeRow(row));
		});
		await eachLimit(deletes, async (key) => {
			const path = await this.#path(key);
			if (!written.has(path)) await this.#files.delete(path);
		});
	}
}
