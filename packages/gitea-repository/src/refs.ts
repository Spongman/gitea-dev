import { RepositoryError, isRepositoryError } from './errors.js';
import { DEFAULT_LIMITS, GiteaHttp } from './http.js';
import { encodeRef, isHexId, normalizeInstance, parseRef, validateName } from './path.js';
import type { AuthProvider, RepositoryLimits, RequestOptions } from './types.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
/** The compare endpoint is unpaged; a response over this size is reported as "too many to count". */
const COMPARE_MAX_BYTES = 1024 * 1024;

export interface RefInfo {
	name: string;
	/** Full commit id the ref points at. */
	commit: string;
}

export interface BranchList {
	branches: RefInfo[];
	/** True when the page cap stopped the listing. */
	truncated: boolean;
}

export interface PullRequestInput {
	/** Branch name, or `owner:branch` for a fork. */
	head: string;
	base: string;
	title: string;
	body?: string;
}

export interface PullRequestResult {
	number: number;
	url: string;
}

export interface RemoteComparison {
	/** Commits on the head that the base lacks; undefined when the response was over the size cap. */
	ahead: number | undefined;
}

export interface GiteaRefsOptions {
	instance: string;
	owner: string;
	repository: string;
	auth?: AuthProvider;
	fetch?: typeof fetch;
	limits?: Partial<RepositoryLimits>;
}

interface ApiRef {
	name?: unknown;
	commit?: { id?: unknown; sha?: unknown } | null;
}

function toRef(item: ApiRef): RefInfo {
	const commit = item.commit?.id ?? item.commit?.sha;
	if (typeof item.name !== 'string' || typeof commit !== 'string' || !isHexId(commit)) {
		throw new RepositoryError('protocol', 'Malformed ref entry');
	}
	return { name: item.name, commit };
}

/** Name of a branch that is acceptable to create; throws an invalid-argument error otherwise. */
export function validateBranchName(name: string): string {
	const parsed = parseRef(name);
	if (parsed.kind !== 'any') {
		throw new RepositoryError('invalid-argument', 'Branch names must not start with refs/');
	}
	return parsed.name;
}

/** Ref listing, branch creation, remote comparison and pull requests for one repository. */
export class GiteaRefs {
	readonly #http: GiteaHttp;
	readonly #repoPath: string;

	constructor(options: GiteaRefsOptions) {
		const instance = normalizeInstance(options.instance);
		const owner = validateName('owner', options.owner);
		const repository = validateName('repository', options.repository);
		const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
		if (typeof fetchImpl !== 'function') {
			throw new RepositoryError('invalid-argument', 'No fetch implementation available');
		}
		this.#http = new GiteaHttp(`${instance}/api/v1`, fetchImpl, options.auth, { ...DEFAULT_LIMITS, ...options.limits });
		this.#repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
	}

	listBranches(options: RequestOptions = {}): Promise<BranchList> {
		return this.#list('branches', options);
	}

	/** Like listBranches, for tags: the refs are in `branches`. */
	listTagRefs(options: RequestOptions = {}): Promise<BranchList> {
		return this.#list('tags', options);
	}

	/** Cuts a branch from a branch, tag or full commit id. */
	async createBranch(name: string, from: string, options: RequestOptions = {}): Promise<RefInfo> {
		const created = await this.#http.json<ApiRef>(
			{
				method: 'POST',
				path: `${this.#repoPath}/branches`,
				body: { new_branch_name: validateBranchName(name), old_ref_name: from },
				retry: false,
				signal: options.signal,
			},
			(status, message) => {
				if (status === 409) {
					return new RepositoryError('branch-exists', 'A branch or tag with that name already exists', { status });
				}
				if (status === 404) {
					return new RepositoryError('not-found', `Source ref not found${message === '' ? '' : `: ${message}`}`, { status });
				}
				return undefined;
			},
		);
		return toRef(created);
	}

	/** Current head commit of a branch, or undefined when the branch no longer exists. */
	async branchHead(branch: string, options: RequestOptions = {}): Promise<string | undefined> {
		try {
			const found = await this.#http.json<ApiRef>({
				method: 'GET',
				path: `${this.#repoPath}/branches/${encodeRef(parseRef(branch).name)}`,
				retry: true,
				signal: options.signal,
			});
			return toRef(found).commit;
		} catch (error) {
			if (isRepositoryError(error) && error.code === 'not-found') {
				return undefined;
			}
			throw error;
		}
	}

	async defaultBranch(options: RequestOptions = {}): Promise<string> {
		const repo = await this.#http.json<{ default_branch?: unknown }>({ method: 'GET', path: this.#repoPath, retry: true, signal: options.signal });
		if (typeof repo.default_branch !== 'string' || repo.default_branch === '') {
			throw new RepositoryError('protocol', 'Repository response has no default branch');
		}
		return repo.default_branch;
	}

	/** Counts the commits `head` has beyond `base`; one unpaged request, so the response size is capped. A missing base counts as unknown. */
	async compare(base: string, head: string, options: RequestOptions = {}): Promise<RemoteComparison> {
		try {
			const result = await this.#http.json<{ total_commits?: unknown }>({
				method: 'GET',
				path: `${this.#repoPath}/compare/${encodeRef(parseRef(base).name)}...${encodeRef(parseRef(head).name)}`,
				query: { verification: 'false', files: 'false' },
				retry: true,
				signal: options.signal,
				maxBytes: COMPARE_MAX_BYTES,
			});
			if (typeof result.total_commits !== 'number') {
				throw new RepositoryError('protocol', 'Compare response has no commit count');
			}
			return { ahead: result.total_commits };
		} catch (error) {
			if (isRepositoryError(error) && (error.code === 'file-too-large' || error.code === 'not-found')) {
				return { ahead: undefined };
			}
			throw error;
		}
	}

	/**
	 * 409 means a pull request for these branches is already open and 422 that head and base
	 * match or have no changes; both keep their status on the thrown error.
	 */
	async createPullRequest(input: PullRequestInput, options: RequestOptions = {}): Promise<PullRequestResult> {
		const created = await this.#http.json<{ number?: unknown; html_url?: unknown }>({
			method: 'POST',
			path: `${this.#repoPath}/pulls`,
			body: { head: input.head, base: input.base, title: input.title, body: input.body ?? '' },
			retry: false,
			signal: options.signal,
		});
		if (typeof created.number !== 'number' || typeof created.html_url !== 'string') {
			throw new RepositoryError('protocol', 'Pull request response is incomplete');
		}
		return { number: created.number, url: created.html_url };
	}

	async #list(kind: 'branches' | 'tags', options: RequestOptions): Promise<BranchList> {
		const branches: RefInfo[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const items = await this.#http.json<ApiRef[]>({
				method: 'GET',
				path: `${this.#repoPath}/${kind}`,
				query: { page, limit: PAGE_SIZE },
				retry: true,
				signal: options.signal,
			});
			if (!Array.isArray(items)) {
				throw new RepositoryError('protocol', 'Malformed ref list');
			}
			if (items.length === 0) {
				return { branches, truncated: false };
			}
			branches.push(...items.map(toRef));
		}
		return { branches, truncated: true };
	}
}
