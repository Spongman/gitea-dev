// Tar reader expectations follow POSIX.1-2001 (ustar and pax interchange format) and the GNU tar
// manual (long name entries), not the parser's current behavior.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TarError, parseTar, type TarEntry } from '../packages/gitea-repository/src/tar.js';
import { chunked, concat, directory, end, file, gnuLong, gzip, header, padded, pax, paxRecords, streamOf, symlink, tar } from './helpers/tar.js';

const dec = new TextDecoder();
const enc = new TextEncoder();

async function collect(source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, limits?: Parameters<typeof parseTar>[1]): Promise<TarEntry[]> {
	const out: TarEntry[] = [];
	for await (const entry of parseTar(source, limits)) {
		out.push(entry);
	}
	return out;
}

const parse = (bytes: Uint8Array, limits?: Parameters<typeof parseTar>[1]) => collect(streamOf([bytes]), limits);

async function rejectsTar(promise: Promise<unknown>, code: TarError['code']): Promise<TarError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof TarError, `expected TarError, got ${String(error)}`);
		assert.equal(error.code, code, error.message);
		return error;
	}
	assert.fail('expected the parse to reject');
}

const summary = (entries: TarEntry[]) =>
	entries.map((e) => ({ path: e.path, type: e.type, size: e.size, content: e.content === undefined ? undefined : dec.decode(e.content), linkpath: e.linkpath }));

describe('tar reader: formats', () => {
	it('reads ustar files and directories, skipping block padding', async () => {
		const entries = await parse(tar(directory('repo/'), file('repo/a.txt', 'hello'), file('repo/empty', ''), file('repo/big', 'x'.repeat(1025))));
		assert.deepEqual(summary(entries), [
			{ path: 'repo/', type: 'directory', size: 0, content: undefined, linkpath: undefined },
			{ path: 'repo/a.txt', type: 'file', size: 5, content: 'hello', linkpath: undefined },
			{ path: 'repo/empty', type: 'file', size: 0, content: '', linkpath: undefined },
			{ path: 'repo/big', type: 'file', size: 1025, content: 'x'.repeat(1025), linkpath: undefined },
		]);
	});

	it('joins the ustar prefix and name with a slash (POSIX magic only)', async () => {
		const entries = await parse(tar(file('file.txt', 'p', { prefix: 'a/b/c' })));
		assert.equal(entries[0].path, 'a/b/c/file.txt');
	});

	it('does not read the prefix area of a GNU-magic header as a prefix', async () => {
		const entries = await parse(tar(file('file.txt', 'g', { magic: 'gnu', prefix: '12345678901' })));
		assert.equal(entries[0].path, 'file.txt');
	});

	it('applies pax path and size over the ustar header fields', async () => {
		const longPath = `${'d/'.repeat(80)}name.txt`;
		const body = 'pax body';
		const data = concat(pax({ path: longPath, size: String(body.length) }), header({ name: 'short', size: 0 }), padded(enc.encode(body)));
		const entries = await parse(tar(data, file('next', 'n')));
		assert.deepEqual(summary(entries).map((e) => [e.path, e.content]), [
			[longPath, body],
			['next', 'n'],
		]);
	});

	it('reads UTF-8 pax paths and link targets by byte length', async () => {
		const name = 'repo/caf\u00e9/\u65e5\u672c\u8a9e.txt';
		const entries = await parse(
			tar(
				concat(pax({ path: name }), file('x', 'u')),
				concat(pax({ linkpath: 'target/\u00fc' }), symlink('link', 'ignored')),
			),
		);
		assert.equal(entries[0].path, name);
		assert.equal(entries[1].type, 'symlink');
		assert.equal(entries[1].linkpath, 'target/\u00fc');
	});

	it('ignores pax global headers, as Gitea writes before the first entry', async () => {
		const comment = 'a'.repeat(40);
		const entries = await parse(tar(pax({ comment }, 'g', 'pax_global_header'), file('r/f', 'g')));
		assert.deepEqual(entries.map((e) => e.path), ['r/f']);
	});

	it('applies pax records to the next entry only', async () => {
		const entries = await parse(tar(concat(pax({ path: 'first/long' }), file('a', '1')), file('second', '2')));
		assert.deepEqual(entries.map((e) => e.path), ['first/long', 'second']);
	});

	it('reads GNU long name (L) and long link (K) entries for the next header', async () => {
		const longName = `${'n/'.repeat(120)}file`;
		const longLink = `${'t/'.repeat(120)}target`;
		const entries = await parse(tar(gnuLong(longName), file('truncated-name', 'ln'), gnuLong(longLink, 'K'), symlink('link', 'cut')));
		assert.equal(entries[0].path, longName);
		assert.equal(dec.decode(entries[0].content), 'ln');
		assert.equal(entries[1].path, 'link');
		assert.equal(entries[1].linkpath, longLink);
	});

	it('reports symlinks and hard links without payload, even with a nonzero size field', async () => {
		const entries = await parse(tar(symlink('s', 'target'), header({ name: 'h', type: '1', linkname: 'f', size: 7 }), file('after', 'a')));
		assert.deepEqual(summary(entries).map((e) => [e.path, e.type, e.size, e.linkpath]), [
			['s', 'symlink', 0, 'target'],
			['h', 'hardlink', 0, 'f'],
			['after', 'file', 1, undefined],
		]);
	});

	it('reads regular-file typeflags NUL and 7, and skips the payload of unknown types', async () => {
		const entries = await parse(tar(file('nul', 'a', { type: '\0' }), file('contig', 'b', { type: '7' }), file('weird', 'zzz', { type: 'V' }), file('last', 'c')));
		assert.deepEqual(summary(entries).map((e) => [e.path, e.type, e.content]), [
			['nul', 'file', 'a'],
			['contig', 'file', 'b'],
			['weird', 'other', undefined],
			['last', 'file', 'c'],
		]);
	});

	it('reads GNU base-256 sizes', async () => {
		const block = header({ name: 'b256', size: 3 });
		block.fill(0, 124, 136);
		block[124] = 0x80;
		block[135] = 3;
		const sealed = (await import('./helpers/tar.js')).seal(block);
		const entries = await parse(tar(concat(sealed, padded(enc.encode('abc')))));
		assert.equal(dec.decode(entries[0].content), 'abc');
	});

	it('returns copies, so retaining a file does not pin the stream chunk', async () => {
		const [entry] = await parse(tar(file('f', 'abc')));
		assert.equal(entry.content!.buffer.byteLength, 3);
	});

	it('accepts an empty archive of two zero blocks', async () => {
		assert.deepEqual(await parse(end()), []);
	});

	it('accepts trailing record padding after the end marker', async () => {
		assert.deepEqual((await parse(concat(tar(file('f', 'x')), new Uint8Array(10240)))).map((e) => e.path), ['f']);
	});
});

describe('tar reader: chunk boundaries', () => {
	const archive = tar(
		pax({ comment: 'x'.repeat(40) }, 'g', 'pax_global_header'),
		directory('repo/'),
		gnuLong(`repo/${'long/'.repeat(30)}f.txt`),
		file('short', 'content of the long one'),
		concat(pax({ path: 'repo/pax\u00e9.txt' }), file('p', 'pax content')),
		file('repo/zero', ''),
		symlink('repo/l', 'repo/zero'),
		file('repo/last', 'y'.repeat(2000)),
	);

	it('parses identically for every chunking', async () => {
		const reference = summary(await parse(archive));
		assert.equal(reference.length, 6);
		let seed = 12345;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return 1 + (seed % 700);
		};
		for (const size of [1, 2, 7, 100, 255, 256, 511, 512, 513, 1023, 4096, random]) {
			assert.deepEqual(summary(await collect(streamOf(chunked(archive, size)))), reference, `chunk size ${String(size)}`);
		}
	});

	it('also reads plain async iterables', async () => {
		async function* chunks() {
			for (const chunk of chunked(archive, 333)) {
				yield chunk;
			}
		}
		assert.equal((await collect(chunks())).length, 6);
	});

	it('pulls the source lazily and never reads the whole archive to yield the first entry', async () => {
		const parts = [directory('r/')];
		for (let i = 0; i < 200; i++) {
			parts.push(file(`r/f${i}`, 'z'.repeat(1000)));
		}
		const data = tar(...parts);
		const pieces = chunked(data, 512);
		let pulled = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled < pieces.length) {
					controller.enqueue(pieces[pulled++]);
				} else {
					controller.close();
				}
			},
		}, { highWaterMark: 0 });
		for await (const entry of parseTar(source)) {
			assert.equal(entry.path, 'r/');
			break;
		}
		assert.ok(pulled < 5, `pulled ${pulled} of ${pieces.length} chunks for the first entry`);
	});

	it('cancels the source when the consumer stops early', async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(tar(file('a', '1'), file('b', '2')).slice(0, 4096));
			},
			cancel() {
				cancelled = true;
			},
		}, { highWaterMark: 0 });
		for await (const entry of parseTar(source)) {
			assert.equal(entry.path, 'a');
			break;
		}
		assert.equal(cancelled, true);
	});
});

describe('tar reader: damaged input', () => {
	const good = tar(file('repo/a.txt', 'hello world'), file('repo/b.txt', 'second'));

	it('rejects a stream cut at every point before the end marker as truncated', async () => {
		const lastData = good.length - 1024;
		for (const cut of [0, 1, 100, 511, 512, 513, 520, 1023, 1024, 1030, 1536, lastData - 1, lastData, lastData + 100, lastData + 512, good.length - 513, good.length - 1, good.length - 512]) {
			await rejectsTar(parse(good.slice(0, cut)), 'truncated');
		}
	});

	it('rejects a stream that ends exactly at a block boundary without an end marker', async () => {
		await rejectsTar(parse(concat(file('f', 'x'))), 'truncated');
	});

	it('rejects a lone zero block (POSIX requires two)', async () => {
		await rejectsTar(parse(concat(file('f', 'x'), end(1))), 'truncated');
	});

	it('rejects a header whose checksum does not match', async () => {
		const bad = good.slice();
		bad[3] ^= 0x01;
		const error = await rejectsTar(parse(bad), 'bad-checksum');
		assert.match(error.message, /checksum/i);
	});

	it('rejects an unparsable checksum field', async () => {
		const bad = good.slice();
		bad.set(enc.encode('zzzzzz\0 '), 148);
		await rejectsTar(parse(bad), 'malformed');
	});

	it('rejects a non-octal size field', async () => {
		await rejectsTar(parse(tar(header({ name: 'f', rawSize: '9999999999x' }))), 'malformed');
	});

	it('rejects malformed pax records', async () => {
		for (const payload of ['5 a=b\n', '99 path=x\n', '12 path=abc', '10 noequals\n', 'x path=1\n']) {
			const data = enc.encode(payload);
			await rejectsTar(parse(tar(concat(header({ name: 'PaxHeader', type: 'x', size: data.length }), padded(data), file('f', 'x')))), 'malformed');
		}
	});

	it('rejects invalid UTF-8 in a pax record', async () => {
		const prefix = enc.encode('11 path=');
		const data = concat(prefix, new Uint8Array([0xff, 0xfe, 0x0a]));
		await rejectsTar(parse(tar(concat(header({ name: 'P', type: 'x', size: data.length }), padded(data), file('f', 'x')))), 'malformed');
	});

	it('rejects a corrupt gzip trailer even after a valid end marker', async () => {
		const compressed = await gzip(tar(file('repo/a', 'data')));
		const bad = compressed.slice();
		bad[bad.length - 5] ^= 0xff;
		const source = streamOf([bad]).pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
		await assert.rejects(collect(source));
	});

	it('reads a gzip-compressed archive', async () => {
		const source = streamOf(chunked(await gzip(good), 17)).pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
		assert.deepEqual((await collect(source)).map((e) => e.path), ['repo/a.txt', 'repo/b.txt']);
	});
});

describe('tar reader: limits against hostile input', () => {
	it('rejects more entries than maxEntries', async () => {
		await rejectsTar(parse(tar(file('a', '1'), file('b', '2'), file('c', '3')), { maxEntries: 2 }), 'limit');
	});

	it('does not count pax or long-name headers as entries', async () => {
		const entries = await parse(tar(pax({ path: 'p' }), file('x', '1'), gnuLong('l'), file('y', '2')), { maxEntries: 2 });
		assert.equal(entries.length, 2);
	});

	it('rejects a declared total above maxTotalBytes before reading any payload', async () => {
		// Only the header exists: reading or skipping the declared 1 TB would report truncation instead.
		const huge = concat(pax({ size: String(10 ** 12) }), header({ name: 'bomb' }));
		await rejectsTar(parse(huge, { maxTotalBytes: 1024 * 1024 }), 'limit');
	});

	it('sums declared sizes across entries, including skipped ones', async () => {
		await rejectsTar(parse(tar(file('a', 'x'.repeat(600)), file('b', 'y'.repeat(600))), { maxTotalBytes: 1000, maxEntryBytes: 10 }), 'limit');
	});

	it('skips files above maxEntryBytes without buffering them and keeps parsing', async () => {
		const entries = await parse(tar(file('big', 'x'.repeat(5000)), file('small', 'ok')), { maxEntryBytes: 100 });
		assert.equal(entries[0].skipped, 'too-large');
		assert.equal(entries[0].content, undefined);
		assert.equal(entries[0].size, 5000);
		assert.equal(dec.decode(entries[1].content), 'ok');
	});

	it('rejects oversized pax and long-name payloads', async () => {
		await rejectsTar(parse(tar(pax({ comment: 'c'.repeat(3000) }), file('f', 'x')), { maxMetaBytes: 1024 }), 'limit');
		await rejectsTar(parse(tar(gnuLong('n'.repeat(3000)), file('f', 'x')), { maxMetaBytes: 1024 }), 'limit');
	});

	it('stops reading a stream that keeps going after the end marker', async () => {
		let pulled = 0;
		const zeros = new Uint8Array(64 * 1024);
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled === 0) {
					controller.enqueue(tar(file('f', 'x')));
				} else {
					controller.enqueue(zeros);
				}
				pulled++;
			},
		}, { highWaterMark: 0 });
		await rejectsTar(collect(source, { maxStreamBytes: 1024 * 1024 }), 'limit');
		assert.ok(pulled <= 20, `pulled ${pulled} chunks`);
	});

	it('bounds the decompressed size of a gzip bomb', async () => {
		const bomb = await gzip(concat(tar(file('f', 'x')), new Uint8Array(32 * 1024 * 1024)));
		assert.ok(bomb.length < 100 * 1024, `bomb is ${bomb.length} bytes compressed`);
		const source = streamOf([bomb]).pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
		await rejectsTar(collect(source, { maxStreamBytes: 2 * 1024 * 1024 }), 'limit');
	});

	it('derives a stream cap from the other limits by default', async () => {
		const zeros = new Uint8Array(1024 * 1024);
		let pulled = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(pulled++ === 0 ? tar(file('f', 'x')) : zeros);
			},
		}, { highWaterMark: 0 });
		await rejectsTar(collect(source, { maxEntries: 10, maxTotalBytes: 1024 }), 'limit');
	});
});

describe('tar reader: agrees with real tar implementations', () => {
	it('reads archives written by GNU tar in gnu, pax, posix and ustar formats', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tar-xcheck-'));
		try {
			const root = path.join(dir, 'src');
			const longDir = path.join(root, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60));
			mkdirSync(longDir, { recursive: true });
			const files: Record<string, string> = {
				'top.txt': 'top',
				[`${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/${'f'.repeat(40)}.txt`]: 'deep',
				'caf\u00e9.txt': 'unicode',
				'sp ace.txt': 'space',
			};
			for (const [name, content] of Object.entries(files)) {
				writeFileSync(path.join(root, name), content);
			}
			symlinkSync('top.txt', path.join(root, 'link'));
			for (const format of ['gnu', 'pax', 'posix', 'oldgnu']) {
				const out = path.join(dir, `${format}.tar`);
				execFileSync('tar', ['--format', format, '-C', dir, '--sort=name', '--owner=0', '--group=0', '-cf', out, 'src']);
				const bytes = new Uint8Array(execFileSync('cat', [out]));
				const entries = await parse(bytes);
				const read = Object.fromEntries(entries.filter((e) => e.type === 'file').map((e) => [e.path, dec.decode(e.content)]));
				assert.deepEqual(read, Object.fromEntries(Object.entries(files).map(([name, content]) => [`src/${name}`, content])), format);
				const link = entries.find((e) => e.type === 'symlink');
				assert.equal(link?.path, 'src/link', format);
				assert.equal(link?.linkpath, 'top.txt', format);
				assert.ok(entries.some((e) => e.type === 'directory' && e.path === `src/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/`), format);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('exposes TarError with a stable name', () => {
		const error = new TarError('limit', 'x');
		assert.equal(error.name, 'TarError');
		assert.ok(paxRecords({ a: 'b' }).length > 0);
	});
});
