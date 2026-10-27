export type EntryType = 'file' | 'directory' | 'symlink' | 'submodule';

export interface RepositoryEntry {
	/** Repository-relative path without leading or trailing slash; '' is the root. */
	path: string;
	name: string;
	type: EntryType;
	/** Git object id (blob, tree or submodule commit). */
	sha: string;
	/** Blob size in bytes; 0 for directories and submodules. */
	size: number;
}

/** A file stored in Git LFS: the blob in the tree is a pointer to an object held by the server. */
export interface LfsInfo {
	/** SHA-256 of the object, from the pointer. */
	oid: string;
	/** Object size in bytes, from the pointer. */
	size: number;
	/**
	 * True when `content` is the verified LFS object. False when it is the pointer text: the
	 * pointer was requested, or the server has LFS disabled or does not hold the object.
	 */
	resolved: boolean;
}

export interface RepositoryFile {
	entry: RepositoryEntry;
	content: Uint8Array;
	/** Present only when the blob is a Git LFS pointer. */
	lfs?: LfsInfo;
}

export interface ReadFileOptions extends RequestOptions {
	/**
	 * 'resolve' (default) replaces a Git LFS pointer by the object it names, read from Gitea's
	 * media endpoint. 'pointer' returns the pointer as stored and never fetches the object.
	 */
	lfs?: 'resolve' | 'pointer';
}

export interface RepositoryChange {
	path: string;
	type: 'create' | 'update' | 'delete';
	/** Required for create. For update, omitted only when renaming unchanged content. */
	content?: Uint8Array;
	/** Blob sha at the base commit. Required for update and delete. */
	originalSha?: string;
	/** With type 'update', renames previousPath to path. */
	previousPath?: string;
}

export interface RepositoryCommit {
	message: string;
	baseCommit: string;
	/** Commits onto a new branch cut from the opened branch; skips that branch's protection. */
	newBranch?: string;
	changes: RepositoryChange[];
}

export interface CommitResult {
	sha: string;
}

export interface RequestOptions {
	signal?: AbortSignal;
}

export interface GiteaRepository {
	getEntry(path: string, options?: RequestOptions): Promise<RepositoryEntry>;
	readDirectory(path: string, options?: RequestOptions): Promise<RepositoryEntry[]>;
	/** A symlink reads as its target path text and a submodule is not readable; neither is followed. */
	readFile(path: string, options?: ReadFileOptions): Promise<RepositoryFile>;
	/**
	 * Every entry below a directory at any depth (directories, files, symlinks, submodules),
	 * in tree order with repository-relative paths. Fills the directory cache, so later
	 * readDirectory calls below the path need no request.
	 */
	readTree?(path?: string, options?: RequestOptions): Promise<RepositoryEntry[]>;
	commit(change: RepositoryCommit, options?: RequestOptions): Promise<CommitResult>;
}

export interface RepositoryState {
	/** Full commit id all reads are pinned to. */
	commit: string;
	/** Branch name when the ref is a branch, otherwise null. */
	branch: string | null;
	canWrite: boolean;
	/** Whether a branch can be created from this one: write access to the repository, even if this branch is protected. */
	canBranch: boolean;
}

export interface InitializableGiteaRepository extends GiteaRepository {
	initialize(options?: RequestOptions): Promise<RepositoryState>;
	refresh(commit?: string, options?: RequestOptions): Promise<void>;
}

export interface AuthProvider {
	headers(): Promise<Record<string, string>>;
	logout?(): Promise<void>;
	/** Fetch credentials mode; defaults to 'omit' so cookies are never sent implicitly. */
	readonly credentials?: 'omit' | 'same-origin' | 'include';
}

export interface RepositoryLimits {
	/** Per-attempt timeout for the response head, and the longest gap between body chunks. */
	timeoutMs: number;
	/** Extra attempts for safe reads. */
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	/** One cache budget, in bytes, shared by decoded blobs, trees and recursive listings. */
	cacheBytes: number;
	/** Max cached items; raised to maxTreeEntries so one recursive listing always fits. */
	cacheEntries: number;
	/** Max directory entries accepted from one tree. */
	maxDirectoryEntries: number;
	/** Max entries accepted from one recursive tree listing. */
	maxTreeEntries: number;
	/** Max changes per commit. */
	maxCommitChanges: number;
	/** Max accepted JSON response size excluding file payloads. */
	maxJsonBytes: number;
	/** Max total content bytes in one commit, rename sources included. */
	maxCommitBytes: number;
}

export interface HttpGiteaRepositoryOptions {
	/** Gitea origin plus sub-path, e.g. https://host/gitea. */
	instance: string;
	owner: string;
	repository: string;
	/** Branch, tag or commit; refs/heads/ and refs/tags/ prefixes force the kind. */
	ref: string;
	auth?: AuthProvider;
	fetch?: typeof fetch;
	/** Largest file read or written, in bytes. Default 26214400. */
	maxFileSize?: number;
	limits?: Partial<RepositoryLimits>;
}
