import { RepositoryError } from './errors.js';
import type { GiteaHttp, StatusMapper } from './http.js';
import { isHexId } from './path.js';
import type { EntryType } from './types.js';

/** One entry of a recursive listing; `path` is relative to the listed tree. */
export interface ListedEntry {
	path: string;
	type: EntryType;
	sha: string;
	size: number;
}

export interface DirectoryRow {
	name: string;
	type: EntryType;
	sha: string;
	size: number;
}

interface ApiTreePage {
	tree?: Array<{ path?: unknown; mode?: unknown; type?: unknown; size?: unknown; sha?: unknown }> | null;
	total_count?: unknown;
}

function entryType(mode: string, type: string, path: string): EntryType {
	if (mode === '040000' || type === 'tree') {
		return 'directory';
	}
	if (mode === '160000' || type === 'commit') {
		return 'submodule';
	}
	if (mode === '120000') {
		return 'symlink';
	}
	if (type === 'blob') {
		return 'file';
	}
	throw new RepositoryError('protocol', `Unsupported tree entry type for ${JSON.stringify(path)}`);
}

function toListed(raw: NonNullable<ApiTreePage['tree']>[number]): ListedEntry {
	const { path, mode, type, size, sha } = raw;
	if (typeof path !== 'string' || typeof mode !== 'string' || typeof type !== 'string' || typeof sha !== 'string' || !isHexId(sha)) {
		throw new RepositoryError('protocol', 'Malformed tree entry');
	}
	if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new RepositoryError('protocol', 'Malformed tree entry path');
	}
	const kind = entryType(mode, type, path);
	const bytes = kind === 'directory' || kind === 'submodule' ? 0 : size;
	if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
		throw new RepositoryError('protocol', 'Malformed tree entry size');
	}
	return { path, type: kind, sha, size: bytes };
}

interface TreeOptions {
	/** True lists every entry below the tree with relative paths; false lists the one directory. */
	recursive: boolean;
	pageSize: number;
	maxPages: number;
	maxEntries: number;
	signal: AbortSignal | undefined;
	notFound: StatusMapper;
}

/** Reads `git/trees/{sha}`, with `recursive=true` when asked, page by page until total_count entries are in. */
export async function fetchTree(http: GiteaHttp, repoPath: string, sha: string, options: TreeOptions): Promise<ListedEntry[]> {
	const out: ListedEntry[] = [];
	let total = Number.POSITIVE_INFINITY;
	for (let page = 1; out.length < total; page++) {
		if (page > options.maxPages) {
			throw new RepositoryError('protocol', 'Tree has too many pages');
		}
		const response = await http.json<ApiTreePage>(
			{
				method: 'GET',
				path: `${repoPath}/git/trees/${sha}`,
				query: options.recursive ? { recursive: 'true', page, per_page: options.pageSize } : { page, per_page: options.pageSize },
				retry: true,
				signal: options.signal,
			},
			options.notFound,
		);
		const entries = response.tree ?? [];
		if (!Array.isArray(entries) || typeof response.total_count !== 'number' || !Number.isSafeInteger(response.total_count) || response.total_count < 0) {
			throw new RepositoryError('protocol', 'Malformed tree response');
		}
		total = response.total_count;
		if (total > options.maxEntries) {
			throw new RepositoryError('file-too-large', `${options.recursive ? 'Tree' : 'Directory'} has ${total} entries, over the ${options.maxEntries} limit`);
		}
		if (entries.length === 0 && out.length < total) {
			throw new RepositoryError('protocol', 'Tree page was empty');
		}
		for (const entry of entries) {
			const listed = toListed(entry);
			if (!options.recursive && listed.path.includes('/')) {
				throw new RepositoryError('protocol', 'Malformed tree entry path');
			}
			out.push(listed);
		}
		if (out.length > total) {
			throw new RepositoryError('protocol', 'Tree has more entries than total_count');
		}
	}
	return out;
}

/**
 * Splits a recursive listing into per-directory rows keyed by tree sha, in listing order.
 * Throws when a path has no listed parent directory, so partial listings never fill a cache.
 */
export function directoryRows(rootSha: string, entries: readonly ListedEntry[]): Map<string, DirectoryRow[]> {
	const shaOf = new Map<string, string>([['', rootSha]]);
	for (const entry of entries) {
		if (entry.type === 'directory') {
			shaOf.set(entry.path, entry.sha);
		}
	}
	const byPath = new Map<string, DirectoryRow[]>();
	for (const path of shaOf.keys()) {
		byPath.set(path, []);
	}
	for (const entry of entries) {
		const slash = entry.path.lastIndexOf('/');
		const rows = byPath.get(slash < 0 ? '' : entry.path.slice(0, slash));
		if (rows === undefined) {
			throw new RepositoryError('protocol', `Tree entry has no parent directory: ${JSON.stringify(entry.path)}`);
		}
		rows.push({ name: entry.path.slice(slash + 1), type: entry.type, sha: entry.sha, size: entry.size });
	}
	const out = new Map<string, DirectoryRow[]>();
	for (const [path, rows] of byPath) {
		out.set(shaOf.get(path) as string, rows);
	}
	return out;
}
