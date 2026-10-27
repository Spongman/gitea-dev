export type RepositoryErrorCode =
	| 'invalid-argument'
	| 'invalid-path'
	| 'invalid-change'
	| 'not-found'
	| 'not-a-directory'
	| 'is-a-directory'
	| 'empty-repository'
	| 'unauthenticated'
	| 'forbidden'
	| 'archived'
	| 'read-only'
	| 'file-too-large'
	| 'unsupported'
	| 'stale-head'
	| 'stale-blob'
	| 'already-exists'
	| 'branch-exists'
	| 'conflict'
	| 'rate-limited'
	| 'unavailable'
	| 'network'
	| 'aborted'
	| 'protocol'
	| 'not-initialized'
	| 'commit-outcome-unknown';

interface RepositoryErrorOptions {
	status?: number;
	/** Delay the server asked for before a retry, in milliseconds. */
	retryAfterMs?: number;
}

/** Base domain error. Messages never contain credentials or request headers. */
export class RepositoryError extends Error {
	readonly code: RepositoryErrorCode;
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(code: RepositoryErrorCode, message: string, options: RepositoryErrorOptions = {}) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
	}
}

export class StaleHeadError extends RepositoryError {
	readonly baseCommit: string;
	readonly headCommit: string;

	constructor(baseCommit: string, headCommit: string) {
		super('stale-head', `Branch head ${headCommit} differs from base commit ${baseCommit}`);
		this.baseCommit = baseCommit;
		this.headCommit = headCommit;
	}
}

export class StaleBlobError extends RepositoryError {
	/** Paths proven stale against the current head; empty when they could not be determined. */
	readonly paths: readonly string[];

	constructor(paths: readonly string[], status?: number) {
		super('stale-blob', 'A file changed on the server since the base commit', { status });
		this.paths = paths;
	}
}

export class AlreadyExistsError extends RepositoryError {
	readonly path: string | undefined;

	constructor(path: string | undefined, status?: number) {
		super('already-exists', path === undefined ? 'A path already exists' : `Path already exists: ${path}`, { status });
		this.path = path;
	}
}

export class FileTooLargeError extends RepositoryError {
	readonly size: number;
	readonly limit: number;

	constructor(path: string, size: number, limit: number) {
		super('file-too-large', `File ${path} is ${size} bytes, over the ${limit} byte limit`);
		this.size = size;
		this.limit = limit;
	}
}

/** The commit request failed after it may have reached the server. Refresh before retrying. */
export class CommitOutcomeUnknownError extends RepositoryError {
	constructor(status?: number) {
		super('commit-outcome-unknown', 'The commit may or may not have been applied; refresh and check the branch', { status });
	}
}

export function abortError(): RepositoryError {
	return new RepositoryError('aborted', 'The request was aborted');
}

export function isRepositoryError(error: unknown): error is RepositoryError {
	return error instanceof RepositoryError;
}
