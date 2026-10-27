import { RepositoryError } from './errors.js';

const MAX_PATH_LENGTH = 4096;
const MAX_COMMIT_PATH_LENGTH = 500;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const REF_FORBIDDEN = /[\u0000- \u007f~^:?*[\\]/;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

function hasControl(value: string): boolean {
	return /[\u0000-\u001f\u007f]/.test(value);
}

function isWellFormed(value: string): boolean {
	const check = (value as { isWellFormed?: () => boolean }).isWellFormed;
	if (typeof check === 'function') {
		return check.call(value);
	}
	return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

/** Validates and canonicalizes a repository path. '' and '/' are the root. */
export function normalizePath(input: string): string {
	if (typeof input !== 'string') {
		throw new RepositoryError('invalid-path', 'Path must be a string');
	}
	if (input === '' || input === '/') {
		return '';
	}
	const path = input.startsWith('/') ? input.slice(1) : input;
	if (path.length > MAX_PATH_LENGTH) {
		throw new RepositoryError('invalid-path', 'Path is too long');
	}
	if (!isWellFormed(path) || hasControl(path)) {
		throw new RepositoryError('invalid-path', 'Path contains invalid characters');
	}
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.' || segment === '..') {
			throw new RepositoryError('invalid-path', `Path has an empty or relative segment: ${JSON.stringify(input)}`);
		}
		if (segment.toLowerCase() === '.git') {
			throw new RepositoryError('invalid-path', 'Path contains a .git component');
		}
	}
	return path;
}

/** Stricter check for paths sent in commits; Gitea rejects paths over 500 characters. */
export function normalizeCommitPath(input: string): string {
	const path = normalizePath(input);
	if (path === '') {
		throw new RepositoryError('invalid-path', 'The root cannot be changed');
	}
	if ([...path].length > MAX_COMMIT_PATH_LENGTH) {
		throw new RepositoryError('invalid-path', `Path is over ${MAX_COMMIT_PATH_LENGTH} characters`);
	}
	return path;
}

export function joinPath(parent: string, name: string): string {
	return parent === '' ? name : `${parent}/${name}`;
}

/** Encodes each ref segment; '.', '..' and empty segments could address other API routes. */
export function encodeRef(name: string): string {
	return name
		.split('/')
		.map((segment) => {
			if (segment === '' || segment === '.' || segment === '..') {
				throw new RepositoryError('invalid-argument', 'Invalid ref');
			}
			return encodeURIComponent(segment);
		})
		.join('/');
}

/** Encodes each segment independently; separators stay as real slashes. */
export function encodePath(path: string): string {
	try {
		return path.split('/').map(encodeURIComponent).join('/');
	} catch {
		throw new RepositoryError('invalid-path', 'Path contains invalid characters');
	}
}

export function validateName(kind: 'owner' | 'repository', value: string): string {
	if (typeof value !== 'string' || !NAME_PATTERN.test(value) || value === '.' || value === '..') {
		throw new RepositoryError('invalid-argument', `Invalid ${kind} name`);
	}
	return value;
}

export interface ParsedRef {
	name: string;
	kind: 'branch' | 'tag' | 'any';
}

/** Applies git-check-ref-format rules; Unicode is allowed. */
export function parseRef(input: string): ParsedRef {
	if (typeof input !== 'string' || input === '' || input.length > 255 || !isWellFormed(input)) {
		throw new RepositoryError('invalid-argument', 'Invalid ref');
	}
	let name = input;
	let kind: ParsedRef['kind'] = 'any';
	if (name.startsWith('refs/heads/')) {
		kind = 'branch';
		name = name.slice('refs/heads/'.length);
	} else if (name.startsWith('refs/tags/')) {
		kind = 'tag';
		name = name.slice('refs/tags/'.length);
	}
	const bad =
		name === '' ||
		name === '@' ||
		REF_FORBIDDEN.test(name) ||
		name.includes('..') ||
		name.includes('@{') ||
		name.startsWith('/') ||
		name.endsWith('/') ||
		name.endsWith('.') ||
		name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'));
	if (bad) {
		throw new RepositoryError('invalid-argument', 'Invalid ref');
	}
	return { name, kind };
}

export function isHexId(value: string, length?: number): boolean {
	return length === undefined ? /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value) : value.length === length && /^[0-9a-f]+$/.test(value);
}

/** Normalizes and validates the instance URL; credentials, query and fragment are rejected, and plain http is allowed on loopback only. */
export function normalizeInstance(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new RepositoryError('invalid-argument', 'Instance must be an absolute http(s) URL');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new RepositoryError('invalid-argument', 'Instance must be an http(s) URL');
	}
	if (url.protocol === 'http:' && !LOOPBACK_HOST.test(url.hostname)) {
		throw new RepositoryError('invalid-argument', 'Instance must be https, or http on a loopback host');
	}
	if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
		throw new RepositoryError('invalid-argument', 'Instance URL must not contain credentials, a query or a fragment');
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
