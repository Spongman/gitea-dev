import {
	GiteaRefs,
	HttpGiteaRepository,
	type AuthProvider,
	type GiteaRefsOptions,
	type HttpGiteaRepositoryOptions,
	type InitializableGiteaRepository,
	type RefInfo,
	type RepositoryState,
} from '../../gitea-repository/src/index.js';
import { repositoryRef, type Descriptor } from './descriptor.js';
import { ChangeOverlay, OverlayError, type Conflict, type OverlayChannel } from './overlay.js';
import type { OverlayStorage } from './storage.js';

export type RepositoryFactory = (options: HttpGiteaRepositoryOptions) => InitializableGiteaRepository;

export type RefsApi = Pick<
	GiteaRefs,
	'listBranches' | 'listTagRefs' | 'createBranch' | 'branchHead' | 'defaultBranch' | 'compare' | 'createPullRequest'
>;

export type RefsFactory = (options: GiteaRefsOptions) => RefsApi;

interface SessionDeps {
	storage: OverlayStorage;
	auth: AuthProvider;
	createRepository?: RepositoryFactory;
	createRefs?: RefsFactory;
	/** Keeps tabs with the same repository ref in step. */
	channel?: OverlayChannel;
}

type ResolvedDeps = SessionDeps & Required<Pick<SessionDeps, 'createRepository' | 'createRefs'>>;

export interface CommitOptions {
	/** Commit only these pending changes (by change path); default all. */
	paths?: readonly string[];
	/** Commit to a new branch cut from the opened branch, which stays untouched. */
	newBranch?: string;
}

interface CommitSummary {
	sha: string;
	changes: number;
	/** Branch that received the commit. */
	branch: string;
}

/** One opened repository ref: pinned reads, local overlay, and the commit/refresh flows. */
export class Session {
	readonly descriptor: Descriptor;
	readonly repository: InitializableGiteaRepository;
	readonly refs: RefsApi;
	readonly overlay: ChangeOverlay;
	#state: RepositoryState;
	readonly #deps: ResolvedDeps;
	/** Serializes refresh, commit and branch creation, which all move or read the base. */
	#tail: Promise<unknown> = Promise.resolve();

	private constructor(
		descriptor: Descriptor,
		repository: InitializableGiteaRepository,
		refs: RefsApi,
		overlay: ChangeOverlay,
		state: RepositoryState,
		deps: ResolvedDeps,
	) {
		this.descriptor = descriptor;
		this.repository = repository;
		this.refs = refs;
		this.overlay = overlay;
		this.#state = state;
		this.#deps = deps;
	}

	static async open(descriptor: Descriptor, deps: SessionDeps): Promise<Session> {
		const resolved: ResolvedDeps = {
			...deps,
			createRepository: deps.createRepository ?? ((options) => new HttpGiteaRepository(options)),
			createRefs: deps.createRefs ?? ((options) => new GiteaRefs(options)),
		};
		const repository = Session.#create(resolved, descriptor, repositoryRef(descriptor));
		const state = await repository.initialize();
		const overlay = await ChangeOverlay.open({
			key: {
				instance: descriptor.instance,
				owner: descriptor.owner,
				repository: descriptor.repository,
				ref: repositoryRef(descriptor),
				baseCommit: state.commit,
			},
			storage: deps.storage,
			base: repository,
			moveReader: (commit) => repository.refresh(commit),
			channel: deps.channel,
		});
		const { instance, owner, repository: name } = descriptor;
		const refs = resolved.createRefs({ instance, owner, repository: name, auth: deps.auth });
		return new Session(descriptor, repository, refs, overlay, state, resolved);
	}

	static #create(deps: ResolvedDeps, descriptor: Descriptor, ref: string): InitializableGiteaRepository {
		return deps.createRepository({
			instance: descriptor.instance,
			owner: descriptor.owner,
			repository: descriptor.repository,
			ref,
			auth: deps.auth,
		});
	}

	get state(): RepositoryState {
		return this.#state;
	}

	get baseCommit(): string {
		return this.overlay.baseCommit;
	}

	get readonlyHint(): boolean {
		return this.descriptor.mode === 'readonly';
	}

	/** Fresh view of the branch head and permissions; does not move this session. */
	async probe(): Promise<{ state: RepositoryState; repository: InitializableGiteaRepository }> {
		const repository = Session.#create(this.#deps, this.descriptor, repositoryRef(this.descriptor));
		const state = await repository.initialize();
		this.#state = { ...state, commit: this.#state.commit };
		return { state, repository };
	}

	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(fn);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Moves to the current branch head, keeping pending changes and flagging conflicts. */
	refresh(): Promise<{ baseCommit: string; moved: boolean; conflicts: Conflict[] }> {
		return this.#exclusive(async () => {
			const { state, repository } = await this.probe();
			const moved = state.commit !== this.overlay.baseCommit;
			if (moved) {
				await this.overlay.rebase(state.commit);
				this.#state = state;
			}
			const conflicts = this.overlay.size > 0 ? await this.overlay.detectConflicts(repository) : [];
			return { baseCommit: this.overlay.baseCommit, moved, conflicts };
		});
	}

	/** Remote head of the opened branch; undefined for tags and commits or a deleted branch. */
	async remoteHead(): Promise<string | undefined> {
		const { branch } = this.#state;
		return branch === null ? undefined : this.refs.branchHead(branch);
	}

	/** Commits the remote head has beyond this session's base; undefined when unknown or too many to count. */
	async countIncoming(head: string): Promise<number | undefined> {
		return (await this.refs.compare(this.baseCommit, head)).ahead;
	}

	/**
	 * Cuts a branch at the base commit, moves pending changes onto it, then calls `open`;
	 * when that fails, the changes move back.
	 */
	createBranch(name: string, open?: (created: RefInfo) => Promise<void>): Promise<RefInfo> {
		return this.#exclusive(async () => {
			if (this.readonlyHint) throw new OverlayError('ReadOnly', 'This editor was opened read-only.');
			const created = await this.refs.createBranch(name, this.baseCommit);
			const ref = repositoryRef({ ...this.descriptor, ref: created.name, refKind: 'branch' });
			await this.overlay.transferTo(ref);
			try {
				await open?.(created);
			} catch (error) {
				await this.overlay.transferFrom(ref);
				throw error;
			}
			return created;
		});
	}

	/**
	 * One atomic commit of the pending changes (all, or `paths`). Local changes survive any
	 * failure. A protected branch rejects with code 'Protected'; retry with `newBranch`.
	 */
	commit(message: string, options: CommitOptions = {}): Promise<CommitSummary> {
		return this.#exclusive(() => this.#commit(message, options));
	}

	async #commit(message: string, options: CommitOptions): Promise<CommitSummary> {
		const trimmed = message.trim();
		const { paths, newBranch } = options;
		if (trimmed === '') throw new OverlayError('Invalid', 'A commit message is required.');
		if (this.readonlyHint) throw new OverlayError('ReadOnly', 'This editor was opened read-only.');
		const { state, repository } = await this.probe();
		if (state.branch === null) throw new OverlayError('ReadOnly', 'Only a branch can be committed to.');
		if (newBranch === undefined && !state.canWrite) {
			if (state.canBranch) throw new OverlayError('Protected', `${state.branch} does not accept direct commits from you.`);
			throw new OverlayError('ReadOnly', 'You do not have write access to this branch.');
		}
		if (newBranch !== undefined && !state.canBranch) {
			throw new OverlayError('ReadOnly', 'You do not have write access to this repository.');
		}
		const result = await this.overlay.commit({
			head: repository,
			headCommit: state.commit,
			paths,
			submit: async (request) => {
				const { sha } = await repository.commit({ message: trimmed, ...request, newBranch });
				// A new branch leaves the opened branch where it was.
				return { sha, base: newBranch === undefined ? sha : state.commit };
			},
		});
		this.#state = { ...state, commit: this.overlay.baseCommit };
		return { sha: result.sha, changes: result.changes, branch: newBranch ?? state.branch };
	}
}
