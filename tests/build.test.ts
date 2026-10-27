// scripts/build.mjs run end to end in a sandbox working directory with stub editor sources.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'a'.repeat(40);
// Unreachable: the build must not fetch the workbench.
const URL = 'https://127.0.0.1:9/vscode-web.tar.gz';

// Working directory with the real build script but stub editor sources, so the test does not
// depend on the extension or host code. Own config and dist; no workbench cache.
async function sandbox(t: TestContext, pin: object): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'build-test-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const name of ['node_modules', 'gitea', 'scripts']) await symlink(join(repoRoot, name), join(dir, name));
	const stubs: Record<string, string> = {
		'packages/gitea-vscode-web/src/extension.ts': 'export {};\n',
		'packages/gitea-vscode-web/src/shell/zlib-stub.ts': 'export {};\n',
		'packages/gitea-vscode-web/package.json': JSON.stringify({ name: 'stub', main: './x.js' }),
		'packages/editor-host/src/bootstrap.ts': 'export {};\n',
		'packages/editor-host/src/oauth-callback.ts': 'export {};\n',
		'packages/editor-host/src/start.ts': 'export {};\n',
		'packages/editor-host/src/coi-sw.ts': 'export const config = "@CONFIG@";\nexport const hashes = "@SCRIPT_HASHES@";\n',
	};
	for (const [path, content] of Object.entries(stubs)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	await mkdir(join(dir, 'config'));
	await writeFile(join(dir, 'config/workbench.json'), JSON.stringify(pin));
	return dir;
}

const build = (dir: string) => spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8' });

async function files(root: string, dir = ''): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
		const path = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...await files(root, path));
		else out.push(path);
	}
	return out;
}

test('the release holds only our code and the pin; the build fetches no workbench', async (t) => {
	const pin = { version: '1.2.3', commit: COMMIT, url: URL, sha256: '1'.repeat(64) };
	const dir = await sandbox(t, pin);
	const result = build(dir);
	assert.equal(result.status, 0, result.stderr);
	const release = join(dir, 'dist/gitea-dev');
	assert.deepEqual(JSON.parse(await readFile(join(release, 'workbench.json'), 'utf8')), pin);
	const version = (await readFile(join(release, 'VERSION'), 'utf8')).trim();
	const listed = await files(release);
	assert.ok(listed.includes(`custom/public/assets/gitea-dev/${version}/extension/package.json`));
	assert.deepEqual(listed.filter(path => /(^|\/)(workbench|out|node_modules)\//.test(path)), []);
	const worker = await readFile(join(release, 'custom/public/assets/gitea-dev/coi-sw.js'), 'utf8');
	assert.ok(worker.includes('"@SCRIPT_HASHES@"'));
	const index = await readFile(join(release, 'custom/public/assets/gitea-dev/index.html'), 'utf8');
	assert.match(index, /script-src 'self' 'wasm-unsafe-eval' blob:@WORKBENCH_SOURCES@;/);
	assert.match(index, /frame-src 'self'@FRAME_SOURCES@;/);
});

test('a malformed pin fails the build', async (t) => {
	for (const pin of [{ commit: 'x', url: URL, sha256: '1'.repeat(64) }, { commit: COMMIT, url: URL, sha256: 'z' }, { commit: COMMIT, url: 'ftp://a/b', sha256: '1'.repeat(64) }]) {
		const result = build(await sandbox(t, { version: '1.2.3', ...pin }));
		assert.notEqual(result.status, 0, JSON.stringify(pin));
	}
});

test('F12: the release version changes when only the pinned archive digest changes', async (t) => {
	const versions: string[] = [];
	for (const sha256 of ['1'.repeat(64), '2'.repeat(64)]) {
		const dir = await sandbox(t, { version: '1.2.3', commit: COMMIT, url: URL, sha256 });
		const result = build(dir);
		assert.equal(result.status, 0, result.stderr);
		versions.push((await readFile(join(dir, 'dist/gitea-dev/VERSION'), 'utf8')).trim());
	}
	assert.match(versions[0]!, /^[0-9a-f]{12}-[0-9a-f]{12}$/);
	assert.notEqual(versions[0], versions[1]);
});
