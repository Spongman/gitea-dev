/**
 * IndexedDB store for repository archives, separate from the overlay database. Files are
 * keyed [instance, owner, repository, commit, path]; an `archives` record per commit holds
 * the `complete` flag, which is written last, so a half-written archive is never served.
 */

export interface ArchiveKey {
	instance: string;
	owner: string;
	repository: string;
	commit: string;
}

interface ArchiveRecord extends ArchiveKey {
	complete: boolean;
	startedAt: number;
	/** Last write while incomplete; used to tell a crashed writer from a live one. */
	updatedAt: number;
	/** Last time the archive served reads; eviction is least-recently-used. */
	lastUsed: number;
	files: number;
	/** File bytes stored (counted against the cache budget once complete). */
	bytes: number;
	/** Id of the writer that owns the incomplete archive; only it may add rows, complete or abort. */
	writer?: string;
}

export interface StoredArchiveFile extends ArchiveKey {
	path: string;
	sha: string;
	size: number;
	content: Uint8Array;
	/** Id of the writer that stored the row; a row from another writer must be verified again. */
	writer?: string;
}

/** The slice of `navigator.locks` the store uses. */
export interface ArchiveLocks {
	request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<void> | undefined): Promise<unknown>;
}

interface ArchiveStoreOptions {
	name?: string;
	/** Required outside browsers (for example fake-indexeddb). */
	keyRange?: typeof IDBKeyRange;
	now?: () => number;
	/** Write batch size; a batch is one transaction. */
	batchBytes?: number;
	batchFiles?: number;
	/** One writer per archive across tabs; defaults to `navigator.locks`. Without it a fresh incomplete record counts as a live writer. */
	locks?: ArchiveLocks;
}

const FILES = 'files';
const ARCHIVES = 'archives';
const KEY_FIELDS = ['instance', 'owner', 'repository', 'commit'] as const;
/** An incomplete archive not written for this long belongs to a crashed or closed tab. */
const STALE_MS = 10 * 60_000;

export class ArchiveStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ArchiveStoreError';
	}
}

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

function committed(tx: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
		tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
	});
}

function keyArray(key: ArchiveKey): string[] {
	return KEY_FIELDS.map((field) => key[field]);
}

export class ArchiveStore {
	readonly #factory: IDBFactory;
	readonly #name: string;
	readonly #range: typeof IDBKeyRange;
	readonly now: () => number;
	readonly batchBytes: number;
	readonly batchFiles: number;
	readonly #locks: ArchiveLocks | undefined;
	#db: Promise<IDBDatabase> | undefined;

	constructor(factory: IDBFactory, options: ArchiveStoreOptions = {}) {
		this.#factory = factory;
		this.#name = options.name ?? 'gitea-dev-archive';
		this.#range = options.keyRange ?? globalThis.IDBKeyRange;
		this.now = options.now ?? Date.now;
		this.batchBytes = options.batchBytes ?? 4 * 1024 * 1024;
		this.batchFiles = options.batchFiles ?? 256;
		this.#locks = options.locks ?? (globalThis as { navigator?: { locks?: ArchiveLocks } }).navigator?.locks;
	}

	/** Holds the cross-tab lock of one archive until the returned function is called. */
	#acquire(key: ArchiveKey): Promise<() => void> {
		const locks = this.#locks;
		if (locks === undefined) return Promise.resolve(() => undefined);
		return new Promise<() => void>((resolve, reject) => {
			locks
				.request(`gitea-dev-archive:${JSON.stringify(keyArray(key))}`, { ifAvailable: true }, (lock) => {
					if (lock === null) {
						reject(new ArchiveStoreError('Another tab is writing this archive'));
						return undefined;
					}
					return new Promise<void>((held) => resolve(() => held()));
				})
				.catch(reject);
		});
	}

	#open(): Promise<IDBDatabase> {
		this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = this.#factory.open(this.#name, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore(FILES, { keyPath: [...KEY_FIELDS, 'path'] });
				request.result.createObjectStore(ARCHIVES, { keyPath: [...KEY_FIELDS] });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
			request.onblocked = () => reject(new Error('IndexedDB open blocked'));
		});
		this.#db.catch(() => {
			this.#db = undefined;
		});
		return this.#db;
	}

	/** Every row of one archive: [..key] up to [..key, []] (arrays sort after strings). */
	#rangeOf(key: ArchiveKey): IDBKeyRange {
		const prefix = keyArray(key);
		return this.#range.bound(prefix, [...prefix, []]);
	}

	async getArchive(key: ArchiveKey): Promise<ArchiveRecord | undefined> {
		const db = await this.#open();
		const record = await done<ArchiveRecord | undefined>(db.transaction(ARCHIVES, 'readonly').objectStore(ARCHIVES).get(keyArray(key)));
		return record;
	}

	async listArchives(): Promise<ArchiveRecord[]> {
		const db = await this.#open();
		return done<ArchiveRecord[]>(db.transaction(ARCHIVES, 'readonly').objectStore(ARCHIVES).getAll());
	}

	/** Reads several files in one transaction; a missing path yields undefined. */
	async getFiles(key: ArchiveKey, paths: string[]): Promise<(StoredArchiveFile | undefined)[]> {
		const db = await this.#open();
		const files = db.transaction(FILES, 'readonly').objectStore(FILES);
		return Promise.all(paths.map((path) => done<StoredArchiveFile | undefined>(files.get([...keyArray(key), path]))));
	}

	async countFiles(key: ArchiveKey): Promise<number> {
		const db = await this.#open();
		return done(db.transaction(FILES, 'readonly').objectStore(FILES).count(this.#rangeOf(key)));
	}

	/** Marks the archive as recently used. */
	async touch(key: ArchiveKey): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction(ARCHIVES, 'readwrite');
		const store = tx.objectStore(ARCHIVES);
		const record = await done<ArchiveRecord | undefined>(store.get(keyArray(key)));
		if (record !== undefined) {
			store.put({ ...record, lastUsed: this.now() });
		}
		await committed(tx);
	}

	/** Removes an archive record and all its files. */
	async delete(key: ArchiveKey): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction([FILES, ARCHIVES], 'readwrite');
		tx.objectStore(FILES).delete(this.#rangeOf(key));
		tx.objectStore(ARCHIVES).delete(keyArray(key));
		await committed(tx);
	}

	/**
	 * Starts writing an archive; throws when another writer is live or the archive is already complete.
	 * Rows of the same commit hold identical content, so rows of a crashed writer are kept.
	 */
	async begin(key: ArchiveKey): Promise<ArchiveWriter> {
		const release = await this.#acquire(key);
		try {
			const db = await this.#open();
			const now = this.now();
			const writer = `${now}-${Math.random().toString(36).slice(2)}`;
			const record: ArchiveRecord = { ...key, complete: false, startedAt: now, updatedAt: now, lastUsed: now, files: 0, bytes: 0, writer };
			const tx = db.transaction(ARCHIVES, 'readwrite');
			const archives = tx.objectStore(ARCHIVES);
			const existing = await done<ArchiveRecord | undefined>(archives.get(keyArray(key)));
			const live = this.#locks === undefined && existing !== undefined && !existing.complete && now - existing.updatedAt < STALE_MS;
			if (existing?.complete === true || live) {
				tx.abort();
				throw new ArchiveStoreError(existing?.complete === true ? 'The archive is already stored' : 'Another writer is writing this archive');
			}
			archives.put(record);
			await committed(tx);
			return new ArchiveWriter(this, db, key, record, this.#rangeOf(key), release);
		} catch (error) {
			release();
			throw error;
		}
	}

	/**
	 * Deletes archives still marked incomplete whose last write is older than `staleMs`
	 * (leftovers of a crashed or closed tab); a younger one may belong to a live tab.
	 */
	async purgeIncomplete(staleMs = STALE_MS): Promise<number> {
		const cutoff = this.now() - staleMs;
		const stale = (await this.listArchives()).filter((record) => !record.complete && record.updatedAt <= cutoff);
		for (const record of stale) {
			await this.delete(record);
		}
		return stale.length;
	}

	/** Deletes least-recently-used complete archives until the rest fit in `maxBytes`. */
	async evict(maxBytes: number, keep?: ArchiveKey): Promise<ArchiveKey[]> {
		const complete = (await this.listArchives()).filter((record) => record.complete);
		let total = complete.reduce((sum, record) => sum + record.bytes, 0);
		const removed: ArchiveKey[] = [];
		const keepId = keep === undefined ? undefined : JSON.stringify(keyArray(keep));
		for (const record of complete.sort((a, b) => a.lastUsed - b.lastUsed)) {
			if (total <= maxBytes) {
				break;
			}
			if (JSON.stringify(keyArray(record)) === keepId) {
				continue;
			}
			await this.delete(record);
			total -= record.bytes;
			removed.push({ instance: record.instance, owner: record.owner, repository: record.repository, commit: record.commit });
		}
		return removed;
	}
}

/** Batches puts into transactions; `complete()` flips the flag in a separate, final transaction. */
export class ArchiveWriter {
	readonly #store: ArchiveStore;
	readonly #db: IDBDatabase;
	readonly #key: ArchiveKey;
	readonly #range: IDBKeyRange;
	readonly #release: () => void;
	readonly #id: string;
	#record: ArchiveRecord;
	#batch: StoredArchiveFile[] = [];
	#batchBytes = 0;
	/** Distinct paths put, and distinct paths already written. */
	readonly #seen = new Set<string>();
	readonly #stored = new Set<string>();
	#bytes = 0;
	#closed = false;

	constructor(store: ArchiveStore, db: IDBDatabase, key: ArchiveKey, record: ArchiveRecord, range: IDBKeyRange, release: () => void) {
		this.#store = store;
		this.#db = db;
		this.#key = key;
		this.#record = record;
		this.#range = range;
		this.#release = release;
		this.#id = record.writer ?? '';
	}

	get files(): number {
		return this.#seen.size;
	}

	/** Buffers a file; resolves after the batch holding it is durable when the batch fills. */
	async put(path: string, sha: string, content: Uint8Array): Promise<void> {
		this.#assertOpen();
		this.#seen.add(path);
		this.#batch.push({ ...this.#key, path, sha, size: content.length, content, writer: this.#id });
		this.#batchBytes += content.length;
		if (this.#batchBytes >= this.#store.batchBytes || this.#batch.length >= this.#store.batchFiles) {
			await this.#flush();
		}
	}

	/** Inside `tx`: the archive record must still be this writer's, or the transaction is aborted. */
	async #owned(tx: IDBTransaction): Promise<void> {
		const current = await done<ArchiveRecord | undefined>(tx.objectStore(ARCHIVES).get(keyArray(this.#key)));
		if (current?.writer !== this.#id) {
			tx.abort();
			throw new ArchiveStoreError('The archive was taken over by another writer');
		}
	}

	async #flush(): Promise<void> {
		if (this.#batch.length === 0) {
			return;
		}
		const batch = this.#batch;
		const bytes = this.#batchBytes;
		this.#batch = [];
		this.#batchBytes = 0;
		const tx = this.#db.transaction([FILES, ARCHIVES], 'readwrite');
		await this.#owned(tx);
		const files = tx.objectStore(FILES);
		for (const row of batch) {
			files.put(row);
		}
		const stored = new Set(this.#stored);
		for (const row of batch) {
			stored.add(row.path);
		}
		const record: ArchiveRecord = { ...this.#record, updatedAt: this.#store.now(), files: stored.size, bytes: this.#bytes + bytes };
		tx.objectStore(ARCHIVES).put(record);
		await committed(tx);
		this.#record = record;
		for (const path of stored) {
			this.#stored.add(path);
		}
		this.#bytes = record.bytes;
	}

	/** Writes the remaining files, then sets `complete` in its own transaction after checking the rows are all there. */
	async complete(): Promise<ArchiveRecord> {
		this.#assertOpen();
		await this.#flush();
		const record: ArchiveRecord = { ...this.#record, complete: true, updatedAt: this.#store.now(), lastUsed: this.#store.now() };
		const tx = this.#db.transaction([FILES, ARCHIVES], 'readwrite');
		await this.#owned(tx);
		const rows = await done(tx.objectStore(FILES).count(this.#range));
		if (rows < record.files) {
			tx.abort();
			throw new ArchiveStoreError(`The archive has ${rows} of ${record.files} files`);
		}
		tx.objectStore(ARCHIVES).put(record);
		await committed(tx);
		this.#closed = true;
		this.#release();
		this.#record = record;
		return record;
	}

	/** Drops the buffered files and removes what this writer wrote. Safe to call after a failure. */
	async abort(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#batch = [];
		this.#batchBytes = 0;
		try {
			const tx = this.#db.transaction([FILES, ARCHIVES], 'readwrite');
			const current = await done<ArchiveRecord | undefined>(tx.objectStore(ARCHIVES).get(keyArray(this.#key)));
			if (current?.writer === this.#id) {
				tx.objectStore(FILES).delete(this.#range);
				tx.objectStore(ARCHIVES).delete(keyArray(this.#key));
			}
			await committed(tx);
		} finally {
			this.#release();
		}
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new ArchiveStoreError('The archive writer is closed');
		}
	}
}
