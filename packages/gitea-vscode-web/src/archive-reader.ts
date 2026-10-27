/**
 * Repository decorator that serves file reads from the archive store once the archive of the
 * pinned commit is complete, and otherwise (or on any mismatch) reads blobs as before. It is
 * inert until `archive.attach()` is called, so short-lived probe repositories cost nothing.
 */
import { parseLfsPointer } from '../../gitea-repository/src/bytes.js';
import { RepositoryError } from '../../gitea-repository/src/errors.js';
import { DEFAULT_LIMITS, GiteaHttp } from '../../gitea-repository/src/http.js';
import { isHexId, normalizeInstance, validateName } from '../../gitea-repository/src/path.js';
import { DEFAULT_MAX_FILE_SIZE, HttpGiteaRepository } from '../../gitea-repository/src/repository.js';
import type {
	CommitResult,
	HttpGiteaRepositoryOptions,
	InitializableGiteaRepository,
	ReadFileOptions,
	RepositoryCommit,
	RepositoryEntry,
	RepositoryFile,
	RepositoryState,
	RequestOptions,
} from '../../gitea-repository/src/types.js';
import { ArchivePrefetcher, type ArchiveBackend, type ArchiveSettings } from './archive-prefetch.js';
import type { ArchiveStore } from './archive-store.js';

interface ArchiveRepositoryDeps {
	store: ArchiveStore;
	settings: () => ArchiveSettings;
	log?: (message: string) => void;
	/** Test seam for the wrapped repository. */
	createInner?: (options: HttpGiteaRepositoryOptions) => InitializableGiteaRepository;
}

export class ArchiveBackedRepository implements InitializableGiteaRepository {
	readonly archive: ArchivePrefetcher;
	readonly #inner: InitializableGiteaRepository;
	readonly #maxFileSize: number;

	constructor(options: HttpGiteaRepositoryOptions, deps: ArchiveRepositoryDeps) {
		this.#inner = deps.createInner?.(options) ?? new HttpGiteaRepository(options);
		this.#maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
		const instance = normalizeInstance(options.instance);
		const owner = validateName('owner', options.owner);
		const repository = validateName('repository', options.repository);
		const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
		const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
		const http = new GiteaHttp(`${instance}/api/v1`, fetchImpl, options.auth, { ...DEFAULT_LIMITS, ...options.limits });
		const backend: ArchiveBackend = {
			listTree: async (signal) => {
				if (this.#inner.readTree === undefined) {
					throw new RepositoryError('unsupported', 'The repository cannot list a tree recursively');
				}
				return this.#inner.readTree('', { signal });
			},
			openArchive: (commit, request) => {
				if (!isHexId(commit)) {
					throw new RepositoryError('invalid-argument', 'The archive needs a full commit id');
				}
				return http.stream({ path: `${repoPath}/archive/${commit}.tar.gz`, ...request });
			},
		};
		this.archive = new ArchivePrefetcher({
			instance,
			owner,
			repository,
			store: deps.store,
			backend,
			settings: deps.settings,
			log: deps.log,
		});
	}

	async initialize(options?: RequestOptions): Promise<RepositoryState> {
		const state = await this.#inner.initialize(options);
		this.archive.setCommit(state.commit);
		return state;
	}

	async refresh(commit?: string, options?: RequestOptions): Promise<void> {
		if (commit === undefined) {
			// Re-resolving the ref is initialize(); it reports the commit the archive must follow.
			this.archive.setCommit((await this.#inner.initialize(options)).commit);
			return;
		}
		await this.#inner.refresh(commit, options);
		this.archive.setCommit(commit);
	}

	getEntry(path: string, options?: RequestOptions): Promise<RepositoryEntry> {
		return this.#inner.getEntry(path, options);
	}

	readDirectory(path: string, options?: RequestOptions): Promise<RepositoryEntry[]> {
		return this.#inner.readDirectory(path, options);
	}

	readTree(path?: string, options?: RequestOptions): Promise<RepositoryEntry[]> {
		if (this.#inner.readTree === undefined) {
			return Promise.reject(new RepositoryError('unsupported', 'The repository cannot list a tree recursively'));
		}
		return this.#inner.readTree(path, options);
	}

	async readFile(path: string, options?: ReadFileOptions): Promise<RepositoryFile> {
		if (this.archive.state.kind === 'ready') {
			const entry = await this.#inner.getEntry(path, options);
			if (entry.type === 'file' && entry.size <= this.#maxFileSize) {
				const content = await this.archive.lookup(entry.path, entry);
				// The archive holds LFS pointers as stored; the inner repository resolves them.
				const pointer = content === undefined ? undefined : parseLfsPointer(content);
				if (content !== undefined && (pointer === undefined || options?.lfs === 'pointer')) {
					const file: RepositoryFile = { entry, content };
					if (pointer !== undefined) {
						file.lfs = { ...pointer, resolved: false };
					}
					return file;
				}
			}
		}
		return this.#inner.readFile(path, options);
	}

	commit(change: RepositoryCommit, options?: RequestOptions): Promise<CommitResult> {
		return this.#inner.commit(change, options);
	}

	dispose(): void {
		this.archive.dispose();
	}
}

export function createArchiveRepositoryFactory(deps: ArchiveRepositoryDeps): (options: HttpGiteaRepositoryOptions) => ArchiveBackedRepository {
	return (options) => new ArchiveBackedRepository(options, deps);
}
