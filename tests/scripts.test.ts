// Operator scripts: asset CLI, WebKit setup, pinned-binary download helper.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFile(join(repoRoot, path), 'utf8');

async function tempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'scripts-test-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test('F4: npm run assets works in a checkout that was never built', async (t) => {
	const dir = await tempDir(t);
	await writeFile(join(dir, 'package.json'), await read('package.json'));
	for (const name of ['packages', 'node_modules', 'scripts', 'config']) await symlink(join(repoRoot, name), join(dir, name));
	const result = spawnSync('npm', ['run', '--silent', 'assets', '--', 'status'], {
		cwd: dir, encoding: 'utf8', env: { ...process.env, WORKBENCH_CACHE: join(dir, 'cache') },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).pinInstalled, false);
	assert.equal(existsSync(join(dir, 'dist')), false);
});

test('F2: setup-webkit unpacks debs in a private mkdtemp directory, not a fixed /tmp path', async () => {
	const source = await read('scripts/setup-webkit.mjs');
	assert.doesNotMatch(source, /\/tmp\/webkit-setup/);
	assert.match(source, /mkdtempSync\(/);
	assert.match(source, /rmSync\(work/);
});

test('F17: both pinned-binary downloads share one helper', async () => {
	for (const file of ['scripts/local-instance.mjs', 'scripts/test-gitea.mjs']) {
		const source = await read(file);
		assert.match(source, /ensurePinnedBinary\(/, file);
		assert.doesNotMatch(source, /createWriteStream|\.part\b/, `${file} still downloads on its own`);
	}
});

const BODY = Buffer.from('#!/bin/sh\necho gitea\n');
const SHA = createHash('sha256').update(BODY).digest('hex');
const URL_ = 'https://downloads.example.test/gitea-9.9.9-linux-amd64';

// @ts-ignore untyped .mjs module
const ensure = async (options: Record<string, unknown>): Promise<void> => (await import('../scripts/pinned-binary.mjs')).ensurePinnedBinary(options);

function serve(sums: string, body: Buffer = BODY): typeof fetch {
	return (async (url: string) => {
		if (String(url) === `${URL_}.sha256`) return new Response(sums);
		if (String(url) === URL_) return new Response(new Uint8Array(body));
		return new Response('nope', { status: 404 });
	}) as typeof fetch;
}

test('F17 helper: downloads, verifies both digests, installs executable, leaves no .part', async (t) => {
	const dir = await tempDir(t);
	const binary = join(dir, 'bin/gitea');
	await ensure({ binary, url: URL_, sha256: SHA, mode: 0o700, fetch: serve(`${SHA}  gitea-9.9.9-linux-amd64\n`) });
	assert.deepEqual(await readFile(binary), BODY);
	assert.equal((await stat(binary)).mode & 0o777, 0o700);
	assert.deepEqual(await readdir(join(dir, 'bin')), ['gitea']);
	let calls = 0;
	await ensure({ binary, url: URL_, sha256: SHA, fetch: (async () => { calls++; return new Response('x'); }) as typeof fetch });
	assert.equal(calls, 0, 'a verified binary is not downloaded again');
});

test('F17 helper: refuses a published checksum that differs from the pin, and a corrupt body', async (t) => {
	const dir = await tempDir(t);
	const binary = join(dir, 'bin/gitea');
	await assert.rejects(ensure({ binary, url: URL_, sha256: SHA, fetch: serve(`${'0'.repeat(64)}  gitea-9.9.9-linux-amd64\n`) }), /does not match the pin/);
	await assert.rejects(ensure({ binary, url: URL_, sha256: SHA, fetch: serve(`${SHA}  other-name\n`) }), /does not match the pin/);
	await assert.rejects(ensure({ binary, url: URL_, sha256: SHA, fetch: serve(`${SHA}  gitea-9.9.9-linux-amd64\n`, Buffer.from('tampered')) }), /checksum mismatch/);
	assert.equal(existsSync(binary), false);
	assert.deepEqual(await readdir(join(dir, 'bin')), []);
});

test('F17 helper: gives up on a stalled server after the timeout', async (t) => {
	const dir = await tempDir(t);
	const stalled = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
	})) as unknown as typeof fetch;
	const keepAlive = setTimeout(() => undefined, 5000); // AbortSignal.timeout does not hold the event loop open
	try {
		await assert.rejects(ensure({ binary: join(dir, 'bin/gitea'), url: URL_, sha256: SHA, timeoutMs: 100, fetch: stalled }));
	} finally { clearTimeout(keepAlive); }
});

test('F17 helper: concurrent calls do not share a .part file', async (t) => {
	const dir = await tempDir(t);
	const binary = join(dir, 'bin/gitea');
	const options = { binary, url: URL_, sha256: SHA, fetch: serve(`${SHA}  gitea-9.9.9-linux-amd64\n`) };
	await Promise.all([ensure(options), ensure(options), ensure(options)]);
	assert.deepEqual(await readFile(binary), BODY);
	assert.deepEqual(await readdir(join(dir, 'bin')), ['gitea']);
});
