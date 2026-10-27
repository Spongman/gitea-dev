import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { x, type ReadEntry, type Unpack } from 'tar';
import { AssetError, DEFAULT_LIMITS, type ArchiveLimits } from './types.js';
import { forbiddenReason } from './validate.js';

export interface ExtractOptions {
	limits?: ArchiveLimits;
}

// Single top-level directory every entry must live under; stripped on extraction.
const STRIP_PREFIX = 'vscode-web';

const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

const unsafe = (message: string): never => {
	throw new AssetError('unsafe-archive', message);
};

// Validates raw tar entry paths, accumulating collision state. Throws
// AssetError on anything that could escape, alias or shadow another entry.
class EntryPolicy {
	private readonly files = new Set<string>();
	private readonly dirs = new Set<string>();
	private readonly explicitDirs = new Set<string>();
	entries = 0;
	unpackedBytes = 0;

	constructor(private readonly limits: ArchiveLimits) {}

	// Returns the tree-relative path, or undefined for the prefix directory.
	check(entry: Pick<ReadEntry, 'path' | 'type' | 'size' | 'linkpath'>): string | undefined {
		const raw = entry.path;
		const type = entry.type;
		if (type === 'SymbolicLink' || type === 'Link') {
			return unsafe(`${raw}: ${type === 'Link' ? 'hard link' : 'symlink'} not allowed`);
		}
		const isDir = type === 'Directory';
		if (!isDir && !FILE_TYPES.has(type)) return unsafe(`${raw}: entry type ${type} not allowed`);
		if (++this.entries > this.limits.maxEntries) {
			throw new AssetError('limit', 'archive has too many entries');
		}
		if (isDir && entry.size > 0) unsafe(`${raw}: directory with data`);

		const segments = this.segments(raw, isDir);
		if (segments[0] !== STRIP_PREFIX) {
			return unsafe(`${raw}: outside required "${STRIP_PREFIX}/" prefix`);
		}
		const rel = segments.slice(1);
		if (rel.length === 0) {
			if (!isDir) unsafe(`${raw}: prefix must be a directory`);
			return undefined;
		}
		const relPath = rel.join('/');
		const reason = forbiddenReason(relPath, isDir);
		if (reason) unsafe(`${raw}: ${reason}`);

		// Case/normalization-insensitive keys so no entry can clobber another.
		const key = relPath.normalize('NFC').toLowerCase();
		const parts = key.split('/');
		for (let i = 1; i < parts.length; i++) {
			const ancestor = parts.slice(0, i).join('/');
			if (this.files.has(ancestor)) unsafe(`${raw}: parent is a file`);
			this.dirs.add(ancestor);
		}
		if (isDir) {
			if (this.files.has(key) || this.explicitDirs.has(key)) unsafe(`${raw}: duplicate entry`);
			this.explicitDirs.add(key);
			this.dirs.add(key);
		} else {
			if (this.files.has(key) || this.dirs.has(key)) unsafe(`${raw}: duplicate entry`);
			this.files.add(key);
			this.unpackedBytes += entry.size;
			if (this.unpackedBytes > this.limits.maxUnpackedBytes) {
				throw new AssetError('limit', 'archive unpacked size exceeds limit');
			}
		}
		return relPath;
	}

	private segments(raw: string, isDir: boolean): string[] {
		if (raw.length === 0) unsafe('empty entry path');
		if (raw.length > this.limits.maxPathLength) unsafe(`${raw.slice(0, 64)}...: path too long`);
		if (raw.includes('\\')) unsafe(`${raw}: backslash in path`);
		if (/[\x00-\x1f\x7f]/.test(raw)) unsafe('control character in path');
		if (raw.startsWith('/')) unsafe(`${raw}: absolute path`);
		if (/^[A-Za-z]:/.test(raw)) unsafe(`${raw}: drive-letter path`);
		const trimmed = isDir && raw.endsWith('/') ? raw.slice(0, -1) : raw;
		const segments = trimmed.split('/');
		for (const segment of segments) {
			if (segment === '' || segment === '.' || segment === '..') {
				unsafe(`${raw}: invalid path segment`);
			}
			if (segment.includes(':')) unsafe(`${raw}: ':' in path segment`);
		}
		return segments;
	}
}

// Feeds a gzip file to the tar extractor, bounding compressed and
// decompressed bytes. The extractor is driven manually so the byte bound
// applies to the stream before tar sees it. Returns the sha256 of the
// compressed bytes read.
async function feed(
	file: string,
	unpack: Unpack,
	limits: ArchiveLimits,
	done: Promise<void>,
	violation: { error?: unknown },
): Promise<string> {
	const size = (await lstat(file)).size;
	if (size > limits.maxCompressedBytes) {
		throw new AssetError('limit', 'archive exceeds compressed size limit');
	}
	// tar block/padding overhead on top of the payload.
	const maxDecompressed = limits.maxUnpackedBytes + limits.maxEntries * 1536 + 16 * 1024 * 1024;
	const hash = createHash('sha256');
	let total = 0;
	const failed = new Promise<never>((_, reject) => unpack.once('error', reject));
	failed.catch(() => undefined);
	try {
		await Promise.race([
			pipeline(
				createReadStream(file),
				async function* (source: AsyncIterable<Buffer>) {
					for await (const chunk of source) {
						hash.update(chunk);
						yield chunk;
					}
				},
				createGunzip(),
				async (source: AsyncIterable<Buffer>) => {
					for await (const chunk of source) {
						if (violation.error) throw violation.error;
						total += chunk.length;
						if (total > maxDecompressed) {
							throw new AssetError('limit', 'archive exceeds decompressed size limit');
						}
						if (!unpack.write(chunk)) await Promise.race([once(unpack, 'drain'), failed]);
					}
				},
			),
			failed,
		]);
		unpack.end();
		await Promise.race([done, failed]);
	} catch (error) {
		// Ending the extractor closes a file cut off mid-body; its own
		// truncation error is expected and ignored.
		unpack.on('error', () => undefined);
		try {
			unpack.end();
		} catch {
			// already failed
		}
		// A policy violation recorded by the entry handler is the real cause
		// even if the stream teardown surfaced a generic abort first.
		if (violation.error) throw violation.error;
		if (error instanceof AssetError) throw error;
		throw new AssetError('unsafe-archive', `cannot read archive: ${(error as Error).message}`, {
			cause: error,
		});
	}
	return hash.digest('hex');
}

// Extracts into a directory, validating every entry as it streams, and
// returns the sha256 of the archive bytes it read. Entries written before a
// violation stay in dest; callers extract into a staging directory.
// Modes are normalized so nothing extracted is executable.
export async function extractArchive(
	file: string,
	dest: string,
	options: ExtractOptions = {},
): Promise<{ sha256: string }> {
	const limits = options.limits ?? DEFAULT_LIMITS;
	const policy = new EntryPolicy(limits);
	await mkdir(dest, { recursive: true });
	const violation: { error?: unknown } = {};
	const unpack = x({
		cwd: dest,
		strict: true,
		strip: 1,
		preservePaths: false,
		preserveOwner: false,
		unlink: false,
		noMtime: true,
		filter: (_path, entry) => {
			try {
				policy.check(entry as ReadEntry);
				return true;
			} catch (error) {
				violation.error ??= error;
				return false;
			}
		},
	});
	const done = new Promise<void>((resolve) => unpack.once('close', resolve));
	const sha256 = await feed(file, unpack as unknown as Unpack, limits, done, violation);
	if (violation.error) throw violation.error;
	await normalizeModes(dest);
	return { sha256 };
}

async function normalizeModes(dir: string): Promise<void> {
	await chmod(dir, 0o755);
	for (const dirent of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, dirent.name);
		if (dirent.isDirectory()) await normalizeModes(full);
		else if (dirent.isFile()) await chmod(full, 0o644);
	}
}
