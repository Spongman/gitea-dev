import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
	AssetError,
	BundledAssets,
	CachedDownloadAssets,
	extractArchive,
	installArchive,
	loadPin,
	parsePin,
	validateAssets,
	type AssetPin,
	type CachedDownloadAssetsOptions,
} from '../packages/asset-provider/src/index.js';

import { DEFAULT_LOCK, withLock } from '../packages/asset-provider/src/lock.js';
import { DEFAULT_DOWNLOAD_TIMEOUT_MS } from '../packages/asset-provider/src/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.2.3';
const COMMIT = 'a'.repeat(40);

// ---- tar fixture builder (raw ustar so malicious entries are expressible)

interface Entry {
	path: string;
	data?: string | Buffer;
	type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo';
	linkpath?: string;
	mode?: number;
}

const TYPEFLAG = { file: '0', dir: '5', symlink: '2', hardlink: '1', fifo: '6' } as const;

function tarHeader(entry: Entry, size: number): Buffer {
	const block = Buffer.alloc(512);
	const type = entry.type ?? 'file';
	const put = (value: string, offset: number, length: number) => {
		block.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
	};
	put(entry.path, 0, 100);
	put(`${(entry.mode ?? (type === 'dir' ? 0o755 : 0o644)).toString(8).padStart(7, '0')}\0`, 100, 8);
	put('0000000\0', 108, 8);
	put('0000000\0', 116, 8);
	put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
	put('00000000000\0', 136, 12);
	put('        ', 148, 8);
	put(TYPEFLAG[type], 156, 1);
	put(entry.linkpath ?? '', 157, 100);
	put('ustar\0', 257, 6);
	put('00', 263, 2);
	const sum = block.reduce((total, byte) => total + byte, 0);
	put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
	return block;
}

function buildTar(entries: Entry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const data = entry.type === undefined || entry.type === 'file' ? Buffer.from(entry.data ?? '') : Buffer.alloc(0);
		parts.push(tarHeader(entry, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function validEntries(version = VERSION): Entry[] {
	const files: Record<string, string> = {
		'package.json': JSON.stringify({ name: 'Code', version }),
		'out/nls.messages.js': 'globalThis._VSCODE_NLS_MESSAGES=[];',
		'out/vs/workbench/workbench.web.main.internal.js': '// workbench',
		'out/vs/workbench/workbench.web.main.internal.css': '/* css */',
		'out/vs/workbench/api/worker/extensionHostWorkerMain.js': '// worker',
		'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html': '<html>',
		'out/vs/workbench/contrib/webview/browser/pre/index.html': '<html>',
		'node_modules/vscode-oniguruma/release/main.js': '// onig',
		'node_modules/vscode-oniguruma/release/onig.wasm': 'wasm',
		'node_modules/vscode-textmate/release/main.js': '// textmate',
		'node_modules/@vscode/codicons/dist/codicon.ttf': 'font',
		// Third-party helper scripts ship executable; they must come out non-executable.
		'node_modules/opentype.js/bin/ot': '#!/usr/bin/env node\n',
	};
	const entries: Entry[] = [{ path: 'vscode-web/', type: 'dir' }];
	for (const [path, data] of Object.entries(files)) {
		entries.push({ path: `vscode-web/${path}`, data, mode: path.endsWith('/ot') ? 0o755 : 0o644 });
	}
	return entries;
}

interface Fixture {
	dir: string;
	archive: string;
	bytes: Buffer;
	pin: AssetPin;
	cacheDir: string;
}

async function tempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'assets-test-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function fixture(
	t: TestContext,
	entries: Entry[] = validEntries(),
	overrides: Partial<AssetPin> = {},
): Promise<Fixture> {
	const dir = await tempDir(t);
	const bytes = gzipSync(buildTar(entries));
	const archive = join(dir, 'workbench.tar.gz');
	await writeFile(archive, bytes);
	const pin: AssetPin = {
		version: VERSION,
		commit: COMMIT,
		url: pathToFileURL(archive).href,
		sha256: sha(bytes),
		...overrides,
	};
	return { dir, archive, bytes, pin, cacheDir: join(dir, 'cache') };
}

function provider(fx: Fixture, extra: Partial<CachedDownloadAssetsOptions> = {}, pin = fx.pin) {
	return new CachedDownloadAssets({ cacheDir: fx.cacheDir, pin, allowFileUrls: true, ...extra });
}

// https pin served by a counting fake fetch.
function httpsFixtureFetch(bytes: Buffer, counter: { calls: number }): typeof fetch {
	return (async () => {
		counter.calls++;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } });
	}) as typeof fetch;
}

const HTTPS_URL = 'https://example.test/vscode-web.tar.gz';

async function assertRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof AssetError, `expected AssetError, got ${String(error)}`);
		assert.equal(error.code, code, error.message);
		return true;
	});
}

async function listVersions(cacheDir: string): Promise<string[]> {
	return readdir(join(cacheDir, 'versions')).catch(() => []);
}

// ---- pin config

test('pin: accepts explicit https pin and normalizes digest case', () => {
	const pin = parsePin({ version: VERSION, commit: COMMIT, url: HTTPS_URL, sha256: 'AB'.repeat(32) });
	assert.equal(pin.sha256, 'ab'.repeat(32));
});

test('pin: rejects latest, bad digest, bad commit, http, creds, unknown keys, file without opt-in', () => {
	const ok = { version: VERSION, commit: COMMIT, url: HTTPS_URL, sha256: 'a'.repeat(64) };
	const bad: Record<string, unknown>[] = [
		{ ...ok, version: 'latest' },
		{ ...ok, version: '1.2' },
		{ ...ok, sha256: 'a'.repeat(63) },
		{ ...ok, sha256: 'g'.repeat(64) },
		{ ...ok, commit: 'main' },
		{ ...ok, url: 'http://example.test/x.tar.gz' },
		{ ...ok, url: 'https://user:pw@example.test/x.tar.gz' },
		{ ...ok, url: 'file:///tmp/x.tar.gz' },
		{ ...ok, channel: 'stable' },
	];
	for (const value of bad) assert.throws(() => parsePin(value), (e) => e instanceof AssetError && e.code === 'bad-pin');
	assert.doesNotThrow(() => parsePin({ ...ok, url: 'file:///tmp/x.tar.gz' }, { allowFileUrls: true }));
});

test('pin: repository config/workbench.json is a valid pin', async () => {
	const pin = await loadPin(join(repoRoot, 'config', 'workbench.json'));
	assert.match(pin.sha256, /^[0-9a-f]{64}$/);
});

// ---- happy path

test('cached: installs verified archive, strips prefix, writes trusted manifest, drops exec bits', async (t) => {
	const fx = await fixture(t);
	const result = await provider(fx).ensure(VERSION);
	assert.equal(result.version, VERSION);
	assert.equal(result.commit, COMMIT);
	assert.equal(result.integrity, `sha256:${fx.pin.sha256}`);
	assert.equal(result.fallback, undefined);
	assert.equal(result.root, join(fx.cacheDir, 'versions', COMMIT));

	const manifest = JSON.parse(await readFile(join(result.root, 'workbench-assets.json'), 'utf8'));
	assert.deepEqual(manifest, {
		schema: 1,
		version: VERSION,
		commit: COMMIT,
		clientOnly: true,
		integrity: result.integrity,
	});
	assert.ok(existsSync(join(result.root, 'out/vs/workbench/workbench.web.main.internal.js')));
	assert.ok(!existsSync(join(result.root, 'vscode-web')));
	const script = await lstat(join(result.root, 'node_modules/opentype.js/bin/ot'));
	assert.equal(script.mode & 0o111, 0);
	assert.equal(await readlink(join(fx.cacheDir, 'current')), join('versions', COMMIT));
	assert.deepEqual(await listVersions(fx.cacheDir), [COMMIT]);
	await validateAssets(result.root);
});

test('cached: second ensure is served from cache without downloading', async (t) => {
	const fx = await fixture(t);
	const counter = { calls: 0 };
	const https = { ...fx.pin, url: HTTPS_URL };
	const make = () => new CachedDownloadAssets({ cacheDir: fx.cacheDir, pin: https, fetch: httpsFixtureFetch(fx.bytes, counter) });
	await make().ensure(VERSION);
	await make().ensure(VERSION);
	assert.equal(counter.calls, 1);
});

test('cached: ensure for a version other than the pin is refused, even with a cached install', async (t) => {
	const fx = await fixture(t);
	const assets = provider(fx);
	await assets.ensure(VERSION);
	await assertRejectsCode(assets.ensure('latest'), 'version-mismatch');
	await assertRejectsCode(assets.ensure('9.9.9'), 'version-mismatch');
});

// ---- checksum

test('cached: checksum mismatch fails before extraction and leaves no artifacts', async (t) => {
	const fx = await fixture(t);
	const counter = { calls: 0 };
	const wrong = { ...fx.pin, url: HTTPS_URL, sha256: '0'.repeat(64) };
	const assets = new CachedDownloadAssets({ cacheDir: fx.cacheDir, pin: wrong, fetch: httpsFixtureFetch(fx.bytes, counter) });
	await assertRejectsCode(assets.ensure(VERSION), 'checksum');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
	assert.deepEqual(await readdir(join(fx.cacheDir, 'downloads')), []);
	assert.equal(existsSync(join(fx.cacheDir, 'current')), false);
});

test('cached: file:// archive with wrong digest is rejected', async (t) => {
	const fx = await fixture(t, validEntries(), { sha256: '1'.repeat(64) });
	await assertRejectsCode(provider(fx).ensure(VERSION), 'checksum');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
});

test('cached: file:// pin is refused unless explicitly allowed', async (t) => {
	const fx = await fixture(t);
	assert.throws(() => new CachedDownloadAssets({ cacheDir: fx.cacheDir, pin: fx.pin }), (e) => e instanceof AssetError && e.code === 'bad-pin');
});

test('cached: HTTP error, redirect to http, and oversize content-length fail cleanly', async (t) => {
	const fx = await fixture(t);
	const https = { ...fx.pin, url: HTTPS_URL };
	const cases: [string, typeof fetch, string][] = [
		['http-status', (async () => new Response('nope', { status: 503 })) as typeof fetch, 'download'],
		[
			'http-redirect',
			(async () => {
				const response = new Response(new Uint8Array(fx.bytes));
				Object.defineProperty(response, 'url', { value: 'http://evil.test/x' });
				return response;
			}) as typeof fetch,
			'download',
		],
		[
			'content-length',
			(async () => new Response(new Uint8Array(fx.bytes), { headers: { 'content-length': '999999999999' } })) as typeof fetch,
			'limit',
		],
	];
	for (const [name, fakeFetch, code] of cases) {
		const cacheDir = join(fx.dir, name);
		await assertRejectsCode(new CachedDownloadAssets({ cacheDir, pin: https, fetch: fakeFetch }).ensure(VERSION), code);
		assert.deepEqual(await listVersions(cacheDir), [], name);
	}
});

// ---- limits

test('limits: compressed, unpacked and entry-count limits are enforced', async (t) => {
	const fx = await fixture(t);
	await assertRejectsCode(provider(fx, { limits: { maxCompressedBytes: 64 } }).ensure(VERSION), 'limit');
	await assertRejectsCode(
		provider(fx, { cacheDir: join(fx.dir, 'c2'), limits: { maxUnpackedBytes: 16 } }).ensure(VERSION),
		'limit',
	);
	await assertRejectsCode(
		provider(fx, { cacheDir: join(fx.dir, 'c3'), limits: { maxEntries: 3 } }).ensure(VERSION),
		'limit',
	);
	for (const name of ['cache', 'c2', 'c3']) assert.deepEqual(await listVersions(join(fx.dir, name)), []);
});

test('limits: streaming download stops at the compressed limit', async (t) => {
	const fx = await fixture(t);
	const assets = new CachedDownloadAssets({
		cacheDir: fx.cacheDir,
		pin: { ...fx.pin, url: HTTPS_URL },
		limits: { maxCompressedBytes: 100 },
		// No content-length: only the streaming meter can catch this.
		fetch: (async () => new Response(new Uint8Array(fx.bytes))) as typeof fetch,
	});
	await assertRejectsCode(assets.ensure(VERSION), 'limit');
	assert.deepEqual(await readdir(join(fx.cacheDir, 'downloads')), []);
});

// ---- unsafe archives

const withEntry = (extra: Entry[]): Entry[] => [...validEntries(), ...extra];

const UNSAFE: [string, Entry[], string][] = [
	['parent traversal', withEntry([{ path: 'vscode-web/../evil.txt', data: 'x' }]), 'unsafe-archive'],
	['traversal outside prefix', withEntry([{ path: '../evil.txt', data: 'x' }]), 'unsafe-archive'],
	['deep traversal', withEntry([{ path: 'vscode-web/a/../../../evil.txt', data: 'x' }]), 'unsafe-archive'],
	['absolute path', withEntry([{ path: '/tmp/assets-evil.txt', data: 'x' }]), 'unsafe-archive'],
	['backslash path', withEntry([{ path: 'vscode-web\\evil.txt', data: 'x' }]), 'unsafe-archive'],
	['backslash traversal', withEntry([{ path: 'vscode-web/..\\evil.txt', data: 'x' }]), 'unsafe-archive'],
	['drive letter', withEntry([{ path: 'C:/evil.txt', data: 'x' }]), 'unsafe-archive'],
	['empty segment', withEntry([{ path: 'vscode-web//evil.txt', data: 'x' }]), 'unsafe-archive'],
	['dot segment', withEntry([{ path: 'vscode-web/./evil.txt', data: 'x' }]), 'unsafe-archive'],
	['wrong prefix', withEntry([{ path: 'other/evil.txt', data: 'x' }]), 'unsafe-archive'],
	['symlink', withEntry([{ path: 'vscode-web/link', type: 'symlink', linkpath: '/etc' }]), 'unsafe-archive'],
	['relative symlink', withEntry([{ path: 'vscode-web/link', type: 'symlink', linkpath: '../..' }]), 'unsafe-archive'],
	['hardlink', withEntry([{ path: 'vscode-web/hl', type: 'hardlink', linkpath: 'vscode-web/package.json' }]), 'unsafe-archive'],
	['fifo', withEntry([{ path: 'vscode-web/pipe', type: 'fifo' }]), 'unsafe-archive'],
	['case-colliding duplicate', withEntry([{ path: 'vscode-web/PACKAGE.json', data: '{}' }]), 'unsafe-archive'],
	['exact duplicate', withEntry([{ path: 'vscode-web/package.json', data: '{}' }]), 'unsafe-archive'],
	['file used as directory', withEntry([{ path: 'vscode-web/package.json/x', data: '{}' }]), 'unsafe-archive'],
	['archive-supplied manifest', withEntry([{ path: 'vscode-web/workbench-assets.json', data: '{}' }]), 'unsafe-archive'],
	['server-cli.js', withEntry([{ path: 'vscode-web/out/server-cli.js', data: '//' }]), 'unsafe-archive'],
	['bootstrap-fork.js', withEntry([{ path: 'vscode-web/out/bootstrap-fork.js', data: '//' }]), 'unsafe-archive'],
	['server-main.js', withEntry([{ path: 'vscode-web/out/server-main.js', data: '//' }]), 'unsafe-archive'],
	['out/vs/server', withEntry([{ path: 'vscode-web/out/vs/server/node/server.main.js', data: '//' }]), 'unsafe-archive'],
	['bundled node binary', withEntry([{ path: 'vscode-web/node', data: 'x' }]), 'unsafe-archive'],
	['server bin dir', withEntry([{ path: 'vscode-web/bin/code-server', data: '#!/bin/sh' }]), 'unsafe-archive'],
	['native addon', withEntry([{ path: 'vscode-web/node_modules/x/build/x.node', data: 'x' }]), 'unsafe-archive'],
	['node-pty', withEntry([{ path: 'vscode-web/node_modules/node-pty/lib/index.js', data: '//' }]), 'unsafe-archive'],
];

for (const [name, entries, code] of UNSAFE) {
	test(`unsafe archive rejected: ${name}`, async (t) => {
		const fx = await fixture(t, entries);
		const before = await readdir(fx.dir);
		await assertRejectsCode(provider(fx, { fallback: false }).ensure(VERSION), code);
		assert.deepEqual(await listVersions(fx.cacheDir), []);
		assert.equal(existsSync(join(fx.cacheDir, 'current')), false);
		// Nothing was written next to the cache (traversal sentinel).
		assert.deepEqual((await readdir(fx.dir)).filter((n) => !before.includes(n)), ['cache']);
		assert.equal(existsSync('/tmp/assets-evil.txt'), false);
	});
}

test('unsafe archive rejected: binary content hidden behind an innocent name', async (t) => {
	const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
	const fx = await fixture(t, withEntry([{ path: 'vscode-web/out/helper.bin', data: elf }]));
	await assertRejectsCode(provider(fx, { fallback: false }).ensure(VERSION), 'invalid-layout');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
});

test('corrupt or non-gzip archive is rejected', async (t) => {
	const fx = await fixture(t);
	const junk = Buffer.from('this is not a gzip file at all');
	await writeFile(fx.archive, junk);
	const pin = { ...fx.pin, sha256: sha(junk) };
	await assertRejectsCode(provider(fx, { fallback: false }, pin).ensure(VERSION), 'unsafe-archive');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
});

// ---- layout validation

const without = (path: string): Entry[] => validEntries().filter((e) => e.path !== `vscode-web/${path}`);

const BAD_LAYOUT: [string, Entry[]][] = [
	['missing workbench bundle', without('out/vs/workbench/workbench.web.main.internal.js')],
	['missing workbench css', without('out/vs/workbench/workbench.web.main.internal.css')],
	['missing extension host worker', without('out/vs/workbench/api/worker/extensionHostWorkerMain.js')],
	['missing required node_module file', without('node_modules/vscode-oniguruma/release/onig.wasm')],
	['missing package.json', without('package.json')],
	[
		'package version differs from pin',
		validEntries('9.9.9'),
	],
];

for (const [name, entries] of BAD_LAYOUT) {
	test(`layout rejected: ${name}`, async (t) => {
		const fx = await fixture(t, entries);
		await assertRejectsCode(provider(fx, { fallback: false }).ensure(VERSION), 'invalid-layout');
		assert.deepEqual(await listVersions(fx.cacheDir), []);
	});
}

test('layout: public workbench.web.main.js bundle is also accepted', async (t) => {
	const entries = validEntries().map((e) => ({ ...e, path: e.path.replace('workbench.web.main.internal', 'workbench.web.main') }));
	const fx = await fixture(t, entries);
	await provider(fx).ensure(VERSION);
});

test('validateAssets: rejects symlinks, native content, forbidden files and missing manifest on disk', async (t) => {
	const fx = await fixture(t);
	const { root } = await provider(fx).ensure(VERSION);
	await validateAssets(root, { expected: { version: VERSION, commit: COMMIT } });
	await assertRejectsCode(validateAssets(root, { expected: { version: '0.0.1' } }), 'invalid-layout');
	await assertRejectsCode(validateAssets(root, { expected: { commit: 'b'.repeat(40) } }), 'invalid-layout');

	await symlink('/etc', join(root, 'out', 'link'));
	await assertRejectsCode(validateAssets(root), 'invalid-layout');
	await rm(join(root, 'out', 'link'));

	await writeFile(join(root, 'out', 'server-cli.js'), '//');
	await assertRejectsCode(validateAssets(root), 'invalid-layout');
	await rm(join(root, 'out', 'server-cli.js'));

	await validateAssets(root);
	const manifestPath = join(root, 'workbench-assets.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	await writeFile(manifestPath, JSON.stringify({ ...manifest, clientOnly: false }));
	await assertRejectsCode(validateAssets(root), 'invalid-layout');
	await rm(manifestPath);
	await assertRejectsCode(validateAssets(root), 'invalid-layout');
});

// ---- concurrency and locks

test('concurrent: parallel ensure() calls download and install once', async (t) => {
	const fx = await fixture(t);
	const counter = { calls: 0 };
	const https = { ...fx.pin, url: HTTPS_URL };
	const results = await Promise.all(
		Array.from({ length: 8 }, () =>
			new CachedDownloadAssets({ cacheDir: fx.cacheDir, pin: https, fetch: httpsFixtureFetch(fx.bytes, counter) }).ensure(VERSION),
		),
	);
	assert.equal(counter.calls, 1);
	assert.equal(new Set(results.map((r) => r.root)).size, 1);
	assert.deepEqual(await listVersions(fx.cacheDir), [COMMIT]);
	assert.deepEqual(await readdir(join(fx.cacheDir, 'locks')), []);
	await validateAssets(results[0]!.root);
});

test('concurrent: separate processes serialize on the cache lock', async (t) => {
	const fx = await fixture(t);
	const counterFile = join(fx.dir, 'downloads.log');
	await writeFile(counterFile, '');
	const indexUrl = pathToFileURL(join(repoRoot, 'packages/asset-provider/src/index.ts')).href;
	const script = `
		import { readFileSync, appendFileSync } from 'node:fs';
		const { CachedDownloadAssets } = await import(${JSON.stringify(indexUrl)});
		const [cacheDir, pinJson, archive, counter] = process.argv.slice(1);
		const bytes = readFileSync(archive);
		const assets = new CachedDownloadAssets({
			cacheDir,
			pin: JSON.parse(pinJson),
			fetch: async () => {
				appendFileSync(counter, 'x\\n');
				await new Promise((r) => setTimeout(r, 200));
				return new Response(bytes);
			},
		});
		const result = await assets.ensure(JSON.parse(pinJson).version);
		process.stdout.write(JSON.stringify(result));
	`;
	const pin = { ...fx.pin, url: HTTPS_URL };
	const run = () =>
		new Promise<string>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				['--import', 'tsx', '--input-type=module', '-e', script, fx.cacheDir, JSON.stringify(pin), fx.archive, counterFile],
				{ cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
			);
			let out = '';
			let err = '';
			child.stdout.on('data', (d) => (out += d));
			child.stderr.on('data', (d) => (err += d));
			child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err}`))));
		});
	const outputs = await Promise.all([run(), run(), run(), run()]);
	assert.equal(readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length, 1);
	for (const out of outputs) assert.equal(JSON.parse(out).commit, COMMIT);
	assert.deepEqual(await listVersions(fx.cacheDir), [COMMIT]);
	assert.deepEqual(await readdir(join(fx.cacheDir, 'locks')), []);
});

async function plantLock(fx: Fixture, owner: object, ageSeconds: number): Promise<void> {
	const lockDir = join(fx.cacheDir, 'locks', 'install.lock');
	await mkdir(lockDir, { recursive: true });
	const ownerFile = join(lockDir, 'owner.json');
	await writeFile(ownerFile, JSON.stringify({ token: 'planted', ...owner }));
	const when = new Date(Date.now() - ageSeconds * 1000);
	await utimes(ownerFile, when, when);
	await utimes(lockDir, when, when);
}

test('lock: abandoned lock of a dead local process is broken', async (t) => {
	const fx = await fixture(t);
	await plantLock(fx, { pid: 2_147_483_646, host: hostname() }, 0);
	const result = await provider(fx, { lock: { timeoutMs: 5000, pollMs: 20 } }).ensure(VERSION);
	assert.equal(result.commit, COMMIT);
});

test('lock: lock with a stale heartbeat from another host is broken', async (t) => {
	const fx = await fixture(t);
	await plantLock(fx, { pid: process.pid, host: 'some-other-host' }, 3600);
	const result = await provider(fx, { lock: { timeoutMs: 5000, staleMs: 1000, pollMs: 20 } }).ensure(VERSION);
	assert.equal(result.commit, COMMIT);
	assert.deepEqual(await readdir(join(fx.cacheDir, 'locks')), []);
});

test('lock: ownerless stale lock directory is broken', async (t) => {
	const fx = await fixture(t);
	const lockDir = join(fx.cacheDir, 'locks', 'install.lock');
	await mkdir(lockDir, { recursive: true });
	const old = new Date(Date.now() - 3_600_000);
	await utimes(lockDir, old, old);
	await provider(fx, { lock: { timeoutMs: 5000, staleMs: 1000, pollMs: 20 } }).ensure(VERSION);
});

test('lock: live lock held elsewhere times out instead of being stolen', async (t) => {
	const fx = await fixture(t);
	await plantLock(fx, { pid: process.pid, host: hostname() }, 0);
	const assets = provider(fx, { fallback: false, lock: { timeoutMs: 300, pollMs: 20, staleMs: 60_000 } });
	await assertRejectsCode(assets.ensure(VERSION), 'lock-timeout');
	assert.ok(existsSync(join(fx.cacheDir, 'locks', 'install.lock', 'owner.json')));
	assert.deepEqual(await listVersions(fx.cacheDir), []);
});

// ---- fallback

const NEXT_COMMIT = 'b'.repeat(40);

async function twoVersions(t: TestContext) {
	const v1 = await fixture(t);
	const v2 = await fixture(t, validEntries('1.2.4'), { version: '1.2.4', commit: NEXT_COMMIT });
	return { v1, v2, cacheDir: v1.cacheDir };
}

test('fallback: failed refresh serves the last validated install with explicit metadata', async (t) => {
	const { v1, v2, cacheDir } = await twoVersions(t);
	await new CachedDownloadAssets({ cacheDir, pin: v1.pin, allowFileUrls: true }).ensure(VERSION);

	const log: string[] = [];
	const refresh = new CachedDownloadAssets({
		cacheDir,
		pin: { ...v2.pin, url: HTTPS_URL },
		fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
		log: (m) => log.push(m),
	});
	const result = await refresh.ensure('1.2.4');
	assert.equal(result.version, VERSION);
	assert.equal(result.commit, COMMIT);
	assert.equal(result.fallback?.requestedVersion, '1.2.4');
	assert.match(result.fallback?.reason ?? '', /503/);
	assert.equal(log.filter((m) => m.includes('serving last validated')).length, 1);
	assert.equal(await readlink(join(cacheDir, 'current')), join('versions', COMMIT));
	assert.deepEqual(await listVersions(cacheDir), [COMMIT]);
});

test('fallback: disabled, warm(), and empty cache all surface the failure', async (t) => {
	const { v1, v2, cacheDir } = await twoVersions(t);
	const failing = (fallback?: boolean) =>
		new CachedDownloadAssets({
			cacheDir,
			pin: { ...v2.pin, url: HTTPS_URL },
			fallback,
			fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
		});
	await assertRejectsCode(failing().ensure('1.2.4'), 'download'); // nothing installed yet
	await new CachedDownloadAssets({ cacheDir, pin: v1.pin, allowFileUrls: true }).ensure(VERSION);
	await assertRejectsCode(failing(false).ensure('1.2.4'), 'download');
	await assertRejectsCode(failing().warm(), 'download');
});

test('fallback: checksum-failing refresh also falls back and never installs the bad archive', async (t) => {
	const { v1, v2, cacheDir } = await twoVersions(t);
	await new CachedDownloadAssets({ cacheDir, pin: v1.pin, allowFileUrls: true }).ensure(VERSION);
	const bad = new CachedDownloadAssets({
		cacheDir,
		pin: { ...v2.pin, url: HTTPS_URL, sha256: 'f'.repeat(64) },
		fetch: (async () => new Response(new Uint8Array(v2.bytes))) as typeof fetch,
	});
	const result = await bad.ensure('1.2.4');
	assert.equal(result.commit, COMMIT);
	assert.match(result.fallback?.reason ?? '', /sha256 mismatch/);
	assert.deepEqual(await listVersions(cacheDir), [COMMIT]);
});

test('fallback: a corrupted current install is not served', async (t) => {
	const { v1, v2, cacheDir } = await twoVersions(t);
	const first = await new CachedDownloadAssets({ cacheDir, pin: v1.pin, allowFileUrls: true }).ensure(VERSION);
	await rm(join(first.root, 'out/vs/workbench/api/worker/extensionHostWorkerMain.js'));
	const refresh = new CachedDownloadAssets({
		cacheDir,
		pin: { ...v2.pin, url: HTTPS_URL },
		fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
	});
	await assertRejectsCode(refresh.ensure('1.2.4'), 'download');
});

test('upgrade: successful refresh switches current atomically and keeps the old version for rollback', async (t) => {
	const { v1, v2, cacheDir } = await twoVersions(t);
	await new CachedDownloadAssets({ cacheDir, pin: v1.pin, allowFileUrls: true }).ensure(VERSION);
	const upgraded = new CachedDownloadAssets({ cacheDir, pin: v2.pin, allowFileUrls: true });
	const result = await upgraded.ensure('1.2.4');
	assert.equal(result.fallback, undefined);
	assert.equal(result.commit, NEXT_COMMIT);
	assert.equal(await readlink(join(cacheDir, 'current')), join('versions', NEXT_COMMIT));
	assert.deepEqual((await listVersions(cacheDir)).sort(), [COMMIT, NEXT_COMMIT]);

	const status = await upgraded.status();
	assert.equal(status.current?.commit, NEXT_COMMIT);
	assert.equal(status.pinInstalled, true);
	assert.deepEqual(status.installed.map((i) => i.valid), [true, true]);

	const rolled = await upgraded.rollback(COMMIT);
	assert.equal(rolled.version, VERSION);
	assert.equal(await readlink(join(cacheDir, 'current')), join('versions', COMMIT));
	await assertRejectsCode(upgraded.rollback('c'.repeat(40)), 'not-installed');

	const removed = await upgraded.prune();
	assert.deepEqual(removed.sort(), [`downloads/${v1.pin.sha256}.tar.gz`]);
	assert.deepEqual((await listVersions(cacheDir)).sort(), [COMMIT, NEXT_COMMIT]);
	await upgraded.rollback(NEXT_COMMIT);
	assert.deepEqual(await upgraded.prune(), [`versions/${COMMIT}`]);
});

// ---- atomicity

test('atomic: download failing mid-stream leaves no partial files or version', async (t) => {
	const fx = await fixture(t);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(fx.bytes.subarray(0, 1000)));
		},
		pull() {
			throw new Error('connection reset');
		},
	});
	const assets = new CachedDownloadAssets({
		cacheDir: fx.cacheDir,
		pin: { ...fx.pin, url: HTTPS_URL },
		fetch: (async () => new Response(stream)) as typeof fetch,
	});
	await assertRejectsCode(assets.ensure(VERSION), 'download');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
	assert.deepEqual(await readdir(join(fx.cacheDir, 'downloads')), []);
});

test('atomic: failed validation after extraction never publishes the version', async (t) => {
	const fx = await fixture(t, without('out/vs/workbench/workbench.web.main.internal.css'));
	await assertRejectsCode(provider(fx).ensure(VERSION), 'invalid-layout');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
	assert.equal(existsSync(join(fx.cacheDir, 'current')), false);
});

test('atomic: crash leftovers (staging dir, partial version) are cleaned and replaced', async (t) => {
	const fx = await fixture(t);
	const versions = join(fx.cacheDir, 'versions');
	await mkdir(join(versions, `.staging-${COMMIT}-dead`), { recursive: true });
	await writeFile(join(versions, `.staging-${COMMIT}-dead`, 'half'), 'x');
	await mkdir(join(versions, COMMIT, 'out'), { recursive: true }); // no manifest: invalid
	const result = await provider(fx).ensure(VERSION);
	assert.deepEqual(await listVersions(fx.cacheDir), [COMMIT]);
	await validateAssets(result.root);
});

test('atomic: the version directory is only ever visible complete', async (t) => {
	const fx = await fixture(t);
	let done = false;
	const install = provider(fx).ensure(VERSION).finally(() => (done = true));
	const target = join(fx.cacheDir, 'versions', COMMIT);
	while (!done) {
		if (existsSync(target)) await validateAssets(target);
		await new Promise((resolve) => setImmediate(resolve));
	}
	await install;
	await validateAssets(target);
});

test('atomic: a valid cached download is reused if the archive is gone upstream', async (t) => {
	const fx = await fixture(t);
	await provider(fx).ensure(VERSION);
	await rm(join(fx.cacheDir, 'versions'), { recursive: true });
	await rm(join(fx.cacheDir, 'current'));
	const gone = { ...fx.pin, url: pathToFileURL(join(fx.dir, 'missing.tar.gz')).href };
	const result = await provider(fx, {}, gone).ensure(VERSION);
	assert.equal(result.commit, COMMIT);
});

test('atomic: a tampered cached download is re-fetched, not trusted', async (t) => {
	const fx = await fixture(t);
	await provider(fx).ensure(VERSION);
	await rm(join(fx.cacheDir, 'versions'), { recursive: true });
	await rm(join(fx.cacheDir, 'current'));
	const cached = join(fx.cacheDir, 'downloads', `${fx.pin.sha256}.tar.gz`);
	await chmod(cached, 0o644);
	await writeFile(cached, 'tampered');
	const result = await provider(fx).ensure(VERSION);
	assert.equal(result.commit, COMMIT);
	assert.equal(sha(await readFile(cached)), fx.pin.sha256);
});

// ---- bundled

test('bundled: serves a pre-built tree and validates it on every call', async (t) => {
	const fx = await fixture(t);
	const root = join(fx.dir, 'bundle');
	await installArchive(fx.archive, fx.pin, root);
	const assets = new BundledAssets({ root, pin: fx.pin });
	const result = await assets.ensure(VERSION);
	assert.deepEqual(result, { root, version: VERSION, commit: COMMIT, integrity: `sha256:${fx.pin.sha256}` });

	await assertRejectsCode(assets.ensure('9.9.9'), 'version-mismatch');
	await assertRejectsCode(new BundledAssets({ root }).ensure('9.9.9'), 'version-mismatch');
	await new BundledAssets({ root }).ensure(VERSION);
	await assertRejectsCode(
		new BundledAssets({ root, pin: { ...fx.pin, commit: NEXT_COMMIT } }).ensure(VERSION),
		'invalid-layout',
	);

	await writeFile(join(root, 'out', 'bootstrap-fork.js'), '//');
	await assertRejectsCode(assets.ensure(VERSION), 'invalid-layout');
});

test('bundled: missing or non-client-only tree is rejected', async (t) => {
	const dir = await tempDir(t);
	await assertRejectsCode(new BundledAssets({ root: join(dir, 'nope') }).ensure(VERSION), 'invalid-layout');
	await mkdir(join(dir, 'empty'));
	await assertRejectsCode(new BundledAssets({ root: join(dir, 'empty') }).ensure(VERSION), 'invalid-layout');
});

test('installArchive: refuses an archive whose digest does not match the pin', async (t) => {
	const fx = await fixture(t);
	await assertRejectsCode(installArchive(fx.archive, { ...fx.pin, sha256: '2'.repeat(64) }, join(fx.dir, 'x')), 'checksum');
	assert.equal(existsSync(join(fx.dir, 'x')), false);
});

// ---- real official archive (set GITEA_WORKBENCH_ARCHIVE to the pinned vscode-web.tar.gz)

const realArchive = process.env.GITEA_WORKBENCH_ARCHIVE;

test('official archive: pinned vscode-web archive installs as a client-only workbench', { skip: !realArchive }, async (t) => {
	const pin = await loadPin(join(repoRoot, 'config', 'workbench.json'));
	const dir = await tempDir(t);
	const offline: AssetPin = { ...pin, url: pathToFileURL(realArchive!).href };
	const assets = new CachedDownloadAssets({ cacheDir: join(dir, 'cache'), pin: offline, allowFileUrls: true });
	const result = await assets.ensure(pin.version);
	assert.equal(result.commit, pin.commit);
	assert.equal(result.integrity, `sha256:${pin.sha256}`);
	for (const rel of [
		'out/vs/workbench/workbench.web.main.internal.js',
		'out/vs/workbench/workbench.web.main.internal.css',
		'out/vs/workbench/api/worker/extensionHostWorkerMain.js',
	]) {
		assert.ok(existsSync(join(result.root, rel)), rel);
	}
	assert.equal(existsSync(join(result.root, 'out/server-cli.js')), false);
});

// ---- review findings

// Replaces a node:fs(/promises) function with a wrapper; ESM named imports see it after the sync.
function spyOn<T extends object>(t: TestContext, target: T, name: keyof T & string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any) {
	const original = (target as any)[name] as (...args: any[]) => any;
	t.mock.method(target, name, wrap(original.bind(target)) as any);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
}

const openFilesUnder = (dir: string): string[] =>
	readdirSync('/proc/self/fd')
		.map((fd) => {
			try {
				return readlinkSync(`/proc/self/fd/${fd}`);
			} catch {
				return '';
			}
		})
		.filter((target) => target.startsWith(dir));

test('F5: waiting for the install lock outlasts the download timeout', () => {
	assert.ok(DEFAULT_LOCK.timeoutMs >= DEFAULT_DOWNLOAD_TIMEOUT_MS, `${DEFAULT_LOCK.timeoutMs} < ${DEFAULT_DOWNLOAD_TIMEOUT_MS}`);
});

test('F5: a waiter returns the install another process finished while it waited', async (t) => {
	const fx = await fixture(t);
	await plantLock(fx, { pid: process.pid, host: hostname() }, 0);
	const waiting = provider(fx, { fallback: false, lock: { timeoutMs: 1500, pollMs: 20, staleMs: 60_000 } }).ensure(VERSION);
	await new Promise((resolve) => setTimeout(resolve, 150));
	await installArchive(fx.archive, fx.pin, join(fx.cacheDir, 'versions', COMMIT));
	await symlink(join('versions', COMMIT), join(fx.cacheDir, 'current'));
	const result = await waiting;
	assert.equal(result.commit, COMMIT);
	assert.equal(result.fallback, undefined);
});

test('F7: a lock owned by another pid namespace is not judged dead by its pid', async (t) => {
	const fx = await fixture(t);
	await plantLock(fx, { pid: 2_147_483_646, host: hostname(), scope: 'another-namespace' }, 0);
	const assets = provider(fx, { fallback: false, lock: { timeoutMs: 300, pollMs: 20, staleMs: 60_000 } });
	await assertRejectsCode(assets.ensure(VERSION), 'lock-timeout');
});

test('F7: a holder whose lock was broken learns it before its next destructive step', async (t) => {
	const dir = await tempDir(t);
	const lockDir = join(dir, 'locks', 'x.lock');
	await assertRejectsCode(
		withLock(lockDir, async (held: () => Promise<void>) => {
			await held();
			await rm(lockDir, { recursive: true });
			await mkdir(lockDir);
			await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token: 'foreign' }));
			await held();
		}),
		'lock-lost',
	);
	assert.ok(existsSync(join(lockDir, 'owner.json')), 'the foreign lock is left alone');
});

test('F7: an install that lost its lock mid-download publishes nothing', async (t) => {
	const fx = await fixture(t);
	const lockDir = join(fx.cacheDir, 'locks', 'install.lock');
	const stolen = (async () => {
		await rm(lockDir, { recursive: true });
		await mkdir(lockDir);
		await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token: 'foreign' }));
		return new Response(new Uint8Array(fx.bytes));
	}) as typeof fetch;
	const assets = new CachedDownloadAssets({ cacheDir: fx.cacheDir, pin: { ...fx.pin, url: HTTPS_URL }, fallback: false, fetch: stolen });
	await assertRejectsCode(assets.ensure(VERSION), 'lock-lost');
	assert.deepEqual(await listVersions(fx.cacheDir), []);
	assert.equal(existsSync(join(fx.cacheDir, 'current')), false);
});

test('F6: rollback moves current (the fallback target) until the next ensure repoints it at the pin', async (t) => {
	const { v1, v2, cacheDir } = await twoVersions(t);
	await new CachedDownloadAssets({ cacheDir, pin: v1.pin, allowFileUrls: true }).ensure(VERSION);
	const upgraded = new CachedDownloadAssets({ cacheDir, pin: v2.pin, allowFileUrls: true });
	await upgraded.ensure('1.2.4');
	await upgraded.rollback(COMMIT);
	assert.equal(await readlink(join(cacheDir, 'current')), join('versions', COMMIT));
	assert.equal((await upgraded.ensure('1.2.4')).commit, NEXT_COMMIT);
	assert.equal(await readlink(join(cacheDir, 'current')), join('versions', NEXT_COMMIT));
});

test('F16: downloads left by a crashed install are swept on the next install', async (t) => {
	const fx = await fixture(t);
	await mkdir(join(fx.cacheDir, 'downloads'), { recursive: true });
	const stale = join(fx.cacheDir, 'downloads', `${fx.pin.sha256}.deadbeefcafe.part`);
	await writeFile(stale, 'half a download');
	await provider(fx).ensure(VERSION);
	assert.deepEqual(await readdir(join(fx.cacheDir, 'downloads')), [`${fx.pin.sha256}.tar.gz`]);
});

test('F9: the archive is read once to hash and once to extract, and the extracted bytes must match the digest', async (t) => {
	const fx = await fixture(t);
	let reads = 0;
	spyOn(t, fs, 'createReadStream', (original) => (...args) => {
		if (args[0] === fx.archive) reads++;
		return original(...args);
	});
	await installArchive(fx.archive, fx.pin, join(fx.dir, 'out'));
	assert.ok(reads <= 2, `archive opened ${reads} times`);
});

test('F9: bytes swapped in after the digest check are rejected, not installed', async (t) => {
	const fx = await fixture(t);
	const swapped = gzipSync(buildTar([...validEntries(), { path: 'vscode-web/out/extra.js', data: '//swapped' }]));
	let reads = 0;
	spyOn(t, fs, 'createReadStream', (original) => (...args) => {
		if (args[0] === fx.archive && ++reads > 1) fs.writeFileSync(fx.archive, swapped);
		return original(...args);
	});
	await assertRejectsCode(installArchive(fx.archive, fx.pin, join(fx.dir, 'out')), 'checksum');
});

test('F14: extraction alone enforces the entry policy and the limits', async (t) => {
	for (const [name, entries, code] of UNSAFE) {
		const fx = await fixture(t, entries);
		const before = await readdir(fx.dir);
		await assert.rejects(extractArchive(fx.archive, join(fx.dir, 'out')), (error: unknown) => {
			assert.ok(error instanceof AssetError, `${name}: ${String(error)}`);
			assert.equal(error.code, code, `${name}: ${error.message}`);
			return true;
		});
		assert.deepEqual((await readdir(fx.dir)).filter((n) => !before.includes(n)), ['out'], name);
		assert.equal(existsSync('/tmp/assets-evil.txt'), false, name);
	}
	const fx = await fixture(t);
	await assertRejectsCode(extractArchive(fx.archive, join(fx.dir, 'a'), { limits: { ...DEFAULT_LIMITS_FOR_TEST, maxEntries: 3 } }), 'limit');
	await assertRejectsCode(extractArchive(fx.archive, join(fx.dir, 'b'), { limits: { ...DEFAULT_LIMITS_FOR_TEST, maxUnpackedBytes: 16 } }), 'limit');
});

const DEFAULT_LIMITS_FOR_TEST = { maxCompressedBytes: 256 * 1024 * 1024, maxUnpackedBytes: 1024 * 1024 * 1024, maxEntries: 100_000, maxPathLength: 512 };

test('F10: a failed extraction leaves no file open under the destination', async (t) => {
	const entries: Entry[] = [{ path: 'vscode-web/', type: 'dir' }, { path: 'vscode-web/big', data: randomBytes(3_000_000) }];
	const fx = await fixture(t, entries);
	await writeFile(fx.archive, fx.bytes.subarray(0, Math.floor(fx.bytes.length * 0.6)));
	const dest = join(fx.dir, 'out');
	await assertRejectsCode(extractArchive(fx.archive, dest), 'unsafe-archive');
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(openFilesUnder(dest), []);
});

test('F15: validation does not lstat every file and opens files concurrently', async (t) => {
	const files: Entry[] = Array.from({ length: 300 }, (_, i) => ({ path: `vscode-web/out/many/f${i}.js`, data: `// ${i}` }));
	const fx = await fixture(t, [...validEntries(), ...files]);
	const { root } = await provider(fx).ensure(VERSION);
	let lstats = 0;
	let pending = 0;
	let widest = 0;
	spyOn(t, fsp, 'lstat', (original) => (...args) => {
		lstats++;
		return original(...args);
	});
	spyOn(t, fsp, 'open', (original) => async (...args) => {
		widest = Math.max(widest, ++pending);
		try {
			return await original(...args);
		} finally {
			pending--;
		}
	});
	await validateAssets(root);
	assert.ok(lstats < 40, `${lstats} lstat calls`);
	assert.ok(widest > 1, 'files were opened one at a time');
});

// The script is the user-facing entry point; run it against a pre-warmed cache with no network.
function assetsScript(fx: Fixture, ...args: string[]) {
	return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/assets.ts', ...args], {
		cwd: repoRoot,
		encoding: 'utf8',
		env: { ...process.env, WORKBENCH_PIN: join(fx.dir, 'pin.json'), WORKBENCH_CACHE: fx.cacheDir },
	});
}

test('F13: bundle writes a validated tree atomically and refuses an existing destination', async (t) => {
	const fx = await fixture(t);
	await provider(fx).ensure(VERSION);
	await writeFile(join(fx.dir, 'pin.json'), JSON.stringify({ ...fx.pin, url: HTTPS_URL }));

	const dest = join(fx.dir, 'bundle');
	const ok = assetsScript(fx, 'bundle', dest);
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal((await new BundledAssets({ root: dest, pin: fx.pin }).ensure(VERSION)).commit, COMMIT);
	assert.deepEqual((await readdir(fx.dir)).sort(), ['bundle', 'cache', 'pin.json', 'workbench.tar.gz']);

	const taken = join(fx.dir, 'taken');
	await mkdir(taken);
	await writeFile(join(taken, 'stray.txt'), 'x');
	const refused = assetsScript(fx, 'bundle', taken);
	assert.notEqual(refused.status, 0, 'merged into an existing directory');
	assert.deepEqual(await readdir(taken), ['stray.txt']);
});
