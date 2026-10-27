/**
 * Streaming tar reader: POSIX ustar, pax (x and g records) and GNU long names (L, K).
 * Browser-safe (no Buffer). Entries are yielded one at a time, so only the current file
 * is held in memory. Every size and count is capped to bound hostile or corrupt input.
 */

type TarErrorCode = 'bad-checksum' | 'truncated' | 'limit' | 'malformed';

export class TarError extends Error {
	readonly code: TarErrorCode;

	constructor(code: TarErrorCode, message: string) {
		super(message);
		this.name = 'TarError';
		this.code = code;
	}
}

interface TarLimits {
	/** Real entries (not pax or long-name headers). */
	maxEntries: number;
	/** Files above this are skipped without being buffered. */
	maxEntryBytes: number;
	/** Sum of the declared sizes of all entries. */
	maxTotalBytes: number;
	/** Largest pax or long-name payload. */
	maxMetaBytes: number;
	/** Total bytes read from the source, including padding and trailing data. */
	maxStreamBytes: number;
}

const DEFAULT_TAR_LIMITS = {
	maxEntries: 100_000,
	maxEntryBytes: 25 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024,
	maxMetaBytes: 64 * 1024,
} as const;

function resolveTarLimits(limits: Partial<TarLimits> = {}): TarLimits {
	const merged = { ...DEFAULT_TAR_LIMITS, ...limits };
	return {
		...merged,
		maxStreamBytes: limits.maxStreamBytes ?? merged.maxTotalBytes + merged.maxEntries * 1536 + 1024 * 1024,
	};
}

type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';

export interface TarEntry {
	/** Path as stored, directories keep their trailing slash. */
	path: string;
	type: TarEntryType;
	/** Declared payload size; 0 for directories and links. */
	size: number;
	mode: number;
	linkpath?: string;
	/** Fresh copy of a regular file's bytes; absent when `skipped`. */
	content?: Uint8Array;
	/** A regular file whose payload was discarded because it exceeds maxEntryBytes. */
	skipped?: 'too-large';
}

const BLOCK = 512;
const EMPTY = new Uint8Array(0);

function isZero(block: Uint8Array): boolean {
	for (let i = 0; i < block.length; i++) {
		if (block[i] !== 0) {
			return false;
		}
	}
	return true;
}

function cstring(bytes: Uint8Array, start: number, length: number): string {
	let end = start;
	const limit = start + length;
	while (end < limit && bytes[end] !== 0) {
		end++;
	}
	return new TextDecoder('utf-8').decode(bytes.subarray(start, end));
}

/** Octal field, or GNU base-256 when the high bit of the first byte is set. */
function numeric(bytes: Uint8Array, start: number, length: number, what: string): number {
	const first = bytes[start];
	if ((first & 0x80) !== 0) {
		if ((first & 0x40) !== 0) {
			throw new TarError('malformed', `Negative ${what}`);
		}
		let value = first & 0x3f;
		for (let i = 1; i < length; i++) {
			value = value * 256 + bytes[start + i];
			if (!Number.isSafeInteger(value)) {
				throw new TarError('malformed', `${what} is out of range`);
			}
		}
		return value;
	}
	const text = new TextDecoder('ascii').decode(bytes.subarray(start, start + length)).replace(/[\0 ]+$/, '').replace(/^ +/, '');
	if (text === '') {
		return 0;
	}
	if (!/^[0-7]+$/.test(text)) {
		throw new TarError('malformed', `Invalid ${what}`);
	}
	const value = parseInt(text, 8);
	if (!Number.isSafeInteger(value)) {
		throw new TarError('malformed', `${what} is out of range`);
	}
	return value;
}

function checksumMatches(block: Uint8Array): boolean {
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < BLOCK; i++) {
		const byte = i >= 148 && i < 156 ? 0x20 : block[i];
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	const stored = numeric(block, 148, 8, 'checksum');
	return stored === unsigned || stored === signed;
}

/** "<len> <key>=<value>\n" records; len counts the whole record including itself. */
function parsePax(data: Uint8Array): Map<string, string> {
	const out = new Map<string, string>();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let pos = 0;
	while (pos < data.length) {
		let space = pos;
		while (space < data.length && data[space] !== 0x20) {
			space++;
		}
		const digits = new TextDecoder('ascii').decode(data.subarray(pos, space));
		if (space >= data.length || !/^[1-9][0-9]{0,15}$/.test(digits)) {
			throw new TarError('malformed', 'Invalid pax record length');
		}
		const length = Number(digits);
		const end = pos + length;
		if (end > data.length || end <= space + 1 || data[end - 1] !== 0x0a) {
			throw new TarError('malformed', 'Invalid pax record');
		}
		let text: string;
		try {
			text = decoder.decode(data.subarray(space + 1, end - 1));
		} catch {
			throw new TarError('malformed', 'pax record is not valid UTF-8');
		}
		const equals = text.indexOf('=');
		if (equals <= 0) {
			throw new TarError('malformed', 'pax record has no key');
		}
		out.set(text.slice(0, equals), text.slice(equals + 1));
		pos = end;
	}
	return out;
}

/** Pulls chunks lazily and serves exact-length reads; copies, never aliases, returned bytes. */
class ByteSource {
	readonly #next: () => Promise<Uint8Array | undefined>;
	readonly #close: () => Promise<void>;
	readonly #maxBytes: number;
	#chunk: Uint8Array = EMPTY;
	#pos = 0;
	#consumed = 0;

	constructor(source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, maxBytes: number) {
		this.#maxBytes = maxBytes;
		if ('getReader' in source) {
			const reader = source.getReader();
			this.#next = async () => {
				const { done, value } = await reader.read();
				return done ? undefined : value;
			};
			this.#close = () => reader.cancel().catch(() => undefined);
		} else {
			const iterator = source[Symbol.asyncIterator]();
			this.#next = async () => {
				const { done, value } = await iterator.next();
				return done ? undefined : value;
			};
			this.#close = async () => {
				await iterator.return?.();
			};
		}
	}

	close(): Promise<void> {
		return this.#close();
	}

	async #fill(): Promise<boolean> {
		while (this.#pos >= this.#chunk.length) {
			const chunk = await this.#next();
			if (chunk === undefined) {
				return false;
			}
			this.#consumed += chunk.length;
			if (this.#consumed > this.#maxBytes) {
				throw new TarError('limit', 'Archive is larger than the stream limit');
			}
			this.#chunk = chunk;
			this.#pos = 0;
		}
		return true;
	}

	/** Exactly n bytes, or undefined when `allowEof` and the stream ends before the first byte. */
	async read(n: number, allowEof = false): Promise<Uint8Array | undefined> {
		const out = new Uint8Array(n);
		let filled = 0;
		while (filled < n) {
			if (!(await this.#fill())) {
				if (allowEof && filled === 0) {
					return undefined;
				}
				throw new TarError('truncated', 'Archive ends before the expected data');
			}
			const take = Math.min(n - filled, this.#chunk.length - this.#pos);
			out.set(this.#chunk.subarray(this.#pos, this.#pos + take), filled);
			filled += take;
			this.#pos += take;
		}
		return out;
	}

	async skip(n: number): Promise<void> {
		let left = n;
		while (left > 0) {
			if (!(await this.#fill())) {
				throw new TarError('truncated', 'Archive ends before the expected data');
			}
			const take = Math.min(left, this.#chunk.length - this.#pos);
			this.#pos += take;
			left -= take;
		}
	}

	/** Reads to the end so a compressed source can verify its own trailer. */
	async drain(): Promise<void> {
		while (await this.#fill()) {
			this.#pos = this.#chunk.length;
		}
	}
}

function padding(size: number): number {
	return (BLOCK - (size % BLOCK)) % BLOCK;
}

function typeOf(flag: number): TarEntryType {
	switch (String.fromCharCode(flag)) {
		case '\0':
		case '0':
		case '7':
			return 'file';
		case '5':
			return 'directory';
		case '2':
			return 'symlink';
		case '1':
			return 'hardlink';
		default:
			return 'other';
	}
}

/** Types 1-6 (links, devices, directory, FIFO) carry no payload; unknown types read as regular files (POSIX ustar). */
function hasPayload(flag: number): boolean {
	return flag < 0x31 || flag > 0x36;
}

/**
 * Yields each real entry. Throws TarError on a bad checksum, truncation (including a missing
 * end-of-archive marker), malformed metadata or an exceeded limit. After the end marker the
 * source is read to its end, so gzip integrity errors surface here too.
 */
export async function* parseTar(source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, limits?: Partial<TarLimits>): AsyncGenerator<TarEntry> {
	const cap = resolveTarLimits(limits);
	const input = new ByteSource(source, cap.maxStreamBytes);
	let pax: Map<string, string> | undefined;
	let longName: string | undefined;
	let longLink: string | undefined;
	let entries = 0;
	let total = 0;
	try {
		for (;;) {
			const block = await input.read(BLOCK, true);
			if (block === undefined) {
				throw new TarError('truncated', 'Archive has no end-of-archive marker');
			}
			if (isZero(block)) {
				const second = await input.read(BLOCK, true);
				if (second === undefined || !isZero(second)) {
					throw new TarError('truncated', second === undefined ? 'Archive ends after a single zero block' : 'Zero block inside the archive');
				}
				await input.drain();
				return;
			}
			if (!checksumMatches(block)) {
				throw new TarError('bad-checksum', 'Tar header checksum mismatch');
			}
			const flag = block[156];
			const headerSize = numeric(block, 124, 12, 'size');

			if (flag === 0x78 || flag === 0x67 || flag === 0x4c || flag === 0x4b) {
				// x, g, L, K: metadata payload
				if (headerSize > cap.maxMetaBytes) {
					throw new TarError('limit', 'Tar metadata header is too large');
				}
				const data = (await input.read(headerSize))!;
				await input.skip(padding(headerSize));
				if (flag === 0x78) {
					pax = parsePax(data);
				} else if (flag === 0x67) {
					parsePax(data);
				} else if (flag === 0x4c) {
					longName = cstring(data, 0, data.length);
				} else {
					longLink = cstring(data, 0, data.length);
				}
				continue;
			}

			if (++entries > cap.maxEntries) {
				throw new TarError('limit', `Archive has more than ${cap.maxEntries} entries`);
			}
			let size = headerSize;
			const paxSize = pax?.get('size');
			if (paxSize !== undefined) {
				if (!/^[0-9]{1,16}$/.test(paxSize) || !Number.isSafeInteger(Number(paxSize))) {
					throw new TarError('malformed', 'Invalid pax size');
				}
				size = Number(paxSize);
			}
			const magic = cstring(block, 257, 6);
			const prefix = magic === 'ustar' ? cstring(block, 345, 155) : '';
			const name = cstring(block, 0, 100);
			const path = pax?.get('path') ?? longName ?? (prefix === '' ? name : `${prefix}/${name}`);
			const linkpath = pax?.get('linkpath') ?? longLink ?? cstring(block, 157, 100);
			pax = undefined;
			longName = undefined;
			longLink = undefined;
			if (path === '') {
				throw new TarError('malformed', 'Entry has no name');
			}

			const type = typeOf(flag);
			const payload = hasPayload(flag) ? size : 0;
			total += payload;
			if (total > cap.maxTotalBytes) {
				throw new TarError('limit', `Archive content is larger than ${cap.maxTotalBytes} bytes`);
			}
			const entry: TarEntry = { path, type, size: payload, mode: numeric(block, 100, 8, 'mode') };
			if (type === 'symlink' || type === 'hardlink') {
				entry.linkpath = linkpath;
			}
			if (type === 'file' && payload > cap.maxEntryBytes) {
				await input.skip(payload + padding(payload));
				entry.skipped = 'too-large';
			} else if (type === 'file') {
				entry.content = (await input.read(payload))!;
				await input.skip(padding(payload));
			} else {
				await input.skip(payload + padding(payload));
			}
			yield entry;
		}
	} finally {
		await input.close();
	}
}
