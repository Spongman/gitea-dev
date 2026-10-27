/** Pure search engine over an overlay-like source. No vscode, Node or Buffer use. */
import { isLfsPointer } from '../../gitea-repository/src/bytes.js';

export interface SearchSource {
	readDirectory(path: string): Promise<{ name: string; type: string }[]>;
	/** With `lfs: 'pointer'` a Git LFS file reads as its pointer, so searching never downloads LFS objects. */
	readFile(path: string, options?: { lfs?: 'pointer' }): Promise<Uint8Array>;
	stat(path: string): Promise<{ size: number }>;
}

export interface SearchLimits {
	maxFiles: number;
	maxBytes: number;
	/** Regular expression queries skip lines longer than this (single-line mode). */
	maxLineChars: number;
	/** Scanning one file stops after this long; checked between regular expression runs. */
	maxFileMs: number;
}

export const DEFAULT_LIMITS: SearchLimits = { maxFiles: 10_000, maxBytes: 50 * 1024 * 1024, maxLineChars: 10_000, maxFileMs: 2_000 };

/** File names are listed without reading content, so Quick Open can cover far more files than text search. */
const DEFAULT_FILE_SEARCH_MAX_FILES = 100_000;

export interface TextQuery {
	pattern: string;
	isRegExp?: boolean;
	isCaseSensitive?: boolean;
	isWordMatch?: boolean;
	isMultiline?: boolean;
}

interface EnginePosition {
	line: number;
	character: number;
}

export interface EngineRange {
	start: EnginePosition;
	end: EnginePosition;
}

export interface EngineMatch {
	kind: 'match';
	/** Path relative to the search root, '/' separated. */
	path: string;
	ranges: EngineRange[];
	preview: { text: string; matches: EngineRange[] };
}

interface EngineContext {
	kind: 'context';
	path: string;
	text: string;
	/** 0-based. */
	lineNumber: number;
}

export type EngineResult = EngineMatch | EngineContext;

interface Filters {
	includes?: string[];
	excludes?: string[];
}

interface WalkOptions extends Filters {
	/** Source path of the search root; '' is the repository root. */
	root: string;
	maxFiles: number;
	isCancelled: () => boolean;
	yieldToHost?: () => Promise<void>;
}

export interface WalkSummary {
	files: number;
	/** More matching files exist than maxFiles. */
	filesTruncated: boolean;
	/** Directories that could not be listed and were skipped. */
	unlistable: number;
	cancelled: boolean;
}

export interface TextSearchEngineOptions extends Filters {
	query: TextQuery;
	root: string;
	maxResults: number;
	maxFileSize?: number;
	previewOptions?: { matchLines: number; charsPerLine: number };
	encoding?: string;
	beforeContext?: number;
	afterContext?: number;
	limits?: Partial<SearchLimits>;
	isCancelled: () => boolean;
	onResult: (result: EngineResult) => void;
	yieldToHost?: () => Promise<void>;
	/** Clock for the per-file time limit. */
	now?: () => number;
}

interface TextSearchSummary {
	limitHit: boolean;
	filesScanned: number;
	bytesScanned: number;
	cancelled: boolean;
	/** Human-readable warnings for incomplete results. */
	warnings: string[];
}

// Glob matching

const GLOB_CACHE_LIMIT = 256;
const MAX_ALTERNATIVES = 256;

interface CompiledGlob {
	regex: RegExp | undefined;
	/** Literal leading directories per alternative; '' means the alternative can match at any depth. */
	prefixes: string[];
}

const GLOB_CACHE = new Map<string, CompiledGlob>();

/** Expands {a,b}; throws when the glob has more than MAX_ALTERNATIVES alternatives. */
function expandBraces(glob: string, budget = { left: MAX_ALTERNATIVES }): string[] {
	const open = glob.indexOf('{');
	if (open >= 0) {
		let depth = 0;
		const parts: string[] = [];
		let start = open + 1;
		for (let i = open; i < glob.length; i++) {
			const c = glob[i];
			if (c === '{') depth++;
			else if (c === '}') {
				depth--;
				if (depth === 0) {
					parts.push(glob.slice(start, i));
					const prefix = glob.slice(0, open);
					const suffix = glob.slice(i + 1);
					return parts.flatMap((part) => expandBraces(prefix + part + suffix, budget));
				}
			} else if (c === ',' && depth === 1) {
				parts.push(glob.slice(start, i));
				start = i + 1;
			}
		}
	}
	if (--budget.left < 0) throw new Error('too many glob alternatives');
	return [glob];
}

function globToSource(glob: string): string {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				while (glob[i + 1] === '*') i++;
				if (glob[i + 1] === '/') {
					i++;
					out += '(?:[^/]+/)*';
				} else {
					out += '.*';
				}
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else if (c === '[') {
			const close = glob.indexOf(']', i + 2);
			if (close < 0) {
				out += '\\[';
			} else {
				let body = glob.slice(i + 1, close);
				const negate = body[0] === '!' || body[0] === '^';
				if (negate) body = body.slice(1);
				out += `[${negate ? '^' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`;
				i = close;
			}
		} else {
			out += c.replace(/[.+^${}()|\\/]/g, '\\$&');
		}
	}
	return out;
}

function prefixOf(anchored: string): string {
	if (anchored.startsWith('**')) return '';
	const literal: string[] = [];
	for (const segment of anchored.split('/')) {
		if (/[*?[]/.test(segment)) break;
		literal.push(segment);
	}
	return literal.join('/');
}

function compile(glob: string): CompiledGlob {
	const cached = GLOB_CACHE.get(glob);
	if (cached !== undefined) return cached;
	let compiled: CompiledGlob;
	try {
		const anchored = expandBraces(glob.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')).map((g) =>
			g.includes('/') || g.startsWith('**') ? g : `**/${g}`,
		);
		compiled = { regex: new RegExp(`^(?:${anchored.map(globToSource).join('|')})$`, 's'), prefixes: anchored.map(prefixOf) };
	} catch {
		compiled = { regex: undefined, prefixes: [] };
	}
	if (GLOB_CACHE.size >= GLOB_CACHE_LIMIT) GLOB_CACHE.delete(GLOB_CACHE.keys().next().value as string);
	GLOB_CACHE.set(glob, compiled);
	return compiled;
}

/** Compiles a VS Code style glob; patterns without '/' match at any depth. Undefined when invalid. */
export function compileGlob(glob: string): RegExp | undefined {
	return compile(glob).regex;
}

/** A path matches a glob when it or any ancestor directory does. */
function matchesGlob(regex: RegExp, path: string): boolean {
	if (regex.test(path)) return true;
	for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
		if (regex.test(path.slice(0, i))) return true;
	}
	return false;
}

interface PathFilter {
	/** True when a directory (and everything below) is excluded. */
	excludes(path: string): boolean;
	includes(path: string): boolean;
	/** True when nothing below the directory can pass the filters, so it need not be listed. */
	prunes(directory: string): boolean;
}

function createPathFilter(filters: Filters): PathFilter {
	const compileAll = (globs: string[] | undefined) =>
		(globs ?? []).map((g) => g.trim()).filter((g) => g !== '').map(compile).filter((c) => c.regex !== undefined);
	const excludes = compileAll(filters.excludes).map((c) => c.regex as RegExp);
	const includeGlobs = compileAll(filters.includes);
	const includes = includeGlobs.map((c) => c.regex as RegExp);
	const prefixes = includeGlobs.flatMap((c) => c.prefixes);
	const reachable = (dir: string) =>
		prefixes.length === 0 || prefixes.some((p) => p === '' || dir === p || dir.startsWith(`${p}/`) || p.startsWith(`${dir}/`));
	return {
		excludes: (path) => excludes.some((r) => matchesGlob(r, path)),
		includes: (path) => includes.length === 0 || includes.some((r) => matchesGlob(r, path)),
		// A glob such as `dir/**` matches `dir/`, which excludes every path below `dir`.
		prunes: (dir) => excludes.some((r) => r.test(`${dir}/`)) || !reachable(dir),
	};
}

// Walking

function joinPath(dir: string, name: string): string {
	if (dir === '') return name;
	return name === '' ? dir : `${dir}/${name}`;
}

const yieldMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createYielder(yieldToHost: () => Promise<void> = yieldMacrotask, intervalMs = 20) {
	let last = Date.now();
	return async () => {
		const now = Date.now();
		if (now - last < intervalMs) return;
		await yieldToHost();
		last = Date.now();
	};
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Depth-first walk in name order. Symlinks and submodules are ignored (links are not followed, so no file is visited twice). `visit` receives the
 * path relative to the root and the source path; returning false stops the walk.
 */
export async function walkFiles(
	source: Pick<SearchSource, 'readDirectory'>,
	options: WalkOptions,
	visit: (relative: string, sourcePath: string) => Promise<boolean | void>,
): Promise<WalkSummary> {
	const filter = createPathFilter(options);
	const maybeYield = createYielder(options.yieldToHost);
	const summary: WalkSummary = { files: 0, filesTruncated: false, unlistable: 0, cancelled: false };
	let stopped = false;

	const walk = async (relativeDir: string): Promise<void> => {
		let entries;
		try {
			entries = (await source.readDirectory(joinPath(options.root, relativeDir))).slice().sort(byName);
		} catch (error) {
			// The root must be listable; a directory that vanished or cannot be listed is skipped and counted.
			if (relativeDir === '') throw error;
			summary.unlistable++;
			return;
		}
		for (const entry of entries) {
			if (stopped) return;
			if (options.isCancelled()) {
				summary.cancelled = true;
				stopped = true;
				return;
			}
			await maybeYield();
			const relative = joinPath(relativeDir, entry.name);
			if (filter.excludes(relative)) continue;
			if (entry.type === 'directory') {
				if (filter.prunes(relative)) continue;
				await walk(relative);
			} else if (entry.type === 'file') {
				if (!filter.includes(relative)) continue;
				if (summary.files >= options.maxFiles) {
					summary.filesTruncated = true;
					stopped = true;
					return;
				}
				summary.files++;
				if ((await visit(relative, joinPath(options.root, relative))) === false) {
					stopped = true;
					return;
				}
			}
		}
	};
	await walk('');
	return summary;
}

// File search

function isBoundary(target: string, index: number): boolean {
	if (index === 0) return true;
	const prev = target[index - 1];
	if ('/-_. '.includes(prev)) return true;
	const cur = target[index];
	return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

/** Subsequence score of pattern in target (case-insensitive); undefined when not a subsequence. */
function scoreSubsequence(pattern: string, target: string): number | undefined {
	const p = pattern.toLowerCase();
	const t = target.toLowerCase();
	let score = 0;
	let from = 0;
	let previous = -2;
	for (let i = 0; i < p.length; i++) {
		const found = t.indexOf(p[i], from);
		if (found < 0) return undefined;
		score += 1;
		if (found === previous + 1) score += 5;
		if (isBoundary(target, found)) score += 8;
		previous = found;
		from = found + 1;
	}
	const substring = t.indexOf(p);
	if (substring >= 0) score += 30 + (isBoundary(target, substring) ? 20 : 0);
	return score;
}

/** Score of a path for a file query; undefined when it does not match. Higher is better. */
export function scoreFilePath(pattern: string, path: string): number | undefined {
	const query = pattern.replace(/\s+/g, '').replace(/\\/g, '/');
	if (query === '') return 0;
	const name = path.slice(path.lastIndexOf('/') + 1);
	const inName = query.includes('/') ? undefined : scoreSubsequence(query, name);
	const inPath = scoreSubsequence(query, path);
	if (inName === undefined && inPath === undefined) return undefined;
	let score = inPath ?? 0;
	if (inName !== undefined) {
		score = Math.max(score, inName + 1000);
		if (name.toLowerCase().startsWith(query.toLowerCase())) score += 100;
	}
	return score - path.length / 1000;
}

interface FileSearchEngineOptions extends Filters {
	pattern: string;
	root: string;
	maxResults?: number;
	limits?: Partial<SearchLimits>;
	isCancelled: () => boolean;
	yieldToHost?: () => Promise<void>;
}

/** Fuzzy file search; returns paths relative to the root, best first, ties in path order. */
export async function searchFiles(
	source: Pick<SearchSource, 'readDirectory'>,
	options: FileSearchEngineOptions,
): Promise<{ paths: string[]; summary: WalkSummary }> {
	const scored: { path: string; score: number }[] = [];
	const summary = await walkFiles(
		source,
		{ ...options, maxFiles: options.limits?.maxFiles ?? DEFAULT_FILE_SEARCH_MAX_FILES },
		async (relative) => {
			const score = scoreFilePath(options.pattern, relative);
			if (score !== undefined) scored.push({ path: relative, score });
		},
	);
	scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const limit = options.maxResults !== undefined && options.maxResults >= 0 ? options.maxResults : scored.length;
	return { paths: scored.slice(0, limit).map((s) => s.path), summary };
}

// Text search

const WORD_CHAR = /\w/;

export class InvalidQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidQueryError';
	}
}

/** Builds the scanning regex; matches never cross lines unless the query is multiline. */
export function buildRegExp(query: TextQuery): RegExp {
	let source = query.isRegExp ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	source = source.replace(/\r\n?/g, '\n');
	if (query.isWordMatch) {
		const head = WORD_CHAR.test(source.charAt(0)) ? '\\b' : '';
		const tail = WORD_CHAR.test(source.charAt(source.length - 1)) ? '\\b' : '';
		// Grouped so an alternation stays inside the word boundaries.
		if (head !== '' || tail !== '') source = `${head}(?:${source})${tail}`;
	}
	const flags = `gm${query.isCaseSensitive ? '' : 'i'}`;
	try {
		return new RegExp(source, `${flags}u`);
	} catch {
		try {
			return new RegExp(source, flags);
		} catch (error) {
			throw new InvalidQueryError(`Invalid regular expression: ${(error as Error).message}`);
		}
	}
}

function normalizeEncoding(encoding: string | undefined): 'utf8' | undefined {
	if (encoding === undefined) return 'utf8';
	const e = encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
	return e === 'utf8' || e === 'utf8bom' ? 'utf8' : undefined;
}

export type Decoded = { text: string } | { skipped: 'binary' | 'encoding' };

/** Decodes UTF-8 or BOM-marked UTF-16; NUL bytes mean binary, other undecodable bytes (for example Latin-1) mean an unsupported encoding. A BOM is dropped. */
export function decodeFile(bytes: Uint8Array): Decoded {
	const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
	if (!utf16 && bytes.indexOf(0) >= 0) return { skipped: 'binary' };
	try {
		const label = utf16 ? (bytes[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8';
		const text = new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
		return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
	} catch {
		return { skipped: 'encoding' };
	}
}

/** Splits at \n, \r\n and \r; positions in the lines equal editor positions. */
export function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

function lineStartsOf(lines: string[]): number[] {
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return starts;
}

function positionAt(starts: number[], offset: number): EnginePosition {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo, character: offset - starts[lo] };
}

/** Limits for one file scan; the counters are filled in by findMatches. */
interface ScanGuard {
	/** Lines longer than this are skipped in single-line mode. */
	maxLineChars: number;
	expired(): boolean;
	longLines: number;
	timedOut: boolean;
}

/** Finds non-empty matches as ranges. Per-line mode keeps matches within a line. */
export function findMatches(lines: string[], regex: RegExp, multiline: boolean, limit: number, guard?: ScanGuard): EngineRange[] {
	const out: EngineRange[] = [];
	const scan = (text: string, toRange: (start: number, end: number) => EngineRange): boolean => {
		regex.lastIndex = 0;
		for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
			if (guard?.expired()) {
				guard.timedOut = true;
				return false;
			}
			if (m[0] === '') {
				regex.lastIndex++;
				continue;
			}
			out.push(toRange(m.index, m.index + m[0].length));
			if (out.length >= limit) return false;
		}
		return true;
	};
	if (multiline) {
		const starts = lineStartsOf(lines);
		scan(lines.join('\n'), (s, e) => ({ start: positionAt(starts, s), end: positionAt(starts, e) }));
	} else {
		for (let line = 0; line < lines.length; line++) {
			if (guard?.expired()) {
				guard.timedOut = true;
				break;
			}
			if (guard !== undefined && lines[line].length > guard.maxLineChars) {
				guard.longLines++;
				continue;
			}
			const toRange = (s: number, e: number): EngineRange => ({
				start: { line, character: s },
				end: { line, character: e },
			});
			if (!scan(lines[line], toRange)) break;
		}
	}
	return out;
}

function clip(text: string, max: number | undefined): string {
	return max !== undefined && max > 0 ? text.slice(0, max) : text;
}

/** Builds the preview for ranges that start on the same line. */
function buildMatch(path: string, lines: string[], ranges: EngineRange[], options: TextSearchEngineOptions): EngineMatch {
	const first = ranges[0].start.line;
	const matchLines = options.previewOptions?.matchLines;
	const chars = options.previewOptions?.charsPerLine;
	let last = Math.max(...ranges.map((r) => r.end.line));
	if (matchLines !== undefined && matchLines > 0) last = Math.min(last, first + matchLines - 1);

	let window = 0;
	if (chars !== undefined && chars > 0 && first === last && lines[first].length > chars) {
		window = Math.max(0, Math.min(ranges[0].start.character - 20, lines[first].length - chars));
	}
	const previewLines: string[] = [];
	for (let line = first; line <= last; line++) {
		previewLines.push(line === first && window > 0 ? lines[line].slice(window) : lines[line]);
	}
	const kept: EngineRange[] = [];
	const matches: EngineRange[] = [];
	for (const range of ranges) {
		if (range.start.line > last) continue;
		const end =
			range.end.line > last
				? { line: last - first, character: clip(previewLines[last - first], chars).length }
				: { line: range.end.line - first, character: range.end.character - (range.end.line === first ? window : 0) };
		const start = { line: range.start.line - first, character: range.start.character - window };
		const limit = (pos: EnginePosition) => (chars !== undefined && chars > 0 ? Math.min(pos.character, chars) : pos.character);
		if (limit(start) !== start.character || (start.line === end.line && limit(end) <= start.character)) continue;
		kept.push(range);
		matches.push({ start, end: { line: end.line, character: limit(end) } });
	}
	return {
		kind: 'match',
		path,
		ranges: kept,
		preview: { text: previewLines.map((l) => clip(l, chars)).join('\n'), matches },
	};
}

function emitFile(path: string, lines: string[], ranges: EngineRange[], options: TextSearchEngineOptions): void {
	const before = Math.max(0, options.beforeContext ?? 0);
	const after = Math.max(0, options.afterContext ?? 0);
	const chars = options.previewOptions?.charsPerLine;
	const groups: EngineRange[][] = [];
	for (const range of ranges) {
		const group = groups[groups.length - 1];
		if (group && group[0].start.line === range.start.line) group.push(range);
		else groups.push([range]);
	}
	let emitted = -1;
	const context = (from: number, to: number) => {
		for (let line = Math.max(from, emitted + 1); line <= to && line < lines.length; line++) {
			options.onResult({ kind: 'context', path, text: clip(lines[line], chars), lineNumber: line });
			emitted = line;
		}
	};
	groups.forEach((group, index) => {
		const startLine = group[0].start.line;
		if (before > 0) context(startLine - before, startLine - 1);
		const match = buildMatch(path, lines, group, options);
		if (match.ranges.length > 0) options.onResult(match);
		const endLine = Math.max(...group.map((r) => r.end.line));
		emitted = Math.max(emitted, endLine);
		if (after > 0) {
			const next = groups[index + 1]?.[0].start.line ?? lines.length;
			context(endLine + 1, Math.min(endLine + after, next - 1));
		}
	});
}

/** Scans files under the root; streams results through onResult in path order. */
export async function searchText(source: SearchSource, options: TextSearchEngineOptions): Promise<TextSearchSummary> {
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const summary: TextSearchSummary = { limitHit: false, filesScanned: 0, bytesScanned: 0, cancelled: false, warnings: [] };
	if (options.query.pattern === '' || options.maxResults <= 0) return summary;
	const regex = buildRegExp(options.query);
	const multiline = options.query.isMultiline === true || /[\r\n]/.test(options.query.pattern);
	if (normalizeEncoding(options.encoding) === undefined) {
		summary.warnings.push(`Encoding "${options.encoding}" is not supported; files were searched as UTF-8.`);
	}
	let bytesTruncated = false;
	let unreadable = 0;
	let lfsSkipped = 0;
	let undecodable = 0;
	let longLines = 0;
	let timedOut = 0;
	let remaining = options.maxResults;
	const now = options.now ?? Date.now;

	const walk = await walkFiles(
		source,
		{ ...options, maxFiles: limits.maxFiles },
		async (relative, sourcePath) => {
			try {
				if (options.maxFileSize !== undefined) {
					const { size } = await source.stat(sourcePath);
					if (size > options.maxFileSize) return;
					if (summary.bytesScanned + size > limits.maxBytes) {
						bytesTruncated = true;
						return false;
					}
				}
				const bytes = await source.readFile(sourcePath, { lfs: 'pointer' });
				if (isLfsPointer(bytes)) {
					lfsSkipped++;
					return;
				}
				if (options.maxFileSize !== undefined && bytes.length > options.maxFileSize) return;
				// Binary files are not text and do not use the text budget.
				const decoded = decodeFile(bytes);
				if (!('text' in decoded)) {
					if (decoded.skipped === 'encoding') undecodable++;
					return;
				}
				if (summary.bytesScanned + bytes.length > limits.maxBytes) {
					bytesTruncated = true;
					return false;
				}
				summary.bytesScanned += bytes.length;
				summary.filesScanned++;
				const lines = splitLines(decoded.text);
				const started = now();
				// Only a user regular expression can backtrack badly; literal queries scan long lines.
				const guard: ScanGuard = {
					maxLineChars: options.query.isRegExp ? limits.maxLineChars : Infinity,
					expired: () => now() - started > limits.maxFileMs,
					longLines: 0,
					timedOut: false,
				};
				const ranges = findMatches(lines, regex, multiline, remaining + 1, guard);
				longLines += guard.longLines;
				if (guard.timedOut) timedOut++;
				if (ranges.length > remaining) {
					summary.limitHit = true;
					ranges.length = remaining;
				}
				remaining -= ranges.length;
				if (ranges.length > 0) emitFile(relative, lines, ranges, options);
				if (summary.limitHit) return false;
			} catch {
				unreadable++;
			}
		},
	);
	summary.cancelled = walk.cancelled;
	if (walk.filesTruncated) {
		summary.warnings.push(`Only the first ${limits.maxFiles} files were searched; results are partial.`);
	}
	if (bytesTruncated) {
		summary.warnings.push(`Search stopped after ${Math.round(limits.maxBytes / (1024 * 1024))} MB of text; results are partial.`);
	}
	if (walk.unlistable > 0) summary.warnings.push(`${walk.unlistable} folder(s) could not be listed and were skipped.`);
	if (undecodable > 0) summary.warnings.push(`${undecodable} file(s) are not valid UTF-8 or UTF-16 with a byte order mark and were skipped.`);
	if (longLines > 0) {
		summary.warnings.push(`${longLines} line(s) longer than ${limits.maxLineChars} characters were skipped by the regular expression search.`);
	}
	if (timedOut > 0) summary.warnings.push(`${timedOut} file(s) were only partly searched: a pattern took longer than ${limits.maxFileMs} ms.`);
	if (unreadable > 0) summary.warnings.push(`${unreadable} file(s) could not be read and were skipped.`);
	if (lfsSkipped > 0) summary.warnings.push(`${lfsSkipped} Git LFS file(s) were not searched; LFS objects are not downloaded for search.`);
	return summary;
}
