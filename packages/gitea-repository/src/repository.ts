import { decodeBase64, encodeBase64, gitBlobSha, isLfsPointer, parseLfsPointer, sha256Hex } from './bytes.js';
import { BoundedCache } from './cache.js';
import {
	AlreadyExistsError,
	CommitOutcomeUnknownError,
	FileTooLargeError,
	RepositoryError,
	StaleBlobError,
	StaleHeadError,
	abortError,
	isRepositoryError,
} from './errors.js';
import { DEFAULT_LIMITS, GiteaHttp, type StatusMapper } from './http.js';
import { directoryRows, fetchTree, type DirectoryRow, type ListedEntry } from './recursive-tree.js';
import {
	encodePath,
	encodeRef,
	isHexId,
	joinPath,
	normalizeCommitPath,
	normalizeInstance,
	normalizePath,
	parseRef,
	validateName,
	type ParsedRef,
} from './path.js';
import type {
	AuthProvider,
	CommitResult,
	HttpGiteaRepositoryOptions,
	InitializableGiteaRepository,
	ReadFileOptions,
	RepositoryChange,
	RepositoryCommit,
	RepositoryEntry,
	RepositoryFile,
	RepositoryLimits,
	RepositoryState,
	RequestOptions,
} from './types.js';

export const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const TREE_PAGE_SIZE = 1000;
const MAX_TREE_PAGES = 1000;
const MAX_MESSAGE_LENGTH = 100_000;
const BLOB_JSON_OVERHEAD = 4096;
const RENAME_CONCURRENCY = 6;
const COMMIT_QUERY = { stat: 'false', verification: 'false', files: 'false' } as const;

interface PinnedState extends RepositoryState {
	rootTree: string;
}

interface Shared {
	promise: Promise<unknown>;
	controller: AbortController;
	waiters: number;
}

interface ApiRepository {
	empty?: boolean;
	archived?: boolean;
	mirror?: boolean;
	permissions?: { push?: boolean } | null;
}

interface ApiBranch {
	name?: string;
	commit?: { id?: string } | null;
	user_can_push?: boolean;
}

interface ApiCommit {
	sha?: string;
	commit?: { tree?: { sha?: string } | null } | null;
}

interface ApiBlob {
	content?: string | null;
	encoding?: string | null;
	size?: number;
}

function notFoundAs(message: string): StatusMapper {
	return (status) => (status === 400 || status === 404 || status === 422 ? new RepositoryError('not-found', message, { status }) : undefined);
}

/** Runs `run` over `items` with at most `limit` in flight; results keep item order and a failure stops new starts. */
async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (!failed && next < items.length) {
			const index = next++;
			try {
				results[index] = await run(items[index]);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export class HttpGiteaRepository implements InitializableGiteaRepository {
	readonly #http: GiteaHttp;
	readonly #repoPath: string;
	readonly #ref: ParsedRef;
	readonly #maxFileSize: number;
	readonly #limits: RepositoryLimits;
	/** Directory rows (`tree:`), recursive listings (`list:`) and blobs (`blob:`, `lfs:`) share one budget. */
	readonly #cache: BoundedCache<DirectoryRow[] | ListedEntry[] | Uint8Array>;
	readonly #inflight = new Map<string, Shared>();
	readonly #auth: AuthProvider | undefined;
	#state: PinnedState | undefined;

	constructor(options: HttpGiteaRepositoryOptions) {
		const instance = normalizeInstance(options.instance);
		const owner = validateName('owner', options.owner);
		const repository = validateName('repository', options.repository);
		this.#ref = parseRef(options.ref);
		this.#maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
		if (!Number.isSafeInteger(this.#maxFileSize) || this.#maxFileSize <= 0) {
			throw new RepositoryError('invalid-argument', 'maxFileSize must be a positive integer');
		}
		const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
		if (typeof fetchImpl !== 'function') {
			throw new RepositoryError('invalid-argument', 'No fetch implementation available');
		}
		this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.#auth = options.auth;
		this.#http = new GiteaHttp(`${instance}/api/v1`, fetchImpl, options.auth, this.#limits);
		this.#repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
		this.#cache = new BoundedCache(Math.max(this.#limits.cacheEntries, this.#limits.maxTreeEntries), this.#limits.cacheBytes);
	}

	/** Resolves the ref to a commit and permission hints; all reads pin to that commit. */
	async initialize(options: RequestOptions = {}): Promise<RepositoryState> {
		this.#state = await this.#resolve(undefined, options.signal);
		const { commit, branch, canWrite, canBranch } = this.#state;
		return { commit, branch, canWrite, canBranch };
	}

	/** Re-resolves the ref, or pins to a given full commit id (for example after a commit). */
	async refresh(commit?: string, options: RequestOptions = {}): Promise<void> {
		if (commit !== undefined && !isHexId(commit)) {
			throw new RepositoryError('invalid-argument', 'refresh requires a full lowercase commit id');
		}
		this.#state = await this.#resolve(commit, options.signal);
	}

	async getEntry(path: string, options: RequestOptions = {}): Promise<RepositoryEntry> {
		const state = this.#requireState();
		return { ...(await this.#lookup(state.rootTree, normalizePath(path), options.signal)) };
	}

	async readDirectory(path: string, options: RequestOptions = {}): Promise<RepositoryEntry[]> {
		const state = this.#requireState();
		const clean = normalizePath(path);
		const entry = await this.#lookup(state.rootTree, clean, options.signal);
		if (entry.type !== 'directory') {
			throw new RepositoryError('not-a-directory', `Not a directory: ${clean}`);
		}
		const rows = await this.#tree(entry.sha, options.signal);
		return rows.map((row) => ({ path: joinPath(clean, row.name), ...row }));
	}

	/** Recursive listing in one paged request chain; fills the directory cache for the whole subtree. */
	async readTree(path = '', options: RequestOptions = {}): Promise<RepositoryEntry[]> {
		const state = this.#requireState();
		const clean = normalizePath(path);
		const entry = await this.#lookup(state.rootTree, clean, options.signal);
		if (entry.type !== 'directory') {
			throw new RepositoryError('not-a-directory', `Not a directory: ${clean}`);
		}
		let listed = this.#cached<ListedEntry[]>(`list:${entry.sha}`);
		if (listed === undefined) {
			listed = await this.#shared(`rtree:${entry.sha}`, options.signal, async (signal) => {
				const entries = await fetchTree(this.#http, this.#repoPath, entry.sha, {
					recursive: true,
					pageSize: TREE_PAGE_SIZE,
					maxPages: MAX_TREE_PAGES,
					maxEntries: this.#limits.maxTreeEntries,
					signal,
					notFound: notFoundAs('Tree not found'),
				});
				for (const [sha, rows] of directoryRows(entry.sha, entries)) {
					this.#cache.set(`tree:${sha}`, rows, 64 * rows.length + 64);
				}
				this.#cache.set(`list:${entry.sha}`, entries, 96 * entries.length + 64);
				return entries;
			});
		}
		return listed.map((item) => ({
			path: joinPath(clean, item.path),
			name: item.path.slice(item.path.lastIndexOf('/') + 1),
			type: item.type,
			sha: item.sha,
			size: item.size,
		}));
	}

	async readFile(path: string, options: ReadFileOptions = {}): Promise<RepositoryFile> {
		const state = this.#requireState();
		const clean = normalizePath(path);
		const entry = await this.#lookup(state.rootTree, clean, options.signal);
		if (entry.type === 'directory') {
			throw new RepositoryError('is-a-directory', `Is a directory: ${clean}`);
		}
		if (entry.type === 'submodule') {
			throw new RepositoryError('unsupported', `Submodule ${clean} is at commit ${entry.sha}; its contents are not readable`);
		}
		if (entry.size > this.#maxFileSize) {
			throw new FileTooLargeError(clean, entry.size, this.#maxFileSize);
		}
		const content = await this.#blob({ sha: entry.sha, path: clean, ref: state.commit, size: entry.size }, options.signal);
		const file: RepositoryFile = { entry: { ...entry }, content: content.slice() };
		const pointer = entry.type === 'file' ? parseLfsPointer(content) : undefined;
		if (pointer !== undefined) {
			file.lfs = { ...pointer, resolved: false };
			if (options.lfs !== 'pointer') {
				const object = await this.#lfsObject(clean, state.commit, content, pointer, options.signal);
				if (object !== undefined) {
					file.content = object.slice();
					file.lfs.resolved = true;
				}
			}
		}
		return file;
	}

	async commit(change: RepositoryCommit, options: RequestOptions = {}): Promise<CommitResult> {
		const state = this.#requireState();
		const branch = state.branch;
		const newBranch = change.newBranch;
		if (branch === null) {
			throw new RepositoryError('read-only', 'Only a branch ref can be committed to');
		}
		if (newBranch === undefined ? !state.canWrite : !state.canBranch) {
			throw new RepositoryError('read-only', 'The repository, branch or user does not allow writes');
		}
		if (newBranch !== undefined && (parseRef(newBranch).kind !== 'any' || newBranch === branch)) {
			throw new RepositoryError('invalid-argument', 'newBranch must be a new branch name');
		}
		const { changes, bytes } = this.#validateChanges(change, state.commit.length);
		const signal = options.signal;

		const head = await this.#branchHead(branch, signal);
		if (newBranch === undefined && head.userCanPush === false) {
			throw new RepositoryError('read-only', 'The branch does not accept pushes from this user');
		}
		if (head.commit !== change.baseCommit) {
			throw new StaleHeadError(change.baseCommit, head.commit);
		}

		let total = bytes;
		const charge = (size: number) => this.#checkCommitBytes((total += size));
		const files = await mapLimit(changes, RENAME_CONCURRENCY, (item) => this.#toOperation(item, change.baseCommit, signal, charge));
		if (signal?.aborted) {
			throw abortError();
		}

		let response: { commit?: { sha?: unknown } | null };
		try {
			response = await this.#http.json({
				method: 'POST',
				path: `${this.#repoPath}/contents`,
				body: { branch, ...(newBranch === undefined ? {} : { new_branch: newBranch }), message: change.message.trim(), files },
				retry: false,
				signal,
			}, (status, message) => this.#commitStatusError(status, message, newBranch !== undefined));
		} catch (error) {
			if (error instanceof StaleBlobError) {
				throw new StaleBlobError(await this.#diagnoseStale(changes, signal), error.status);
			}
			if (isRepositoryError(error) && (error.code === 'network' || error.code === 'aborted' || error.code === 'unavailable')) {
				throw new CommitOutcomeUnknownError(error.status);
			}
			throw error;
		}
		const sha = response?.commit?.sha;
		if (typeof sha !== 'string' || !isHexId(sha)) {
			throw new CommitOutcomeUnknownError(201);
		}
		return { sha };
	}

	async logout(): Promise<void> {
		this.#state = undefined;
		this.#cache.clear();
		await this.#auth?.logout?.();
	}

	#requireState(): PinnedState {
		if (this.#state === undefined) {
			throw new RepositoryError('not-initialized', 'Call initialize() first');
		}
		return this.#state;
	}

	async #resolve(pinned: string | undefined, signal: AbortSignal | undefined): Promise<PinnedState> {
		const repo = await this.#http.json<ApiRepository>({ method: 'GET', path: this.#repoPath, retry: true, signal }, notFoundAs('Repository not found or not accessible'));
		if (repo.empty === true) {
			throw new RepositoryError('empty-repository', 'The repository has no commits');
		}
		const writable = repo.permissions?.push === true && repo.archived !== true && repo.mirror !== true;
		const { name, kind } = this.#ref;
		let commit: string | undefined;
		let branch: string | null = null;
		let userCanPush = false;

		if (kind !== 'tag') {
			const found = await this.#optionalJson<ApiBranch>(`${this.#repoPath}/branches/${encodeRef(name)}`, signal);
			if (found !== undefined) {
				const id = found.commit?.id;
				if (typeof id !== 'string' || !isHexId(id)) {
					throw new RepositoryError('protocol', 'Branch response has no commit id');
				}
				commit = id;
				branch = name;
				userCanPush = found.user_can_push === true;
			}
		}
		if (commit === undefined && kind !== 'branch') {
			const tag = await this.#optionalJson<{ commit?: { sha?: string } | null }>(`${this.#repoPath}/tags/${encodeRef(name)}`, signal);
			if (tag !== undefined) {
				commit = tag.commit?.sha;
			}
		}
		if (commit === undefined && kind === 'any' && /^[0-9a-f]{7,64}$/.test(name)) {
			commit = name;
		}
		if (commit === undefined) {
			throw new RepositoryError('not-found', `Ref not found: ${name}`);
		}

		const target = pinned ?? commit;
		const info = await this.#http.json<ApiCommit>(
			{ method: 'GET', path: `${this.#repoPath}/git/commits/${target}`, query: COMMIT_QUERY, retry: true, signal },
			notFoundAs('Commit not found'),
		);
		const sha = info.sha;
		const rootTree = info.commit?.tree?.sha;
		if (typeof sha !== 'string' || !isHexId(sha) || typeof rootTree !== 'string' || !isHexId(rootTree)) {
			throw new RepositoryError('protocol', 'Commit response is missing ids');
		}
		return { commit: sha, branch, canWrite: branch !== null && writable && userCanPush, canBranch: branch !== null && writable, rootTree };
	}

	async #optionalJson<T>(path: string, signal: AbortSignal | undefined): Promise<T | undefined> {
		try {
			return await this.#http.json<T>({ method: 'GET', path, retry: true, signal });
		} catch (error) {
			if (isRepositoryError(error) && error.code === 'not-found' && error.status === 404) {
				return undefined;
			}
			throw error;
		}
	}

	async #branchHead(branch: string, signal: AbortSignal | undefined): Promise<{ commit: string; userCanPush: boolean | undefined }> {
		const found = await this.#http.json<ApiBranch>({ method: 'GET', path: `${this.#repoPath}/branches/${encodeRef(branch)}`, retry: true, signal });
		const id = found.commit?.id;
		if (typeof id !== 'string' || !isHexId(id)) {
			throw new RepositoryError('protocol', 'Branch response has no commit id');
		}
		return { commit: id, userCanPush: found.user_can_push };
	}

	async #lookup(rootTree: string, path: string, signal: AbortSignal | undefined): Promise<RepositoryEntry> {
		if (path === '') {
			return { path: '', name: '', type: 'directory', sha: rootTree, size: 0 };
		}
		const segments = path.split('/');
		let treeSha = rootTree;
		let current = '';
		for (let i = 0; i < segments.length; i++) {
			const rows = await this.#tree(treeSha, signal);
			const row = rows.find((candidate) => candidate.name === segments[i]);
			current = joinPath(current, segments[i]);
			if (row === undefined) {
				throw new RepositoryError('not-found', `Not found: ${path}`);
			}
			if (i === segments.length - 1) {
				return { path: current, ...row };
			}
			if (row.type !== 'directory') {
				throw new RepositoryError('not-a-directory', `Not a directory: ${current}`);
			}
			treeSha = row.sha;
		}
		throw new RepositoryError('not-found', `Not found: ${path}`);
	}

	#cached<T extends DirectoryRow[] | ListedEntry[] | Uint8Array>(key: string): T | undefined {
		return this.#cache.get(key) as T | undefined;
	}

	#tree(sha: string, signal: AbortSignal | undefined): Promise<DirectoryRow[]> {
		const cached = this.#cached<DirectoryRow[]>(`tree:${sha}`);
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}
		return this.#shared(`tree:${sha}`, signal, async (shared) => {
			const entries = await fetchTree(this.#http, this.#repoPath, sha, {
				recursive: false,
				pageSize: TREE_PAGE_SIZE,
				maxPages: MAX_TREE_PAGES,
				maxEntries: this.#limits.maxDirectoryEntries,
				signal: shared,
				notFound: notFoundAs('Tree not found'),
			});
			const rows = entries.map((entry) => ({ name: entry.path, type: entry.type, sha: entry.sha, size: entry.size }));
			this.#cache.set(`tree:${sha}`, rows, 64 * rows.length + 64);
			return rows;
		});
	}

	#blob(source: { sha: string; path: string; ref: string; size?: number }, signal: AbortSignal | undefined): Promise<Uint8Array> {
		const cached = this.#cached<Uint8Array>(`blob:${source.sha}`);
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}
		return this.#shared(`blob:${source.sha}`, signal, async (shared) => {
			const content = await this.#fetchBlob(source, shared);
			this.#cache.set(`blob:${source.sha}`, content, content.length + 64);
			return content;
		});
	}

	async #fetchBlob(source: { sha: string; path: string; ref: string; size?: number }, signal: AbortSignal): Promise<Uint8Array> {
		const maxBytes = Math.ceil((this.#maxFileSize * 4) / 3) + BLOB_JSON_OVERHEAD;
		const blobStatus: StatusMapper = (status, message) => {
			if (status === 400 || status === 404) {
				return new RepositoryError('not-found', `Blob not found: ${message}`, { status });
			}
			return undefined;
		};
		let blob: ApiBlob;
		try {
			blob = await this.#http.json<ApiBlob>({ method: 'GET', path: `${this.#repoPath}/git/blobs/${source.sha}`, retry: true, signal, maxBytes }, blobStatus);
		} catch (error) {
			if (isRepositoryError(error) && error.code === 'file-too-large') {
				throw new FileTooLargeError(source.path, source.size ?? this.#maxFileSize + 1, this.#maxFileSize);
			}
			throw error;
		}
		if (typeof blob.size !== 'number') {
			throw new RepositoryError('protocol', 'Blob response has no size');
		}
		if (blob.size > this.#maxFileSize) {
			throw new FileTooLargeError(source.path, blob.size, this.#maxFileSize);
		}
		if (typeof blob.content === 'string' && blob.encoding === 'base64') {
			const content = decodeBase64(blob.content);
			if (content.length !== blob.size) {
				throw new RepositoryError('protocol', 'Blob size does not match its content');
			}
			return content;
		}
		if (blob.content !== null && blob.content !== undefined) {
			throw new RepositoryError('protocol', 'Unsupported blob encoding');
		}
		return this.#fetchRaw(source, blob.size, signal);
	}

	/** Gitea omits blob content above its API limit; the raw endpoint is addressed by commit and path, so the result is hash-checked. */
	async #fetchRaw(source: { sha: string; path: string; ref: string }, size: number, signal: AbortSignal): Promise<Uint8Array> {
		const content = await this.#http.bytes(
			{ method: 'GET', path: `${this.#repoPath}/raw/${encodePath(source.path)}`, query: { ref: source.ref }, retry: true, signal, maxBytes: this.#maxFileSize },
			notFoundAs('Raw file not found'),
		);
		if (content.length !== size || (await gitBlobSha(content, source.sha.length)) !== source.sha) {
			throw new RepositoryError('protocol', `Raw content for ${source.path} does not match its blob id`);
		}
		return content;
	}

	/**
	 * The object a Git LFS pointer names, from Gitea's media endpoint, checked against the
	 * pointer's size and SHA-256. Undefined when the server answers with the pointer itself,
	 * which is what it does when LFS is disabled or the object was never uploaded.
	 */
	#lfsObject(path: string, ref: string, pointerBytes: Uint8Array, pointer: { oid: string; size: number }, signal: AbortSignal | undefined): Promise<Uint8Array | undefined> {
		if (pointer.size > this.#maxFileSize) {
			throw new FileTooLargeError(path, pointer.size, this.#maxFileSize);
		}
		const key = `lfs:${pointer.oid}`;
		const cached = this.#cached<Uint8Array>(key);
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}
		return this.#shared(key, signal, async (shared) => {
			let content: Uint8Array;
			try {
				content = await this.#http.bytes(
					{ method: 'GET', path: `${this.#repoPath}/media/${encodePath(path)}`, query: { ref }, retry: true, signal: shared, maxBytes: Math.max(pointer.size, pointerBytes.length) },
					notFoundAs('LFS file not found'),
				);
			} catch (error) {
				if (isRepositoryError(error) && error.code === 'file-too-large') {
					throw new RepositoryError('protocol', `LFS object for ${path} is larger than its pointer says`);
				}
				throw error;
			}
			if (content.length === pointerBytes.length && content.every((byte, i) => byte === pointerBytes[i])) {
				return undefined;
			}
			if (content.length !== pointer.size || (await sha256Hex(content)) !== pointer.oid) {
				throw new RepositoryError('protocol', `LFS object for ${path} does not match its pointer`);
			}
			this.#cache.set(key, content, content.length + 64);
			return content;
		});
	}

	#shared<T>(key: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (signal?.aborted) {
			return Promise.reject(abortError());
		}
		let entry = this.#inflight.get(key);
		if (entry === undefined || entry.controller.signal.aborted) {
			const controller = new AbortController();
			const created: Shared = { promise: Promise.resolve(), controller, waiters: 0 };
			created.promise = run(controller.signal).finally(() => {
				if (this.#inflight.get(key) === created) {
					this.#inflight.delete(key);
				}
			});
			this.#inflight.set(key, created);
			entry = created;
		}
		const shared = entry;
		shared.waiters++;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				shared.waiters--;
				if (shared.waiters === 0) {
					shared.controller.abort();
				}
				reject(abortError());
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			(shared.promise as Promise<T>).then(
				(value) => {
					signal?.removeEventListener('abort', onAbort);
					resolve(value);
				},
				(error: unknown) => {
					signal?.removeEventListener('abort', onAbort);
					reject(error);
				},
			);
		});
	}

	#checkCommitBytes(total: number): void {
		if (total > this.#limits.maxCommitBytes) {
			throw new RepositoryError('invalid-change', `A commit may carry at most ${this.#limits.maxCommitBytes} bytes of content, rename sources included`);
		}
	}

	/** Checks each change and the content size the caller supplies; rename sources are counted as they are read. */
	#validateChanges(change: RepositoryCommit, hexLength: number): { changes: RepositoryChange[]; bytes: number } {
		const message = typeof change?.message === 'string' ? change.message.trim() : '';
		if (message === '' || message.length > MAX_MESSAGE_LENGTH) {
			throw new RepositoryError('invalid-change', 'A commit message is required');
		}
		if (typeof change.baseCommit !== 'string' || !isHexId(change.baseCommit, hexLength)) {
			throw new RepositoryError('invalid-change', 'baseCommit must be a full lowercase commit id');
		}
		if (!Array.isArray(change.changes) || change.changes.length === 0 || change.changes.length > this.#limits.maxCommitChanges) {
			throw new RepositoryError('invalid-change', `A commit needs between 1 and ${this.#limits.maxCommitChanges} changes`);
		}
		const touched = new Set<string>();
		const touch = (path: string) => {
			if (touched.has(path)) {
				throw new RepositoryError('invalid-change', `Path appears in more than one change: ${path}`);
			}
			touched.add(path);
		};
		let bytes = 0;
		const changes = change.changes.map((item) => {
			const path = normalizeCommitPath(item.path);
			const previousPath = item.previousPath === undefined ? undefined : normalizeCommitPath(item.previousPath);
			const invalid = (reason: string) => new RepositoryError('invalid-change', `${reason}: ${path}`);
			if (item.type !== 'create' && item.type !== 'update' && item.type !== 'delete') {
				throw invalid('Unknown change type');
			}
			if (item.type !== 'delete' && item.content !== undefined) {
				if (!(item.content instanceof Uint8Array)) {
					throw invalid('content must be a Uint8Array');
				}
				if (item.content.length > this.#maxFileSize) {
					throw new FileTooLargeError(path, item.content.length, this.#maxFileSize);
				}
				bytes += item.content.length;
				if (isLfsPointer(item.content)) {
					throw new RepositoryError('unsupported', `Content of ${path} is a Git LFS pointer; the server would re-wrap it`);
				}
			}
			if (item.type === 'create') {
				if (item.content === undefined || item.originalSha !== undefined || previousPath !== undefined) {
					throw invalid('A create needs content and no originalSha or previousPath');
				}
			} else {
				if (typeof item.originalSha !== 'string' || !isHexId(item.originalSha, hexLength)) {
					throw invalid('originalSha is required for update and delete');
				}
				if (item.type === 'delete' && (item.content !== undefined || previousPath !== undefined)) {
					throw invalid('A delete takes only originalSha');
				}
				if (item.type === 'update' && item.content === undefined && previousPath === undefined) {
					throw invalid('An update needs content unless it renames');
				}
			}
			if (previousPath === path) {
				throw invalid('previousPath equals path');
			}
			touch(path);
			if (previousPath !== undefined) {
				touch(previousPath);
			}
			return { ...item, path, previousPath };
		});
		this.#checkCommitBytes(bytes);
		return { changes, bytes };
	}

	async #toOperation(item: RepositoryChange, baseCommit: string, signal: AbortSignal | undefined, charge: (size: number) => void): Promise<Record<string, string>> {
		if (item.type === 'delete') {
			return { operation: 'delete', path: item.path, sha: item.originalSha as string };
		}
		let content = item.content;
		if (content === undefined) {
			const from = item.previousPath as string;
			content = await this.#blob({ sha: item.originalSha as string, path: from, ref: baseCommit }, signal);
			if (isLfsPointer(content)) {
				throw new RepositoryError('unsupported', `Cannot rename LFS pointer ${from}; the server would re-wrap it`);
			}
			charge(content.length);
		}
		if (item.type === 'create') {
			return { operation: 'create', path: item.path, content: encodeBase64(content) };
		}
		const operation: Record<string, string> = { operation: 'update', path: item.path, content: encodeBase64(content), sha: item.originalSha as string };
		if (item.previousPath !== undefined) {
			operation.from_path = item.previousPath;
		}
		return operation;
	}

	#commitStatusError(status: number, message: string, newBranch: boolean): RepositoryError | undefined {
		if (status === 422) {
			if (newBranch && /branch already exists/i.test(message)) {
				return new RepositoryError('branch-exists', 'A branch with that name already exists', { status });
			}
			if (/sha does not match/i.test(message)) {
				return new StaleBlobError([], status);
			}
			if (/already exists/i.test(message)) {
				return new AlreadyExistsError(/\[path: (.+)\]/.exec(message)?.[1], status);
			}
			return new RepositoryError('invalid-change', `Commit rejected: ${message}`, { status });
		}
		return undefined;
	}

	/** Finds which updated or deleted files no longer match their base blob at the current head. */
	async #diagnoseStale(changes: RepositoryChange[], signal: AbortSignal | undefined): Promise<string[]> {
		try {
			const branch = this.#state?.branch;
			if (branch === null || branch === undefined) {
				return [];
			}
			const head = await this.#branchHead(branch, signal);
			const info = await this.#http.json<ApiCommit>({ method: 'GET', path: `${this.#repoPath}/git/commits/${head.commit}`, query: COMMIT_QUERY, retry: true, signal });
			const rootTree = info.commit?.tree?.sha;
			if (typeof rootTree !== 'string') {
				return [];
			}
			const stale: string[] = [];
			for (const item of changes) {
				if (item.type === 'create') {
					continue;
				}
				const checked = item.previousPath ?? item.path;
				const current = await this.#lookup(rootTree, checked, signal).catch(() => undefined);
				if (current === undefined || current.sha !== item.originalSha) {
					stale.push(checked);
				}
			}
			return stale;
		} catch {
			return [];
		}
	}
}
