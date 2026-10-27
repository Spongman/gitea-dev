import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	buildRegExp,
	compileGlob,
	decodeFile,
	findMatches,
	InvalidQueryError,
	scoreFilePath,
	searchFiles,
	searchText,
	splitLines,
	walkFiles,
	type EngineMatch,
	type EngineResult,
	type SearchSource,
	type TextQuery,
	type TextSearchEngineOptions,
} from '../packages/gitea-vscode-web/src/search-engine.js';

type Tree = Record<string, string | Uint8Array | { type: 'symlink' | 'submodule' } | { lfs: string }>;

const enc = (s: string) => new TextEncoder().encode(s);

const lfsPointer = (object: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${'c'.repeat(64)}\nsize ${object.length}\n`;

function memorySource(tree: Tree): SearchSource & { reads: string[]; downloads: string[] } {
	const reads: string[] = [];
	const downloads: string[] = [];
	const entryAt = (path: string) => tree[path];
	return {
		reads,
		downloads,
		async readDirectory(dir) {
			const prefix = dir === '' ? '' : `${dir}/`;
			const out = new Map<string, string>();
			for (const [path, value] of Object.entries(tree)) {
				if (!path.startsWith(prefix)) continue;
				const rest = path.slice(prefix.length);
				const name = rest.split('/')[0];
				if (rest !== name) out.set(name, 'directory');
				else out.set(name, value instanceof Uint8Array || typeof value === 'string' || 'lfs' in value ? 'file' : value.type);
			}
			return [...out].map(([name, type]) => ({ name, type }));
		},
		async readFile(path, options) {
			reads.push(path);
			const value = entryAt(path);
			if (typeof value === 'string') return enc(value);
			if (value instanceof Uint8Array) return value;
			if (value !== undefined && 'lfs' in value) {
				if (options?.lfs === 'pointer') return enc(lfsPointer(value.lfs));
				downloads.push(path);
				return enc(value.lfs);
			}
			throw new Error(`not a file: ${path}`);
		},
		async stat(path) {
			const value = entryAt(path);
			if (typeof value === 'string') return { size: enc(value).length };
			if (value instanceof Uint8Array) return { size: value.length };
			if (value !== undefined && 'lfs' in value) return { size: lfsPointer(value.lfs).length };
			throw new Error(`not a file: ${path}`);
		},
	};
}

async function run(tree: Tree, query: Partial<TextQuery> & { pattern: string }, extra: Partial<TextSearchEngineOptions> = {}) {
	const results: EngineResult[] = [];
	const summary = await searchText(memorySource(tree), {
		query,
		root: '',
		maxResults: 1000,
		isCancelled: () => false,
		onResult: (r) => results.push(r),
		...extra,
	});
	return { results, summary, matches: results.filter((r): r is EngineMatch => r.kind === 'match') };
}

const pos = (line: number, character: number) => ({ line, character });

const BAD_ENCODING = '1 file(s) are not valid UTF-8 or UTF-16 with a byte order mark and were skipped.';

describe('glob', () => {
	const m = (glob: string, path: string) => compileGlob(glob)!.test(path);
	it('matches basenames at any depth without a slash', () => {
		assert.ok(m('*.ts', 'a.ts'));
		assert.ok(m('*.ts', 'src/deep/a.ts'));
		assert.ok(!m('*.ts', 'a.tsx'));
	});
	it('supports **, ?, classes and braces', () => {
		assert.ok(m('src/**/*.ts', 'src/a.ts'));
		assert.ok(m('src/**/*.ts', 'src/x/y/a.ts'));
		assert.ok(!m('src/*.ts', 'src/x/a.ts'));
		assert.ok(m('**/*.{js,ts}', 'a/b.js'));
		assert.ok(m('a?.txt', 'ab.txt'));
		assert.ok(m('[ab].txt', 'b.txt'));
		assert.ok(!m('[!ab].txt', 'b.txt'));
	});
});

describe('walkFiles', () => {
	const tree: Tree = {
		'b.txt': 'b',
		'a.txt': 'a',
		'src/x.ts': 'x',
		'node_modules/p/i.js': 'i',
		link: { type: 'symlink' },
		sub: { type: 'submodule' },
	};
	const walk = async (opts: Record<string, unknown> = {}) => {
		const seen: string[] = [];
		const summary = await walkFiles(memorySource(tree), { root: '', maxFiles: 100, isCancelled: () => false, ...opts }, async (p) => {
			seen.push(p);
		});
		return { seen, summary };
	};

	it('walks in name order and ignores symlinks and submodules', async () => {
		assert.deepEqual((await walk()).seen, ['a.txt', 'b.txt', 'node_modules/p/i.js', 'src/x.ts']);
	});
	it('prunes excluded directories and applies includes', async () => {
		assert.deepEqual((await walk({ excludes: ['node_modules'] })).seen, ['a.txt', 'b.txt', 'src/x.ts']);
		assert.deepEqual((await walk({ includes: ['src/**'] })).seen, ['src/x.ts']);
		assert.deepEqual((await walk({ includes: ['*.txt'], excludes: ['b.*'] })).seen, ['a.txt']);
	});
	it('enforces the file budget', async () => {
		const { seen, summary } = await walk({ maxFiles: 2 });
		assert.deepEqual(seen, ['a.txt', 'b.txt']);
		assert.equal(summary.filesTruncated, true);
	});
	it('starts below a root', async () => {
		assert.deepEqual((await walk({ root: 'src' })).seen, ['x.ts']);
	});
	it('stops on cancellation', async () => {
		let n = 0;
		const { seen, summary } = await walk({ isCancelled: () => n++ >= 1 });
		assert.equal(seen.length, 1);
		assert.equal(summary.cancelled, true);
	});
});

describe('file search', () => {
	const tree: Tree = Object.fromEntries(
		['src/search.ts', 'src/overlay.ts', 'docs/research.md', 'README.md', 'src/s/e/a/r/c/h.txt', 'lib/other.ts'].map((p) => [p, '']),
	);
	const find = async (pattern: string, extra = {}) =>
		(await searchFiles(memorySource(tree), { pattern, root: '', isCancelled: () => false, ...extra })).paths;

	it('returns every file for an empty query, sorted', async () => {
		assert.deepEqual(await find(''), [
			'README.md',
			'docs/research.md',
			'lib/other.ts',
			'src/overlay.ts',
			'src/s/e/a/r/c/h.txt',
			'src/search.ts',
		]);
	});
	it('matches subsequences case-insensitively and ranks basename matches first', async () => {
		const paths = await find('SEARCH');
		assert.equal(paths[0], 'src/search.ts');
		assert.ok(paths.includes('docs/research.md'));
		assert.ok(!paths.includes('lib/other.ts'));
		assert.ok(paths.includes('src/s/e/a/r/c/h.txt'));
	});
	it('is deterministic and honors maxResults, filters and slashes', async () => {
		assert.deepEqual(await find('ts'), await find('ts'));
		assert.equal((await find('', { maxResults: 2 })).length, 2);
		assert.deepEqual(await find('src/ov'), ['src/overlay.ts']);
		assert.deepEqual(await find('', { excludes: ['src', 'docs'] }), ['README.md', 'lib/other.ts']);
	});
	it('scores non-matches as undefined', () => {
		assert.equal(scoreFilePath('xyz', 'src/a.ts'), undefined);
	});
});

describe('regex building', () => {
	it('escapes plain text and honors case', () => {
		assert.ok(buildRegExp({ pattern: 'a.b' }).test('A.B'));
		assert.ok(!buildRegExp({ pattern: 'a.b' }).test('axb'));
		assert.ok(!buildRegExp({ pattern: 'a.b', isCaseSensitive: true }).test('A.B'));
	});
	it('applies whole word only at word-character edges', () => {
		const re = (p: string, extra: Partial<TextQuery> = {}) => buildRegExp({ pattern: p, isWordMatch: true, ...extra });
		assert.ok(re('foo').test('a foo b'));
		assert.ok(!re('foo').test('foobar'));
		assert.ok(re('foo.').test('x foo. y') );
		assert.ok(!re('\\w+oo', { isRegExp: true }).test('') );
	});
	it('rejects invalid regular expressions', () => {
		assert.throws(() => buildRegExp({ pattern: '(', isRegExp: true }), InvalidQueryError);
	});
});

describe('text decoding', () => {
	it('rejects NUL and invalid UTF-8, drops a BOM', () => {
		assert.deepEqual(decodeFile(new Uint8Array([97, 0, 98])), { skipped: 'binary' });
		assert.deepEqual(decodeFile(new Uint8Array([0xff, 0xfe, 0x41])), { skipped: 'encoding' });
		assert.deepEqual(decodeFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), { text: 'A' });
	});
	it('splits on all line terminators', () => {
		assert.deepEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
	});
});

describe('findMatches', () => {
	it('uses UTF-16 offsets', () => {
		const lines = splitLines('\u{1F600}x\u{1F600}x');
		const [first, second] = findMatches(lines, buildRegExp({ pattern: 'x' }), false, 10);
		assert.deepEqual(first.start, pos(0, 2));
		assert.deepEqual(second.end, pos(0, 6));
	});
	it('reports the correct range for multiline matches, including CRLF files', () => {
		const lines = splitLines('one\r\ntwo\r\nthree');
		const [r] = findMatches(lines, buildRegExp({ pattern: 'e\ntwo\nth', isCaseSensitive: true }), true, 10);
		assert.deepEqual(r, { start: pos(0, 2), end: pos(2, 2) });
	});
	it('keeps matches within a line when not multiline', () => {
		const lines = splitLines('a\nb');
		assert.equal(findMatches(lines, buildRegExp({ pattern: 'a\\sb', isRegExp: true }), false, 10).length, 0);
		assert.equal(findMatches(lines, buildRegExp({ pattern: 'a\\sb', isRegExp: true }), true, 10).length, 1);
	});
	it('skips empty matches and supports ^ and $ per line', () => {
		const lines = splitLines('ab\ncd');
		assert.equal(findMatches(lines, buildRegExp({ pattern: 'x*', isRegExp: true }), false, 10).length, 0);
		assert.deepEqual(findMatches(lines, buildRegExp({ pattern: '^c', isRegExp: true }), true, 10)[0].start, pos(1, 0));
	});
});

describe('searchText', () => {
	const tree: Tree = {
		'a.txt': 'hello world\nfoo hello\nbye',
		'b.txt': 'nothing',
		'src/c.ts': 'const hello = 1; hello++;',
		'bin.dat': new Uint8Array([104, 101, 108, 108, 111, 0]),
		'bad.txt': new Uint8Array([104, 101, 108, 108, 111, 0xff]),
		link: { type: 'symlink' },
	};

	it('streams matches in path order with grouped ranges and previews', async () => {
		const { matches, summary } = await run(tree, { pattern: 'hello' });
		assert.deepEqual(
			matches.map((m) => [m.path, m.ranges[0].start.line, m.ranges.length]),
			[
				['a.txt', 0, 1],
				['a.txt', 1, 1],
				['src/c.ts', 0, 2],
			],
		);
		assert.equal(matches[2].preview.text, 'const hello = 1; hello++;');
		assert.deepEqual(matches[2].preview.matches[1], { start: pos(0, 17), end: pos(0, 22) });
		assert.equal(summary.limitHit, false);
		assert.deepEqual(summary.warnings, [BAD_ENCODING], 'bad.txt is not valid UTF-8 and is reported');
		assert.equal(summary.filesScanned, 3);
	});
	it('does not search Git LFS files, downloads nothing for them and says so', async () => {
		const withLfs: Tree = { ...tree, 'big.bin': { lfs: 'hello from the large object\n' } };
		const source = memorySource(withLfs);
		const results: EngineResult[] = [];
		const summary = await searchText(source, { query: { pattern: 'hello' }, root: '', maxResults: 1000, isCancelled: () => false, onResult: (r) => results.push(r) });
		assert.ok(!results.some((r) => r.path === 'big.bin'));
		assert.deepEqual(source.downloads, []);
		assert.equal(summary.filesScanned, 3);
		assert.deepEqual(summary.warnings, [BAD_ENCODING, '1 Git LFS file(s) were not searched; LFS objects are not downloaded for search.']);
		const pointerText = await run(withLfs, { pattern: 'oid sha256' });
		assert.deepEqual(pointerText.matches, [], 'pointer text is not content');
		assert.deepEqual(pointerText.summary.warnings.length, 2);
	});
	it('does not count an LFS file against the byte budget', async () => {
		const { summary } = await run({ 'big.bin': { lfs: 'x'.repeat(100) }, 'a.txt': 'hello' }, { pattern: 'hello' }, { limits: { maxBytes: 10 } });
		assert.equal(summary.bytesScanned, 5);
		assert.ok(!summary.warnings.some((w) => /stopped after/.test(w)));
	});
	it('skips binary and invalid UTF-8 files', async () => {
		const { matches } = await run(tree, { pattern: 'hello' });
		assert.ok(!matches.some((m) => m.path === 'bin.dat' || m.path === 'bad.txt'));
	});
	it('applies include and exclude globs', async () => {
		assert.deepEqual((await run(tree, { pattern: 'hello' }, { includes: ['*.ts'] })).matches.map((m) => m.path), ['src/c.ts']);
		assert.deepEqual(
			[...new Set((await run(tree, { pattern: 'hello' }, { excludes: ['src'] })).matches.map((m) => m.path))],
			['a.txt'],
		);
	});
	it('caps results and sets limitHit', async () => {
		const { matches, summary } = await run(tree, { pattern: 'hello' }, { maxResults: 2 });
		assert.equal(matches.reduce((n, m) => n + m.ranges.length, 0), 2);
		assert.equal(summary.limitHit, true);
		const exact = await run(tree, { pattern: 'hello' }, { maxResults: 4 });
		assert.equal(exact.summary.limitHit, false);
	});
	it('reports multiline matches with a multi-line preview', async () => {
		const { matches } = await run(tree, { pattern: 'world\nfoo', isMultiline: true });
		assert.equal(matches.length, 1);
		assert.deepEqual(matches[0].ranges[0], { start: pos(0, 6), end: pos(1, 3) });
		assert.equal(matches[0].preview.text, 'hello world\nfoo hello');
		assert.deepEqual(matches[0].preview.matches[0], { start: pos(0, 6), end: pos(1, 3) });
	});
	it('applies previewOptions', async () => {
		const long = `${'x'.repeat(100)}needle${'y'.repeat(100)}`;
		const { matches } = await run({ 'l.txt': long }, { pattern: 'needle' }, { previewOptions: { matchLines: 1, charsPerLine: 30 } });
		const [m] = matches;
		assert.ok(m.preview.text.length <= 30);
		const r = m.preview.matches[0];
		assert.equal(m.preview.text.slice(r.start.character, r.end.character), 'needle');
		assert.deepEqual(m.ranges[0], { start: pos(0, 100), end: pos(0, 106) });
	});
	it('emits context lines without duplicates', async () => {
		const t: Tree = { 'f.txt': 'l0\nl1\nhit\nl3\nhit\nl5\nl6\nl7' };
		const { results } = await run(t, { pattern: 'hit' }, { beforeContext: 1, afterContext: 2 });
		assert.deepEqual(
			results.map((r) => (r.kind === 'context' ? `c${r.lineNumber}` : `m${r.ranges[0].start.line}`)),
			['c1', 'm2', 'c3', 'm4', 'c5', 'c6'],
		);
	});
	it('enforces maxFileSize before reading', async () => {
		const source = memorySource({ 'big.txt': 'hello'.repeat(100), 'small.txt': 'hello' });
		const out: EngineResult[] = [];
		await searchText(source, { query: { pattern: 'hello' }, root: '', maxResults: 10, maxFileSize: 10, isCancelled: () => false, onResult: (r) => out.push(r) });
		assert.deepEqual(source.reads, ['small.txt']);
		assert.equal(out.length, 1);
	});
	it('warns when the file budget is hit', async () => {
		const { summary } = await run(tree, { pattern: 'hello' }, { limits: { maxFiles: 1 } });
		assert.equal(summary.warnings.length, 1);
		assert.match(summary.warnings[0], /first 1 files/);
	});
	it('warns and stops when the byte budget is hit', async () => {
		const { summary, matches } = await run(tree, { pattern: 'hello' }, { limits: { maxBytes: 30 } });
		assert.ok(summary.bytesScanned <= 30);
		assert.ok(summary.warnings.some((w) => /partial/.test(w)));
		assert.deepEqual(matches.map((m) => m.path), ['a.txt', 'a.txt']);
	});
	it('warns on unsupported encodings and returns nothing for an empty pattern', async () => {
		assert.match((await run(tree, { pattern: 'hello' }, { encoding: 'shiftjis' })).summary.warnings[0], /not supported/);
		assert.equal((await run(tree, { pattern: '' })).results.length, 0);
		assert.deepEqual((await run(tree, { pattern: 'hello' }, { encoding: 'utf8bom' })).summary.warnings, [BAD_ENCODING]);
	});
	it('counts unreadable files and keeps going', async () => {
		const source = memorySource({ 'a.txt': 'hello', 'b.txt': 'hello' });
		const read = source.readFile;
		source.readFile = async (p) => {
			if (p === 'a.txt') throw new Error('boom');
			return read(p);
		};
		const out: EngineResult[] = [];
		const summary = await searchText(source, { query: { pattern: 'hello' }, root: '', maxResults: 10, isCancelled: () => false, onResult: (r) => out.push(r) });
		assert.equal(out.length, 1);
		assert.match(summary.warnings[0], /1 file/);
	});
	it('stops on cancellation', async () => {
		let calls = 0;
		const { summary, matches } = await run(tree, { pattern: 'hello' }, { isCancelled: () => calls++ > 1 });
		assert.equal(summary.cancelled, true);
		assert.ok(matches.length < 3);
	});
	it('throws InvalidQueryError for a bad regex', async () => {
		await assert.rejects(run(tree, { pattern: '(', isRegExp: true }), InvalidQueryError);
	});
	it('searches below a root and reports paths relative to it', async () => {
		const { matches } = await run(tree, { pattern: 'hello' }, { root: 'src' });
		assert.deepEqual(matches.map((m) => m.path), ['c.ts']);
	});
});

describe('whole-word alternation', () => {
	it('keeps every alternative inside the word boundaries', () => {
		const regex = buildRegExp({ pattern: 'foo|bar', isRegExp: true, isWordMatch: true });
		assert.deepEqual('foobaz bar xfoo foo'.match(regex)?.map((m) => m), ['bar', 'foo']);
	});
});

describe('glob limits', () => {
	it('refuses a glob whose brace expansion is exponential', () => {
		assert.equal(compileGlob('{a,b}'.repeat(12)), undefined);
		assert.ok(compileGlob('{a,b}{c,d}.ts'));
	});
	it('bounds the compiled glob cache', () => {
		const first = compileGlob('first-*.ts');
		assert.equal(compileGlob('first-*.ts'), first);
		for (let i = 0; i < 1000; i++) compileGlob(`g${i}-*.ts`);
		assert.notEqual(compileGlob('first-*.ts'), first, 'oldest entries are dropped');
	});
});

describe('directory pruning', () => {
	const tree: Tree = { 'src/a.ts': 'a', 'src/lib/b.ts': 'b', 'docs/c.md': 'c', 'node_modules/p/q/i.js': 'i', 'top.txt': 't' };
	async function listed(filters: { includes?: string[]; excludes?: string[] }) {
		const dirs: string[] = [];
		const source = memorySource(tree);
		const seen: string[] = [];
		await walkFiles({ readDirectory: async (d) => (dirs.push(d), source.readDirectory(d)) }, { root: '', maxFiles: 100, isCancelled: () => false, ...filters }, async (p) => {
			seen.push(p);
		});
		return { dirs, seen };
	}
	it('does not list a directory excluded by dir/**', async () => {
		const { dirs, seen } = await listed({ excludes: ['node_modules/**'] });
		assert.ok(!dirs.some((d) => d.startsWith('node_modules')), dirs.join(','));
		assert.deepEqual(seen, ['docs/c.md', 'src/a.ts', 'src/lib/b.ts', 'top.txt']);
	});
	it('does not list directories that cannot hold an included path', async () => {
		const { dirs, seen } = await listed({ includes: ['src/**'] });
		assert.deepEqual(dirs, ['', 'src', 'src/lib']);
		assert.deepEqual(seen, ['src/a.ts', 'src/lib/b.ts']);
	});
	it('still reaches deep literal includes and never prunes any-depth globs', async () => {
		assert.deepEqual((await listed({ includes: ['src/lib/b.ts'] })).seen, ['src/lib/b.ts']);
		assert.deepEqual((await listed({ includes: ['*.md'] })).seen, ['docs/c.md']);
		assert.deepEqual((await listed({ includes: ['{docs,src/lib}/**'] })).dirs, ['', 'docs', 'src', 'src/lib']);
	});
});

describe('search summaries', () => {
	it('lists more than the text search file limit for Quick Open', async () => {
		const files: Tree = {};
		for (let i = 0; i < 10_500; i++) files[`f${i}.txt`] = '';
		const { paths, summary } = await searchFiles(memorySource(files), { pattern: '', root: '', isCancelled: () => false });
		assert.equal(paths.length, 10_500);
		assert.equal(summary.filesTruncated, false);
	});
	it('counts directories that cannot be listed and warns', async () => {
		const source = memorySource({ 'ok/a.txt': 'hello', 'bad/b.txt': 'hello' });
		const list = source.readDirectory;
		source.readDirectory = async (d) => {
			if (d === 'bad') throw new Error('denied');
			return list(d);
		};
		const out: EngineResult[] = [];
		const summary = await searchText(source, { query: { pattern: 'hello' }, root: '', maxResults: 10, isCancelled: () => false, onResult: (r) => out.push(r) });
		assert.equal(out.length, 1);
		assert.ok(summary.warnings.some((w) => /1 folder\(s\) could not be listed/.test(w)), summary.warnings.join('|'));
	});
	it('does not charge binary files against the text budget', async () => {
		const binary = new Uint8Array(10);
		const tree: Tree = { 'a.bin': binary, 'b.bin': binary, 'c.bin': binary, 'd.txt': 'hello' };
		const { matches, summary } = await run(tree, { pattern: 'hello' }, { limits: { maxBytes: 25 } });
		assert.deepEqual(matches.map((m) => m.path), ['d.txt']);
		assert.deepEqual(summary.warnings, []);
		assert.equal(summary.bytesScanned, 5);
	});
	it('decodes UTF-16 with a byte order mark and warns about other undecodable files', async () => {
		const utf16 = new Uint8Array([0xff, 0xfe, ...[...'say hello'].flatMap((c) => [c.charCodeAt(0), 0])]);
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
		const { matches, summary } = await run({ 'u.txt': utf16, 'l.txt': latin1 }, { pattern: 'hello' });
		assert.deepEqual(matches.map((m) => m.path), ['u.txt']);
		assert.deepEqual(matches[0].ranges, [{ start: pos(0, 4), end: pos(0, 9) }]);
		assert.ok(summary.warnings.some((w) => /1 file\(s\) are not valid UTF-8/.test(w)), summary.warnings.join('|'));
	});
});

describe('regular expression limits', () => {
	it('skips very long lines for a regular expression and warns, but not for a literal query', async () => {
		const tree: Tree = { 'min.js': `${'x'.repeat(20_000)}needle`, 'ok.js': 'needle' };
		const regex = await run(tree, { pattern: 'needle', isRegExp: true });
		assert.deepEqual(regex.matches.map((m) => m.path), ['ok.js']);
		assert.ok(regex.summary.warnings.some((w) => /1 line\(s\) longer than 10000/.test(w)), regex.summary.warnings.join('|'));
		const literal = await run(tree, { pattern: 'needle' });
		assert.deepEqual(literal.matches.map((m) => m.path), ['min.js', 'ok.js']);
	});
	it('stops scanning a file after the per-file time limit and warns', async () => {
		const text = `${'x\n'.repeat(1000)}needle`;
		let clock = 0;
		const { matches, summary } = await run({ 'big.txt': text }, { pattern: 'needle', isRegExp: true }, { limits: { maxFileMs: 100 }, now: () => clock++ });
		assert.deepEqual(matches, []);
		assert.ok(summary.warnings.some((w) => /partly searched/.test(w)), summary.warnings.join('|'));
		const quick = await run({ 'big.txt': text }, { pattern: 'needle', isRegExp: true }, { now: () => 0 });
		assert.equal(quick.matches.length, 1);
	});
});
