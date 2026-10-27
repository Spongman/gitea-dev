/**
 * Downloads the `.tar.gz` archive of one commit into the archive store and serves verified
 * file bytes from it. Owned by a session: the run is aborted when the base commit changes or
 * the session is disposed, never by a search being cancelled.
 */
import { gitBlobSha } from '../../gitea-repository/src/bytes.js';
import { isRepositoryError } from '../../gitea-repository/src/errors.js';
import { TarError, parseTar } from '../../gitea-repository/src/tar.js';
import type { RepositoryEntry } from '../../gitea-repository/src/types.js';
import { ArchiveStoreError, type ArchiveKey, type ArchiveStore, type ArchiveWriter, type StoredArchiveFile } from './archive-store.js';

const MIB = 1024 * 1024;

export interface ArchiveSettings {
	/** When to start downloading; a complete cached archive is used in every mode but 'off'. */
	prefetch: 'onOpen' | 'onSearch' | 'off';
	/** Sum of file sizes above which the archive is not fetched. */
	maxRepositoryBytes: number;
	/** Files above which the archive is not fetched. */
	maxEntries: number;
	/** Larger files are left to blob reads. */
	maxFileBytes: number;
	/** Compressed download cap. */
	maxDownloadBytes: number;
	/** Longest gap between body chunks. */
	idleTimeoutMs: number;
	/** Wait for the server to build the archive and start sending. */
	startTimeoutMs: number;
	/** Store budget across archives. */
	cacheBytes: number;
}

export const DEFAULT_ARCHIVE_SETTINGS: ArchiveSettings = {
	prefetch: 'onSearch',
	maxRepositoryBytes: 128 * MIB,
	maxEntries: 50_000,
	maxFileBytes: 25 * MIB,
	maxDownloadBytes: 128 * MIB,
	idleTimeoutMs: 30_000,
	startTimeoutMs: 120_000,
	cacheBytes: 512 * MIB,
};

export type ArchiveState =
	| { kind: 'idle' }
	| { kind: 'checking' }
	| { kind: 'downloading'; bytes: number; total: number }
	| { kind: 'ready'; files: number; bytes: number; source: 'download' | 'cache' }
	| { kind: 'unsupported'; reason: string }
	| { kind: 'failed'; reason: string }
	| { kind: 'disabled' };

export interface ArchiveBackend {
	/** Recursive listing of the pinned commit, with blob shas and sizes. */
	listTree(signal: AbortSignal): Promise<RepositoryEntry[]>;
	openArchive(
		commit: string,
		options: { signal: AbortSignal; maxBytes: number; startTimeoutMs: number; idleTimeoutMs: number },
	): Promise<ReadableStream<Uint8Array>>;
}

interface ArchivePrefetcherOptions {
	instance: string;
	owner: string;
	repository: string;
	store: ArchiveStore;
	backend: ArchiveBackend;
	settings: () => ArchiveSettings;
	log?: (message: string) => void;
	decompress?: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
	/** Minimum wait before an unsupported or failed archive is tried again. */
	retryAfterMs?: number;
	now?: () => number;
}

function mib(bytes: number): number {
	return Math.round((bytes / MIB) * 10) / 10;
}

function describe(error: unknown): string {
	if (error instanceof ArchiveStoreError) {
		return error.message;
	}
	if (error instanceof TarError) {
		return `The archive is invalid: ${error.message}`;
	}
	if (isRepositoryError(error)) {
		return error.status === undefined ? error.message : `${error.message} (HTTP ${error.status})`;
	}
	return 'The archive could not be fetched';
}

/** Warning for text search results that cannot come from the archive; undefined when none is needed. */
export function archiveSearchNotice(state: ArchiveState): string | undefined {
	switch (state.kind) {
		case 'ready':
		case 'disabled':
			return undefined;
		case 'unsupported':
		case 'failed':
			return `Archive prefetch is unavailable (${state.reason}); files are searched one at a time, which is slower.`;
		default:
			return 'The repository archive is still downloading; files are searched one at a time, which is slower. Search again when it finishes.';
	}
}

const defaultDecompress = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
	body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);

export class ArchivePrefetcher {
	readonly #options: ArchivePrefetcherOptions;
	readonly #listeners = new Set<(state: ArchiveState) => void>();
	readonly #verified = new Set<string>();
	#commit: string | undefined;
	#state: ArchiveState = { kind: 'idle' };
	#controller: AbortController | undefined;
	#running: Promise<void> = Promise.resolve();
	#generation = 0;
	#attached = false;
	/** A scan asked for the archive since the last commit change. */
	#wanted = false;
	#ready: ArchiveKey | undefined;
	#lastAttempt = 0;
	#disposed = false;
	#mismatchLogged = false;
	/** Lookups issued in one tick share a read transaction. */
	#queue: { key: ArchiveKey; path: string; resolve: (row: StoredArchiveFile | undefined) => void }[] = [];

	constructor(options: ArchivePrefetcherOptions) {
		this.#options = options;
	}

	get state(): ArchiveState {
		return this.#state;
	}

	get commit(): string | undefined {
		return this.#commit;
	}

	onDidChange(listener: (state: ArchiveState) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Resolves when the current run, if any, has ended. */
	settled(): Promise<void> {
		return this.#running;
	}

	/** Begins managing the archive; picks up a complete stored archive and, in 'onOpen' mode, downloads one. */
	async attach(): Promise<void> {
		this.#attached = true;
		await this.#begin(false);
	}

	/** Called when a scan wants the archive; starts a download unless one is running or prefetch is off. */
	ensure(): void {
		if (!this.#attached || this.#disposed) {
			return;
		}
		const kind = this.#state.kind;
		const retry = kind === 'failed' || kind === 'unsupported';
		if (kind === 'idle' || kind === 'disabled' || (retry && this.#now() - this.#lastAttempt >= (this.#options.retryAfterMs ?? 30_000))) {
			void this.#begin(true);
		}
	}

	/** Moves to another base commit: aborts the current run and drops the old archive from use. */
	setCommit(commit: string | undefined): void {
		if (commit === this.#commit) {
			return;
		}
		this.#commit = commit;
		this.#reset();
		if (this.#attached && !this.#disposed && commit !== undefined) {
			void this.#begin(false);
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#reset();
		this.#set({ kind: 'disabled' });
		this.#listeners.clear();
	}

	/**
	 * File bytes from the archive when it is complete and the stored blob matches the tree
	 * entry (sha and size) and hashes to that sha; undefined means "read the blob instead".
	 * Every IndexedDB read returns its own copy, so callers may modify the result.
	 */
	async lookup(path: string, entry: RepositoryEntry): Promise<Uint8Array | undefined> {
		const key = this.#ready;
		if (key === undefined || entry.type !== 'file' || entry.size > this.#options.settings().maxFileBytes) {
			return undefined;
		}
		const stored = await this.#read(key, path);
		if (stored === undefined || stored.sha !== entry.sha || stored.size !== entry.size || stored.content.length !== entry.size) {
			return undefined;
		}
		// A row rewritten by another writer has another writer id and is hashed again.
		const id = `${path}\0${entry.sha}\0${stored.writer ?? ''}`;
		if (!this.#verified.has(id)) {
			if ((await gitBlobSha(stored.content, entry.sha.length)) !== entry.sha) {
				if (!this.#mismatchLogged) {
					this.#mismatchLogged = true;
					this.#options.log?.(`archive: stored bytes of ${path} do not match the tree sha; reading the blob instead`);
				}
				return undefined;
			}
			this.#verified.add(id);
		}
		return stored.content;
	}

	#read(key: ArchiveKey, path: string): Promise<StoredArchiveFile | undefined> {
		return new Promise((resolve) => {
			this.#queue.push({ key, path, resolve });
			if (this.#queue.length === 1) {
				queueMicrotask(() => void this.#drain());
			}
		});
	}

	async #drain(): Promise<void> {
		const queue = this.#queue;
		this.#queue = [];
		const store = this.#options.store;
		const commits = new Set(queue.map((item) => item.key.commit));
		for (const commit of commits) {
			const group = queue.filter((item) => item.key.commit === commit);
			const rows = await store.getFiles(group[0].key, group.map((item) => item.path)).catch(() => undefined);
			group.forEach((item, index) => item.resolve(rows?.[index]));
		}
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	#reset(): void {
		this.#generation++;
		this.#controller?.abort();
		this.#controller = undefined;
		this.#ready = undefined;
		this.#wanted = false;
		this.#verified.clear();
		this.#set({ kind: 'idle' });
	}

	#set(state: ArchiveState): void {
		this.#state = state;
		for (const listener of [...this.#listeners]) {
			try {
				listener(state);
			} catch {
				// A failing listener must not break the run.
			}
		}
	}

	#begin(download: boolean): Promise<void> {
		const commit = this.#commit;
		if (download) {
			this.#wanted = true;
		}
		if (commit === undefined || this.#disposed || this.#controller !== undefined) {
			return this.#running;
		}
		const generation = this.#generation;
		const controller = new AbortController();
		this.#controller = controller;
		this.#lastAttempt = this.#now();
		const run = this.#execute(commit, generation, controller.signal).finally(() => {
			if (this.#controller === controller) {
				this.#controller = undefined;
			}
		});
		this.#running = run;
		return run;
	}

	async #execute(commit: string, generation: number, signal: AbortSignal): Promise<void> {
		const live = () => generation === this.#generation && !signal.aborted;
		const set = (state: ArchiveState) => {
			if (live()) {
				this.#set(state);
			}
		};
		const { store, backend, log } = this.#options;
		const key: ArchiveKey = { instance: this.#options.instance, owner: this.#options.owner, repository: this.#options.repository, commit };
		let writer: ArchiveWriter | undefined;
		try {
			const settings = this.#options.settings();
			if (settings.prefetch === 'off') {
				set({ kind: 'disabled' });
				return;
			}
			const cached = await store.getArchive(key);
			if (cached?.complete === true) {
				if ((await store.countFiles(key)) >= cached.files) {
					if (live()) {
						this.#ready = key;
						set({ kind: 'ready', files: cached.files, bytes: cached.bytes, source: 'cache' });
						await store.touch(key).catch(() => undefined);
						log?.(`archive: using stored archive for ${commit} (${cached.files} files)`);
					}
					return;
				}
				log?.(`archive: stored archive for ${commit} is missing files; discarding it`);
				await store.delete(key);
			}
			if (!this.#wanted && settings.prefetch !== 'onOpen') {
				return;
			}
			if (this.#options.decompress === undefined && typeof DecompressionStream === 'undefined') {
				set({ kind: 'unsupported', reason: 'this browser has no DecompressionStream' });
				return;
			}
			set({ kind: 'checking' });
			const entries = await backend.listTree(signal);
			const files = entries.filter((entry) => entry.type === 'file');
			const total = files.reduce((sum, entry) => sum + entry.size, 0);
			const limit = Math.min(settings.maxRepositoryBytes, settings.cacheBytes);
			if (files.length > settings.maxEntries) {
				set({ kind: 'unsupported', reason: `the repository has ${files.length} files, over the ${settings.maxEntries} file limit` });
				return;
			}
			if (total > limit) {
				set({ kind: 'unsupported', reason: `the repository is ${mib(total)} MiB, over the ${mib(limit)} MiB limit` });
				return;
			}
			const expected = new Map<string, { sha: string; size: number }>();
			for (const entry of files) {
				expected.set(entry.path, { sha: entry.sha, size: entry.size });
			}

			// Make room first, so the old and new archives never exceed the budget together.
			await store.evict(Math.max(0, settings.cacheBytes - total), key).catch((error: unknown) => log?.(`archive: eviction failed: ${describe(error)}`));
			set({ kind: 'downloading', bytes: 0, total });
			log?.(`archive: downloading ${commit} (${files.length} files, ${mib(total)} MiB)`);
			writer = await store.begin(key);
			const body = await backend.openArchive(commit, {
				signal,
				maxBytes: settings.maxDownloadBytes,
				startTimeoutMs: settings.startTimeoutMs,
				idleTimeoutMs: settings.idleTimeoutMs,
			});
			const decompress = this.#options.decompress ?? defaultDecompress;
			const tar = parseTar(decompress(body), {
				maxEntries: entries.length + 16,
				maxEntryBytes: settings.maxFileBytes,
				maxTotalBytes: total + Math.max(Math.floor(total / 4), MIB),
			});
			let prefix: string | undefined;
			let processed = 0;
			let stored = 0;
			let reported = 0;
			for await (const entry of tar) {
				if (!live()) {
					return;
				}
				const parts = entry.path.split('/');
				if (prefix === undefined && parts.length > 1) {
					prefix = parts[0];
				}
				processed += entry.size;
				if (entry.type === 'file' && entry.content !== undefined && parts[0] === prefix && parts.length > 1) {
					const path = parts.slice(1).join('/');
					const want = expected.get(path);
					if (want !== undefined && want.size === entry.content.length) {
						await writer.put(path, want.sha, entry.content);
						stored++;
					}
				}
				const now = this.#now();
				if (now - reported >= 200) {
					reported = now;
					set({ kind: 'downloading', bytes: processed, total });
				}
			}
			if (!live()) {
				await writer.abort();
				return;
			}
			const record = await writer.complete();
			await store.evict(settings.cacheBytes, key);
			if (live()) {
				this.#ready = key;
				set({ kind: 'ready', files: record.files, bytes: record.bytes, source: 'download' });
				log?.(`archive: ready ${commit} (${stored} of ${files.length} files stored)`);
			}
		} catch (error) {
			await writer?.abort().catch(() => undefined);
			if (live()) {
				const reason = describe(error);
				log?.(`archive: ${reason}`);
				set({ kind: 'failed', reason });
			}
		} finally {
			if (!live()) {
				await writer?.abort().catch(() => undefined);
			}
		}
	}
}

/** Builds settings from `gitea.archive.*` values; missing or invalid values keep the defaults. */
export function readArchiveSettings(config: { get<T>(section: string): T | undefined }): ArchiveSettings {
	const d = DEFAULT_ARCHIVE_SETTINGS;
	const positive = (key: string, fallback: number, scale: number): number => {
		const value = config.get<number>(key);
		return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value * scale) : fallback;
	};
	const prefetch = config.get<string>('prefetch');
	return {
		prefetch: prefetch === 'onOpen' || prefetch === 'onSearch' || prefetch === 'off' ? prefetch : d.prefetch,
		maxRepositoryBytes: positive('maxRepositoryMiB', d.maxRepositoryBytes, MIB),
		maxEntries: positive('maxFiles', d.maxEntries, 1),
		maxFileBytes: positive('maxFileMiB', d.maxFileBytes, MIB),
		maxDownloadBytes: positive('maxDownloadMiB', d.maxDownloadBytes, MIB),
		idleTimeoutMs: positive('idleTimeoutSeconds', d.idleTimeoutMs, 1000),
		startTimeoutMs: positive('startTimeoutSeconds', d.startTimeoutMs, 1000),
		cacheBytes: positive('cacheMiB', d.cacheBytes, MIB),
	};
}
