// Minimal tar writer for tests, written from POSIX.1-2001 (ustar header layout, pax records)
// and the GNU tar manual (long name entries). Independent of the parser under test.

const enc = new TextEncoder();

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function put(block: Uint8Array, offset: number, text: string, length: number): void {
	const bytes = enc.encode(text);
	if (bytes.length > length) {
		throw new Error(`field too long: ${text}`);
	}
	block.set(bytes, offset);
}

interface HeaderFields {
	name: string;
	/** Typeflag character; default '0'. */
	type?: string;
	size?: number;
	mode?: number;
	linkname?: string;
	/** ustar prefix field; written with the POSIX magic. */
	prefix?: string;
	/** 'posix' = "ustar\0" "00", 'gnu' = "ustar  \0", 'none' = zeros. */
	magic?: 'posix' | 'gnu' | 'none';
	/** Raw size field text, for malformed-input tests. */
	rawSize?: string;
}

export function header(fields: HeaderFields): Uint8Array {
	const block = new Uint8Array(512);
	put(block, 0, fields.name, 100);
	put(block, 100, (fields.mode ?? 0o644).toString(8).padStart(7, '0'), 7);
	put(block, 108, '0000000', 7);
	put(block, 116, '0000000', 7);
	put(block, 124, fields.rawSize ?? (fields.size ?? 0).toString(8).padStart(11, '0'), 11);
	put(block, 136, '00000000000', 11);
	block[156] = (fields.type ?? '0').charCodeAt(0);
	put(block, 157, fields.linkname ?? '', 100);
	const magic = fields.magic ?? 'posix';
	if (magic === 'posix') {
		put(block, 257, 'ustar', 5);
		put(block, 263, '00', 2);
		put(block, 345, fields.prefix ?? '', 155);
	} else if (magic === 'gnu') {
		block.set(enc.encode('ustar  '), 257);
		// GNU tar reuses the prefix area for atime/ctime; the parser must not read it as a prefix.
		put(block, 345, fields.prefix ?? '', 155);
	}
	return seal(block);
}

/** Writes the checksum: sum of all bytes with the checksum field as spaces (POSIX.1-2001 ustar). */
export function seal(block: Uint8Array): Uint8Array {
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of block) {
		sum += byte;
	}
	put(block, 148, sum.toString(8).padStart(6, '0'), 6);
	block[154] = 0;
	block[155] = 0x20;
	return block;
}

export function padded(data: Uint8Array): Uint8Array {
	const rest = (512 - (data.length % 512)) % 512;
	return rest === 0 ? data : concat(data, new Uint8Array(rest));
}

export function file(name: string, content: string | Uint8Array, extra: Partial<HeaderFields> = {}): Uint8Array {
	const data = typeof content === 'string' ? enc.encode(content) : content;
	return concat(header({ name, size: data.length, ...extra }), padded(data));
}

export function directory(name: string): Uint8Array {
	return header({ name, type: '5', mode: 0o755 });
}

export function symlink(name: string, target: string): Uint8Array {
	return header({ name, type: '2', linkname: target, mode: 0o777 });
}

/** pax extended header: "<len> <key>=<value>\n" with len counting the whole record. */
export function paxRecords(records: Record<string, string>): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const [key, value] of Object.entries(records)) {
		const body = enc.encode(` ${key}=${value}\n`);
		let length = body.length + 1;
		while (String(length).length + body.length !== length) {
			length = String(length).length + body.length;
		}
		parts.push(enc.encode(String(length)), body);
	}
	return concat(...parts);
}

export function pax(records: Record<string, string>, type: 'x' | 'g' = 'x', name = 'PaxHeader/entry'): Uint8Array {
	const payload = paxRecords(records);
	return concat(header({ name, type, size: payload.length }), padded(payload));
}

/** GNU 'L' (long name) or 'K' (long link) entry. */
export function gnuLong(value: string, type: 'L' | 'K' = 'L'): Uint8Array {
	const payload = concat(enc.encode(value), new Uint8Array(1));
	return concat(header({ name: '././@LongLink', type, size: payload.length, magic: 'gnu' }), padded(payload));
}

export function end(blocks = 2): Uint8Array {
	return new Uint8Array(512 * blocks);
}

export function tar(...parts: Uint8Array[]): Uint8Array {
	return concat(...parts, end());
}

export function chunked(data: Uint8Array, size: number | ((index: number) => number)): Uint8Array[] {
	const out: Uint8Array[] = [];
	let offset = 0;
	for (let i = 0; offset < data.length; i++) {
		const n = typeof size === 'number' ? size : size(i);
		out.push(data.slice(offset, offset + n));
		offset += n;
	}
	return out;
}

export function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
			} else {
				controller.close();
			}
		},
	});
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = streamOf([data]).pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
	return concat(...(await readAll(stream)));
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return out;
		}
		out.push(value);
	}
}
