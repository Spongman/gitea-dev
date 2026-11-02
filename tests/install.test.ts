// scripts/install.sh must accept and reject input and write files the same way under every POSIX shell available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { c as createTar } from 'tar';

const VERSION = 'abc123abc123-def456def456';
const COMMIT = 'abc123abc123'.padEnd(40, '0');
const IFRAME = 'workbench/out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html';
const CALLBACK = 'workbench/out/vs/code/browser/workbench/callback.html';
const shellArgs = (shell: string) => shell === 'busybox' ? ['sh'] : [];
const shells = ['sh', ...['ksh', 'dash', 'busybox'].filter(shell => spawnSync(shell, [...shellArgs(shell), '-c', 'true']).status === 0)];
const cspHash = (script: string) => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;

// A tiny workbench archive with upstream's layout: one top-level directory, an extension host
// iframe whose CSP allows every https: host, pages with inline scripts, and Node-only parts.
const IFRAME_SCRIPT = '\n\tself.onmessage = e => e;\r\n';
const CALLBACK_SCRIPTS = ['one();', '\n\u00e9("two");\n'];
const workbenchFiles: Record<string, string> = {
  [`vscode-web/out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html`]:
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https: wss:; script-src 'self'">\n<script>${IFRAME_SCRIPT}</script>\n`,
  'vscode-web/out/vs/code/browser/workbench/callback.html': `<script>${CALLBACK_SCRIPTS[0]}</script><p>x</p>\n<script>${CALLBACK_SCRIPTS[1]}</script>\n`,
  'vscode-web/out/plain.html': '<script src="a.js"></script>\n',
  'vscode-web/out/nls.messages.js': 'nls();\n',
  'vscode-web/extensions/a/dist/node/main.js': 'node();\n',
  'vscode-web/extensions/a/dist/browser/main.js': 'browser();\n',
  'vscode-web/node_modules/tool/bin/run': 'run\n',
  'vscode-web/node_modules.asar': 'asar\n',
};
const fixtureDir = await mkdtemp(join(tmpdir(), 'gitea-dev-workbench-'));
process.on('exit', () => spawnSync('rm', ['-rf', fixtureDir]));
for (const [path, content] of Object.entries(workbenchFiles)) {
  await mkdir(join(fixtureDir, path, '..'), { recursive: true });
  await writeFile(join(fixtureDir, path), content);
}
const ARCHIVE = join(fixtureDir, 'vscode-web.tar.gz');
await createTar({ gzip: true, file: ARCHIVE, cwd: fixtureDir, portable: true }, ['vscode-web']);
const ARCHIVE_SHA256 = createHash('sha256').update(await readFile(ARCHIVE)).digest('hex');
const LOCAL = ['--workbench=local', `--workbench-archive=${ARCHIVE}`];
// The default pin URL: serves the archive, so installs in the default download mode run offline.
// spawnSync blocks this server, so synchronous runs pass LOCAL.
const archiveServer = createServer((_req, res) => { void readFile(ARCHIVE).then(bytes => res.end(bytes)); });
await new Promise<void>(resolve => archiveServer.listen(0, '127.0.0.1', resolve));
archiveServer.unref();
const ARCHIVE_URL = `http://127.0.0.1:${(archiveServer.address() as AddressInfo).port}/vscode-web.tar.gz`;

interface ReleaseOptions { versionFile?: string; omitVersionDir?: boolean; pin?: Record<string, string> }

async function release({ versionFile = `${VERSION}\n`, omitVersionDir = false, pin = {} }: ReleaseOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gitea-dev-release-'));
  const assets = join(root, 'custom/public/assets/gitea-dev');
  const pinJson = { version: '1.2.3', commit: COMMIT, url: ARCHIVE_URL, sha256: ARCHIVE_SHA256, ...pin };
  const files: Record<string, string> = {
    VERSION: versionFile,
    'workbench.json': `${JSON.stringify(pinJson, null, 2)}\n`,
    'custom/templates/custom/extra_tabs.tmpl': '<a data-gitea-dev-launch></a>\n',
    [`custom/public/assets/gitea-dev/${VERSION}/bootstrap.js`]: 'export {};\n',
    'custom/public/assets/gitea-dev/index.html': `<meta content="script-src 'self'; img-src 'self'@GALLERY_SOURCES@; frame-src 'self'@FRAME_SOURCES@">\n`,
    'custom/public/assets/gitea-dev/oauth-callback.html': `<meta content="connect-src 'self'@GALLERY_SOURCES@">\n`,
    'custom/public/assets/gitea-dev/coi-sw.js': 'var config = "@CONFIG@";\nvar sources = "@GALLERY_SOURCES@";\nvar hashes = "@SCRIPT_HASHES@";\n',
    'custom/public/assets/gitea-dev/start.js': 'start();\n',
    'custom/public/assets/gitea-dev/shortcut.js': 'shortcut();\n',
  };
  for (const [path, content] of Object.entries(files)) {
    if (omitVersionDir && path.startsWith(`custom/public/assets/gitea-dev/${VERSION}/`)) continue;
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await cp('scripts/install.sh', join(root, 'install.sh'));
  return { root, assets };
}

async function tree(dir: string) {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[relative(dir, full)] = await readFile(full, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

const command = (kind: string, from: string, custom: string, args: string[]): [string, string[]] =>
  [kind, [...shellArgs(kind), join(from, 'install.sh'), custom, ...args]];

function run(kind: string, from: string, custom: string, args: string[]) {
  const result = spawnSync(...command(kind, from, custom, args), { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

/** run() without blocking this process, which may be serving the download or a fake Gitea. */
function runAsync(kind: string, from: string, custom: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(...command(kind, from, custom, args), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stderr }));
  });
}

interface InstallAllOptions extends ReleaseOptions { env?: Record<string, string> }

/** Runs the installer under every shell on a fresh, existing, empty target (after `prepare`) and returns each installed tree. */
async function installAll(args: string[], prepare?: (custom: string) => Promise<void>, options: InstallAllOptions = {}) {
  const { root } = await release(options);
  const results: { kind: string; status: number | null; stderr: string; files: Record<string, string> }[] = [];
  try {
    for (const kind of shells) {
      const custom = join(root, `target-${kind}`);
      await mkdir(custom, { recursive: true });
      if (prepare) await prepare(custom);
      const result = await runAsync(kind, root, custom, args, options.env);
      results.push({ kind, ...result, files: await tree(custom) });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  return results;
}

test('every shell writes identical trees with substituted CSP sources and configuration', async () => {
  const args = ['https://git.example.com/git/', '--oauth-client-id', 'd22e588f-d1bd-42af-84ef-7f888fa2d355',
    '--webviews=vscode-cdn', '--connect-src', 'https://api.example.com  wss://*.example.com:443 http://localhost:*',
    '--extensions-allowlist=Esbenp.Prettier-VSCode, esbenp.prettier-vscode redhat.vscode-yaml', ...LOCAL];
  const [first, ...others] = await installAll(args);
  assert.equal(first.status, 0, first.stderr);
  for (const other of others) {
    assert.equal(other.status, 0, `${other.kind}: ${other.stderr}`);
    assert.deepEqual(other.files, first.files, other.kind);
  }
  const files = first.files;
  const assets = 'public/assets/gitea-dev';
  const config = JSON.parse(files[`${assets}/configuration.json`]);
  assert.deepEqual(config, {
    instance: 'https://git.example.com/git', version: VERSION, oauthClientId: 'd22e588f-d1bd-42af-84ef-7f888fa2d355',
    gallery: 'https://open-vsx.org', extensionsAllowlist: ['esbenp.prettier-vscode', 'redhat.vscode-yaml'],
    connectSrc: 'https://api.example.com wss://*.example.com:443 http://localhost:*', webviews: 'vscode-cdn', testMode: false,
  });
  const hashes = { [CALLBACK]: CALLBACK_SCRIPTS.map(cspHash).join(' '), [IFRAME]: cspHash(IFRAME_SCRIPT) };
  assert.equal(files[`${assets}/coi-sw.js`],
    `var config = ${JSON.stringify(config)};\nvar sources = " https://open-vsx.org https://openvsx.eclipsecontent.org";\nvar hashes = ${JSON.stringify(hashes)};\n`);
  assert.equal(files[`${assets}/${VERSION}/${IFRAME}`],
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self' https://open-vsx.org https://openvsx.eclipsecontent.org https://api.example.com wss://*.example.com:443 http://localhost:*; script-src 'self'">\n<script>${IFRAME_SCRIPT}</script>\n`);
  assert.equal(files[`${assets}/index.html`],
    `<meta content="script-src 'self'; img-src 'self' https://open-vsx.org https://openvsx.eclipsecontent.org; frame-src 'self' https://*.vscode-cdn.net">\n`);
  assert.equal(files['templates/custom/extra_tabs.tmpl'], '<a data-gitea-dev-launch></a>\n');
  assert.ok(!Object.keys(files).some(path => path.endsWith('.tmp') || path.includes('.partial') || path.endsWith('.sub')));
});

test('defaults: gallery on at Open VSX, webviews on vscode-cdn, no extra sources, no allowlist; gallery off removes its sources', async () => {
  for (const [args, gallery, sources] of [
    [[], 'https://open-vsx.org', ' https://open-vsx.org https://openvsx.eclipsecontent.org'],
    [['--gallery', 'off'], null, ''],
    [['--gallery=http://127.0.0.1:8082/'], 'http://127.0.0.1:8082', ' http://127.0.0.1:8082'],
  ] as const) {
    const [first, ...others] = await installAll(['http://127.0.0.1:9', ...args, ...LOCAL]);
    assert.equal(first.status, 0, first.stderr);
    for (const other of others) assert.deepEqual(other.files, first.files, `${other.kind} ${args.join(' ')}`);
    const config = JSON.parse(first.files['public/assets/gitea-dev/configuration.json']);
    assert.deepEqual(config, { instance: 'http://127.0.0.1:9', version: VERSION, oauthClientId: null, gallery,
      extensionsAllowlist: null, connectSrc: '', webviews: 'vscode-cdn', testMode: false });
    assert.match(first.files[`public/assets/gitea-dev/${VERSION}/${IFRAME}`], new RegExp(`connect-src 'self'${sources.replace(/\./g, '\\.')}; script-src`));
    assert.equal(first.files['public/assets/gitea-dev/index.html'], `<meta content="script-src 'self'; img-src 'self'${sources}; frame-src 'self' https://*.vscode-cdn.net">\n`);
  }
});

test('the default workbench mode is download; cdn is refused, because the CDN sends no CORS headers to a Gitea origin', async () => {
  const [first, ...others] = await installAll(['https://git.example.com']);
  assert.equal(first!.status, 0, first!.stderr);
  for (const other of others) assert.deepEqual(other.files, first!.files, other.kind);
  const assets = 'public/assets/gitea-dev';
  assert.ok(`${assets}/${VERSION}/${IFRAME}` in first!.files, 'the workbench is installed');
  assert.equal(first!.files[`${assets}/oauth-callback.html`], `<meta content="connect-src 'self' https://open-vsx.org https://openvsx.eclipsecontent.org">\n`);
  const refused = await installAll(['https://git.example.com', '--workbench=cdn']);
  sameOutput(refused);
  for (const result of refused) {
    assert.notEqual(result.status, 0, result.kind);
    assert.deepEqual(result.files, {}, result.kind);
  }
  assert.ok(refused[0]!.stderr.split('\n').includes('--workbench: got "cdn"; the CDN refuses cross-origin loads from Gitea; use download or local.'), refused[0]!.stderr);
});

test('download and local modes install the pinned workbench without its Node-only parts', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/vscode-web.tar.gz') { res.statusCode = 404; res.end(); return; }
    void readFile(ARCHIVE).then(bytes => res.end(bytes));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vscode-web.tar.gz`;
  const { root } = await release({ pin: { url } });
  try {
    const trees: Record<string, Record<string, string>> = {};
    for (const kind of shells) {
      for (const args of [LOCAL, ['--workbench=download']]) {
        const custom = join(root, `target-${kind}-${args[0]!.slice(12)}`);
        await mkdir(custom);
        const result = await runAsync(kind, root, custom, ['https://git.example.com', ...args]);
        assert.equal(result.status, 0, `${kind} ${args[0]}: ${result.stderr}`);
        trees[`${kind} ${args[0]}`] = await tree(custom);
      }
    }
    const [first, ...rest] = Object.values(trees);
    for (const [name, files] of Object.entries(trees)) assert.deepEqual(files, first, name);
    assert.equal(rest.length, shells.length * 2 - 1);
    const workbench = Object.keys(first!).filter(path => path.includes('/workbench/')).map(path => path.slice(path.indexOf('/workbench/') + 1)).sort();
    assert.deepEqual(workbench, ['workbench/extensions/a/dist/browser/main.js', CALLBACK, 'workbench/out/nls.messages.js', 'workbench/out/plain.html', IFRAME].sort());
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an archive that does not match the pinned sha256 is refused before anything is written', async () => {
  const other = join(fixtureDir, 'other.tar.gz');
  await writeFile(other, 'not the pinned archive');
  for (const args of [['--workbench=local', `--workbench-archive=${other}`], ['--workbench=local', `--workbench-archive=${join(fixtureDir, 'missing.tar.gz')}`]]) {
    for (const result of await installAll(['https://git.example.com', ...args])) {
      assert.notEqual(result.status, 0, `${result.kind} accepted ${args[1]}`);
      assert.deepEqual(result.files, {}, `${result.kind} wrote files for ${args[1]}`);
    }
  }
  const server = createServer((_req, res) => res.end('not the pinned archive'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { root } = await release({ pin: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/vscode-web.tar.gz` } });
  try {
    for (const kind of shells) {
      const custom = join(root, `target-${kind}`);
      await mkdir(custom);
      const result = await runAsync(kind, root, custom, ['https://git.example.com', '--workbench=download']);
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /does not match the pinned sha256/, kind);
      assert.deepEqual(await tree(custom), {}, kind);
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the installer rejects unsafe or malformed input before writing anything', async () => {
  const cases: string[][] = [
    ['--connect-src=*'], ['--connect-src=https:'], ['--connect-src', "'unsafe-eval'"], ['--connect-src', "'self'"],
    ['--connect-src=data:'], ['--connect-src=blob:'], ['--connect-src=https://a.example;'], ['--connect-src=https://a.example,https://b.example'],
    ['--connect-src=http://example.com'], ['--connect-src=ws://example.com'], ['--connect-src=https://*'], ['--connect-src=https://a.example/"x'],
    ['--connect-src=https://*.com'], ['--connect-src=wss://*.io:443'], ['--connect-src=https://*.example.com https://*.org'],
    ['--webviews=enabled'], ['--oauth-client-id=bad"id'], ['--oauth-client-id='], ['--extensions-allowlist=prettier'],
    ['--extensions-allowlist= , '], ['--extensions-allowlist=a.b"c'], ['--gallery=http://open-vsx.org'], ['--gallery=https://a.example/x?y'],
    ['--unknown=1'], ['--webviews'], ['--workbench=bundled'], ['--workbench=local'], ['--workbench-archive=/tmp/x.tar.gz'],
    ['--workbench=download', '--workbench-archive=/tmp/x.tar.gz'],
  ];
  const roots = [[], ['http://git.example.com'], ['https://Git.example.com'], ['https://git.example.com/a/../b'], ['ftp://git.example.com'],
    ['https://user@git.example.com'], ['https://git.example.com/#x'], ['https://git.example.com\nhttps://evil.example']];
  for (const args of [...cases.map(extra => ['https://git.example.com', ...extra]), ...roots]) {
    for (const result of await installAll(args)) {
      assert.notEqual(result.status, 0, `${result.kind} accepted ${JSON.stringify(args)}`);
      assert.doesNotMatch(result.stderr, /GITEA_CUSTOM:/, `${result.kind} refused ${JSON.stringify(args)} for the target`);
      assert.deepEqual(result.files, {}, `${result.kind} wrote files for ${JSON.stringify(args)}`);
    }
  }
});

test('existing differing templates are refused; reinstalling is idempotent', async () => {
  const results = await installAll(['https://git.example.com'], async custom => {
    await mkdir(join(custom, 'templates/custom'), { recursive: true });
    await writeFile(join(custom, 'templates/custom/extra_tabs.tmpl'), 'operator change\n');
  });
  for (const result of results) {
    assert.notEqual(result.status, 0, result.kind);
    assert.match(result.stderr, /Existing custom file differs; merge it before retrying/);
    assert.deepEqual(result.files, { 'templates/custom/extra_tabs.tmpl': 'operator change\n' }, result.kind);
  }
  const { root } = await release();
  try {
    for (const kind of shells) {
      const custom = join(root, `again-${kind}`);
      await mkdir(custom);
      assert.equal(run(kind, root, custom, ['https://git.example.com', ...LOCAL]).status, 0);
      const first = await tree(custom);
      const second = run(kind, root, custom, ['https://git.example.com', '--webviews=vscode-cdn', ...LOCAL]);
      assert.equal(second.status, 0, second.stderr);
      const after = await tree(custom);
      assert.deepEqual(Object.keys(after).sort(), Object.keys(first).sort(), kind);
      assert.match(after['public/assets/gitea-dev/configuration.json'], /"webviews":"vscode-cdn"/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('F3: a VERSION that is not <12 hex>-<12 hex> is refused before anything is touched', async () => {
  const sentinel = 'public/assets/gitea-dev/keep.txt';
  const prepare = async (custom: string) => {
    await mkdir(join(custom, 'public/assets/gitea-dev'), { recursive: true });
    await writeFile(join(custom, sentinel), 'keep\n');
  };
  for (const versionFile of ['\n', '', '..\n', '../x\n', 'a/b\n', 'abc123abc123-def456def45\n', 'ABC123ABC123-DEF456DEF456\n',
    'abc123abc123-def456def456"x\n', 'abc123abc123-def456def456\nabc123abc123-def456def456\n', 'abc123abc123-def456def456 \n']) {
    for (const result of await installAll(['https://git.example.com'], prepare, { versionFile })) {
      assert.notEqual(result.status, 0, `${result.kind} accepted VERSION ${JSON.stringify(versionFile)}`);
      assert.deepEqual(result.files, { [sentinel]: 'keep\n' }, `${result.kind} changed the target for VERSION ${JSON.stringify(versionFile)}`);
    }
  }
});

test('F8: an operator-edited shortcut.js is refused like a template, and nothing else is written', async () => {
  const results = await installAll(['https://git.example.com'], async custom => {
    await mkdir(join(custom, 'public/assets/gitea-dev'), { recursive: true });
    await writeFile(join(custom, 'public/assets/gitea-dev/shortcut.js'), 'operator();\n');
  });
  for (const result of results) {
    assert.notEqual(result.status, 0, result.kind);
    assert.match(result.stderr, /Existing custom file differs; merge it before retrying/);
    assert.deepEqual(result.files, { 'public/assets/gitea-dev/shortcut.js': 'operator();\n' }, result.kind);
  }
});

test('F8: a failure while staging the assets leaves the target without templates', async () => {
  for (const result of await installAll(['https://git.example.com'], undefined, { omitVersionDir: true })) {
    assert.notEqual(result.status, 0, result.kind);
    assert.deepEqual(result.files, {}, `${result.kind} wrote files before the install could complete`);
  }
});

test('F8: reinstalling over a live version directory replaces it and leaves no aside copy', async () => {
  const { root } = await release();
  try {
    for (const kind of shells) {
      const custom = join(root, `swap-${kind}`);
      await mkdir(custom);
      assert.equal(run(kind, root, custom, ['https://git.example.com', ...LOCAL]).status, 0);
      await writeFile(join(custom, `public/assets/gitea-dev/${VERSION}/stale.txt`), 'stale\n');
      assert.equal(run(kind, root, custom, ['https://git.example.com', '--gallery=off', ...LOCAL]).status, 0);
      const after = await tree(custom);
      assert.ok(!(`public/assets/gitea-dev/${VERSION}/stale.txt` in after), kind);
      assert.ok(!Object.keys(after).some(path => /(\.tmp|\.old|\.sub)$|\.partial/.test(path)), kind);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Validation of what the parameters mean, not only their form. Each problem is one line naming the
// argument, the value found and the value expected; every shell prints the same lines.
const sameOutput = (results: { kind: string; stderr: string }[]) => {
  const own = ({ kind, stderr }: { kind: string; stderr: string }) => stderr.split(`target-${kind}`).join('target-KIND');
  for (const other of results.slice(1)) assert.equal(own(other), own(results[0]!), other.kind);
};
const appIni = (text: string) => async (custom: string) => {
  await mkdir(join(custom, 'conf'), { recursive: true });
  await writeFile(join(custom, 'conf/app.ini'), text);
};

test('every problem is reported, one line each, identically under every shell', async () => {
  const results = await installAll(['https://git.example.com', '--bogus=1', '--webviews=maybe', '--workbench=bundled', '--connect-src=*', '--gallery=ftp://x', '--app-ini']);
  sameOutput(results);
  const lines = results[0]!.stderr.split('\n');
  for (const expected of [
    '--bogus: unknown option; expected one of --oauth-client-id, --webviews, --connect-src, --extensions-allowlist, --gallery, --workbench, --workbench-archive, --app-ini.',
    '--app-ini: needs a value; write --app-ini=VALUE.',
    '--workbench: got "bundled"; expected download or local.',
    '--webviews: got "maybe"; expected disabled or vscode-cdn.',
    '--connect-src: source "*" not allowed; expected https://host or wss://host (a leading *. needs two more labels) or loopback http:// or ws://; no *, bare schemes, keywords, data: or blob:.',
    '--gallery: got "ftp://x"; expected off, or an https URL, or http on localhost, 127.0.0.1 or [::1], with a lowercase host and a plain path.',
  ]) assert.ok(lines.includes(expected), `missing: ${expected}\n${results[0]!.stderr}`);
  assert.ok(lines.indexOf('--bogus: unknown option; expected one of --oauth-client-id, --webviews, --connect-src, --extensions-allowlist, --gallery, --workbench, --workbench-archive, --app-ini.') < lines.indexOf('--workbench: got "bundled"; expected download or local.'));
  assert.match(results[0]!.stderr, /^Usage: install GITEA_CUSTOM \[ROOT_URL\]/m);
  for (const result of results) assert.deepEqual(result.files, {}, result.kind);
});

test('an option that does not apply to the chosen mode is refused', async () => {
  for (const args of [[`--workbench-archive=${ARCHIVE}`], ['--workbench=download', `--workbench-archive=${ARCHIVE}`]]) {
    const results = await installAll(['https://git.example.com', ...args]);
    sameOutput(results);
    assert.notEqual(results[0]!.status, 0);
    assert.ok(results[0]!.stderr.includes(`--workbench-archive: got "${ARCHIVE}"; applies only to --workbench=local; remove it or add --workbench=local.`), results[0]!.stderr);
  }
  const results = await installAll(['https://git.example.com', '--workbench=local']);
  sameOutput(results);
  assert.ok(results[0]!.stderr.includes('--workbench=local: needs --workbench-archive=PATH, the pinned workbench archive.'));
});

test('GITEA_CUSTOM must be an existing, writable directory that looks like Gitea\'s custom directory', async () => {
  const cases: [string, (root: string, kind: string) => Promise<string> | string, RegExp][] = [
    ['missing', (root, kind) => join(root, `missing-${kind}`), /^GITEA_CUSTOM: got ".*missing-[a-z]+"; no such directory; pass Gitea's custom directory \(CustomPath in "gitea help"\)\.$/m],
    ['file', async (root, kind) => { await writeFile(join(root, `file-${kind}`), 'x'); return join(root, `file-${kind}`); }, /^GITEA_CUSTOM: got ".*file-[a-z]+"; not a directory/m],
    ['unrelated', async (root, kind) => { await mkdir(join(root, `other-${kind}`)); await writeFile(join(root, `other-${kind}/notes.txt`), 'x'); return join(root, `other-${kind}`); },
      /^GITEA_CUSTOM: got ".*other-[a-z]+"; does not look like Gitea's custom directory \(expected it empty or holding conf, public, templates or options\)\.$/m],
  ];
  if (process.getuid?.() !== 0) {
    cases.push(['read-only', async (root, kind) => { await mkdir(join(root, `ro-${kind}`), { mode: 0o555 }); return join(root, `ro-${kind}`); }, /^GITEA_CUSTOM: got ".*ro-[a-z]+"; not writable; run the installer as the user that owns it\.$/m]);
  }
  for (const [name, make, expected] of cases) {
    const { root } = await release();
    try {
      const results = [];
      for (const kind of shells) results.push({ kind, ...await runAsync(kind, root, await make(root, kind), ['https://git.example.com']) });
      for (const result of results) {
        assert.notEqual(result.status, 0, `${result.kind} ${name}`);
        assert.match(result.stderr, expected, `${result.kind} ${name}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('ROOT_URL must equal [server] ROOT_URL of Gitea\'s app.ini, found in GITEA_CUSTOM/conf or given with --app-ini', async () => {
  const mismatch = await installAll(['https://git.example.com/', ...LOCAL], appIni('[server]\nROOT_URL = https://code.example.com/\n'));
  sameOutput(mismatch);
  assert.notEqual(mismatch[0]!.status, 0);
  assert.match(mismatch[0]!.stderr, /^ROOT_URL: got "https:\/\/git\.example\.com"; \/.*\/conf\/app\.ini has \[server\] ROOT_URL = https:\/\/code\.example\.com\/; pass that URL\.$/m);
  for (const result of mismatch) assert.deepEqual(Object.keys(result.files), ['conf/app.ini'], result.kind);
  // Quoted values, comments, ":" delimiters and other sections are read as Gitea reads them.
  const matching = await installAll(['https://git.example.com/git/', ...LOCAL],
    appIni('APP_NAME = x\n[database]\nROOT_URL = https://wrong.example.com/\n[server]\nROOT_URL = https://old.example.com/\n  ROOT_URL : "https://git.example.com/git/" ; comment\n'));
  for (const result of matching) assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
  const elsewhere = join(fixtureDir, 'elsewhere-app.ini');
  await writeFile(elsewhere, '[server]\nROOT_URL = https://code.example.com/\n');
  const pointed = await installAll(['https://git.example.com', ...LOCAL, `--app-ini=${elsewhere}`]);
  sameOutput(pointed);
  assert.ok(pointed[0]!.stderr.includes(`ROOT_URL: got "https://git.example.com"; ${elsewhere} has [server] ROOT_URL = https://code.example.com/; pass that URL.`), pointed[0]!.stderr);
  const missing = await installAll(['https://git.example.com', ...LOCAL, `--app-ini=${join(fixtureDir, 'none.ini')}`]);
  sameOutput(missing);
  assert.ok(missing[0]!.stderr.includes(`--app-ini: got "${join(fixtureDir, 'none.ini')}"; not a readable file; pass the app.ini Gitea runs with (ConfigFile in "gitea help").`));
  const unchecked = await installAll(['https://git.example.com', ...LOCAL]);
  for (const result of unchecked) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^Note: GITEA_CUSTOM has no conf\/app\.ini; skipped the app\.ini checks \(pass --app-ini=PATH when Gitea reads its configuration elsewhere\)\.$/m);
  }
});

test('ROOT_URL, when left out, is [server] ROOT_URL of the app.ini found in GITEA_CUSTOM/conf or given with --app-ini', async () => {
  const derived = await installAll(['--oauth-client-id=abc', ...LOCAL], appIni('[server]\nROOT_URL = "https://git.example.com/git/" ; comment\n'));
  for (const result of derived) {
    assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
    assert.equal(JSON.parse(result.files['public/assets/gitea-dev/configuration.json']!).instance, 'https://git.example.com/git', result.kind);
    assert.match(result.stderr, /^Note: ROOT_URL: not given; using \[server\] ROOT_URL = https:\/\/git\.example\.com\/git\/ from \/.*\/conf\/app\.ini\.$/m);
  }
  const elsewhere = join(fixtureDir, 'derive-app.ini');
  await writeFile(elsewhere, '[server]\nROOT_URL = https://code.example.com/\n');
  for (const result of await installAll([...LOCAL, `--app-ini=${elsewhere}`])) {
    assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
    assert.equal(JSON.parse(result.files['public/assets/gitea-dev/configuration.json']!).instance, 'https://code.example.com', result.kind);
  }
  for (const [name, args, prepare, expected] of [
    ['no app.ini', [...LOCAL], undefined, /^ROOT_URL: not given, and .* has no conf\/app\.ini to read it from; pass ROOT_URL or --app-ini=PATH\.$/m],
    ['no ROOT_URL in it', [...LOCAL], appIni('[server]\nHTTP_PORT = 3000\n'), /^ROOT_URL: not given, and \/.*\/conf\/app\.ini sets no literal \[server\] ROOT_URL; pass ROOT_URL\.$/m],
    ['variable ROOT_URL', [...LOCAL], appIni('[server]\nROOT_URL = %(PROTOCOL)s://%(DOMAIN)s/\n'), /sets no literal \[server\] ROOT_URL; pass ROOT_URL\.$/m],
    ['invalid ROOT_URL', [...LOCAL], appIni('[server]\nROOT_URL = ftp://x/\n'), /^ROOT_URL: not given; \/.*\/conf\/app\.ini has \[server\] ROOT_URL = "ftp:\/\/x\/"; expected an https URL/m],
  ] as const) {
    const results = await installAll([...args], prepare);
    sameOutput(results);
    assert.notEqual(results[0]!.status, 0, name);
    assert.match(results[0]!.stderr, expected, name);
    for (const result of results) assert.equal(result.files['public/assets/gitea-dev/configuration.json'], undefined, `${name}: ${result.kind} wrote files`);
  }
  // A ROOT_URL on the command line still wins and is still compared with the app.ini.
  const given = await installAll(['https://git.example.com/', ...LOCAL], appIni('[server]\nROOT_URL = https://git.example.com/\n'));
  for (const result of given) assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
});

test('--test-mode, left out of the usage text, writes the test hook flag', async () => {
  const [first, ...others] = await installAll(['http://127.0.0.1:9', '--test-mode']);
  assert.equal(first!.status, 0, first!.stderr);
  for (const other of others) assert.deepEqual(other.files, first!.files, other.kind);
  assert.equal(JSON.parse(first!.files['public/assets/gitea-dev/configuration.json']!).testMode, true);
  const refused = await installAll(['http://127.0.0.1:9', '--test-mode=yes', '--bogus', 'x']);
  for (const result of refused) {
    assert.notEqual(result.status, 0, result.kind);
    assert.ok(result.stderr.includes('--test-mode: unknown option'), result.stderr);
    assert.ok(!/--test-mode[^:=]/.test(result.stderr.replace('--test-mode: unknown option', '')), 'usage and option lists leave it out');
  }
});

test('an unreadable --workbench-archive is refused', { skip: process.getuid?.() === 0 && 'root reads every file' }, async () => {
  const locked = join(fixtureDir, 'locked.tar.gz');
  await cp(ARCHIVE, locked);
  await chmod(locked, 0o000);
  const results = await installAll(['https://git.example.com', '--workbench=local', `--workbench-archive=${locked}`]);
  sameOutput(results);
  assert.ok(results[0]!.stderr.includes(`--workbench-archive: got "${locked}"; not a readable file; pass the archive from the url in the release's workbench.json.`));
});

test('--webviews is vscode-cdn unless given', async () => {
  for (const [args, webviews] of [
    [[], 'vscode-cdn'], [['--webviews=disabled'], 'disabled'], [LOCAL, 'vscode-cdn'], [[...LOCAL, '--webviews=disabled'], 'disabled'],
  ] as const) {
    const results = await installAll(['https://git.example.com', ...args]);
    for (const result of results) {
      assert.equal(result.status, 0, `${result.kind} ${args.join(' ')}: ${result.stderr}`);
      assert.equal(JSON.parse(result.files['public/assets/gitea-dev/configuration.json']!).webviews, webviews, `${result.kind} ${args.join(' ')}`);
    }
    for (const other of results.slice(1)) assert.deepEqual(other.files, results[0]!.files);
  }
});

const FAKE_CLIENT = '6f3c2a1e-0b0d-4c55-9a37-5d1c9e8f7a10';
// A stand-in for Gitea 1.24.6 over HTTPS, answering as the real one does (version JSON, appUrl in pages,
// and the OAuth token endpoint's errors for an invalid code).
interface AppRequest { method: string; authorization?: string; body: string }
async function fakeGitea(behavior: {
  gitea?: boolean; gateway?: boolean; appUrl?: string; clients?: Record<string, 'public' | 'confidential' | 'elsewhere'>;
  /** The token the user API accepts, the applications it lists, and the requests it received. */
  token?: string; apps?: Record<string, unknown>[]; requests?: AppRequest[];
  /** Gitea before 1.23 and Forgejo: the application API has no skip_secondary_authorization field. */
  noSkipField?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), 'gitea-dev-tls-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]);
  assert.equal(made.status, 0, 'openssl');
  let base = '';
  const server = createHttpsServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, (req, res) => {
    const path = new URL(req.url ?? '/', base).pathname;
    if (behavior.gitea === false) { res.statusCode = 404; res.end('not found'); return; }
    if (behavior.gateway) { res.statusCode = 502; res.end('Bad Gateway'); return; }
    if (path === '/api/v1/version') res.end('{"version":"1.24.6"}');
    else if (path === '/api/v1/user/applications/oauth2') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        behavior.requests?.push({ method: req.method ?? '', authorization: req.headers.authorization, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.authorization !== `token ${behavior.token}`) { res.statusCode = 401; res.end('{"message":"token is required"}'); return; }
        if (req.method === 'GET') { res.end(JSON.stringify(behavior.apps ?? [])); return; }
        res.statusCode = 201;
        const created = { id: 1, client_id: FAKE_CLIENT, client_secret: 'secret', ...JSON.parse(body) };
        if (behavior.noSkipField) delete created.skip_secondary_authorization;
        res.end(JSON.stringify(created));
      });
    } else if (path === '/login/oauth/access_token') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const kind = behavior.clients?.[JSON.parse(body).client_id];
        const [error, description] = kind === undefined ? ['invalid_client', `cannot load client with client id: '${JSON.parse(body).client_id}'`]
          : kind === 'confidential' ? ['unauthorized_client', 'invalid empty client secret']
          : kind === 'elsewhere' ? ['unauthorized_client', 'unexpected redirect URI'] : ['unauthorized_client', 'client is not authorized'];
        res.statusCode = 400;
        res.end(JSON.stringify({ error, error_description: description }));
      });
    } else {
      res.statusCode = 404;
      res.end(`<html><script>window.config = {appUrl: '${(behavior.appUrl ?? `${base}/`).replace(/\//g, '\\/')}', appSubUrl: ''};</script></html>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { CURL_CA_BUNDLE: join(dir, 'cert.pem'), NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') };
  return { base, env, close: async () => { server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('--create-oauth-app finds or creates the public OAuth application with GITEA_TOKEN and installs its Client ID', { skip: spawnSync('openssl', ['version']).status !== 0 && 'needs openssl' }, async () => {
  const TOKEN = 'abcdef0123456789abcdef0123456789abcdef01';
  const clientIdOf = (files: Record<string, string>) => JSON.parse(files['public/assets/gitea-dev/configuration.json']!).oauthClientId;
  const app = (base: string, extra: Record<string, unknown> = {}) => ({ id: 7, name: 'Gitea Web IDE', client_id: 'existing-client-id', confidential_client: false,
    skip_secondary_authorization: true, redirect_uris: [`${base}/assets/gitea-dev/oauth-callback.html`], ...extra });
  const run = async (behavior: Parameters<typeof fakeGitea>[0], args: string[], env: Record<string, string> = { GITEA_TOKEN: TOKEN }, apps?: (base: string) => Record<string, unknown>[]) => {
    const requests: AppRequest[] = [];
    const options: Parameters<typeof fakeGitea>[0] = { token: TOKEN, ...behavior, requests };
    const gitea = await fakeGitea(options);
    try {
      if (apps) options.apps = apps(gitea.base);
      return { requests, base: gitea.base, results: await installAll([gitea.base, ...LOCAL, ...args], undefined, { env: { ...gitea.env, ...env } }) };
    } finally { await gitea.close(); }
  };

  // Not there yet: created once per shell, as a public client with the callback, the token sent as a header.
  const created = await run({}, ['--create-oauth-app']);
  for (const result of created.results) {
    assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
    assert.equal(clientIdOf(result.files), FAKE_CLIENT, result.kind);
    assert.ok(result.stderr.includes(`Created OAuth application "Gitea Web IDE" with Client ID ${FAKE_CLIENT}`), result.stderr);
    assert.ok(!result.stderr.includes(TOKEN), `${result.kind} printed the token`);
    assert.doesNotMatch(result.stderr, /no "skip authorization" option/, result.kind);
  }
  const posts = created.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, created.results.length);
  assert.deepEqual(JSON.parse(posts[0]!.body), { name: 'Gitea Web IDE', confidential_client: false, skip_secondary_authorization: true,
    redirect_uris: [`${created.base}/assets/gitea-dev/oauth-callback.html`] });
  assert.ok(created.requests.every(request => request.authorization === `token ${TOKEN}`));

  // Already there with the right settings: reused, nothing created.
  const found = await run({}, ['--create-oauth-app'], undefined, base => [{ id: 1, name: 'Other', client_id: 'other-client-id' }, app(base)]);
  for (const result of found.results) {
    assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
    assert.equal(clientIdOf(result.files), 'existing-client-id', result.kind);
    assert.ok(result.stderr.includes('Found OAuth application "Gitea Web IDE" with Client ID existing-client-id'), result.stderr);
  }
  assert.equal(found.requests.filter(request => request.method === 'POST').length, 0);

  // A server without the option (Gitea before 1.23, Forgejo): created or reused, with a note that sign-in is not silent.
  const withoutField = (value: Record<string, unknown>) => { const { skip_secondary_authorization: _omitted, ...rest } = value; return rest; };
  const bareCreated = await run({ noSkipField: true }, ['--create-oauth-app']);
  const bareFound = await run({ noSkipField: true }, ['--create-oauth-app'], undefined, base => [withoutField(app(base))]);
  for (const [name, runResult, action, id] of [['created', bareCreated, 'Created', FAKE_CLIENT], ['found', bareFound, 'Found', 'existing-client-id']] as const) {
    for (const result of runResult.results) {
      assert.equal(result.status, 0, `${name} ${result.kind}: ${result.stderr}`);
      assert.equal(clientIdOf(result.files), id, `${name} ${result.kind}`);
      assert.ok(result.stderr.includes(`${action} OAuth application "Gitea Web IDE" with Client ID ${id}`), result.stderr);
      assert.match(result.stderr, /^Note: this server has no "skip authorization" option for OAuth applications \(Gitea before 1\.23, Forgejo\)/m, `${name} ${result.kind}`);
    }
  }
  assert.equal(bareFound.requests.filter(request => request.method === 'POST').length, 0);

  // Refused, with nothing installed.
  const refusals: [string, Parameters<typeof fakeGitea>[0], string[], Record<string, string> | undefined, ((base: string) => Record<string, unknown>[]) | undefined, string | RegExp][] = [
    ['confidential', {}, ['--create-oauth-app'], undefined, base => [app(base, { confidential_client: true })], 'the OAuth application "Gitea Web IDE" is confidential'],
    ['asks each time', {}, ['--create-oauth-app'], undefined, base => [app(base, { skip_secondary_authorization: false })], 'does not skip authorization for public clients'],
    ['other redirect', {}, ['--create-oauth-app'], undefined, () => [app('https://elsewhere.example')], /lacks the redirect URI https:\/\/127\.0\.0\.1:\d+\/assets\/gitea-dev\/oauth-callback\.html/],
    ['wrong token', {}, ['--create-oauth-app'], { GITEA_TOKEN: 'ffffffffffffffffffffffffffffffffffffffff' }, undefined, /^--create-oauth-app: Gitea refused GITEA_TOKEN \(HTTP 401\)/m],
    ['no token', {}, ['--create-oauth-app'], { GITEA_TOKEN: '' }, undefined, /^--create-oauth-app: needs the environment variable GITEA_TOKEN/m],
    ['odd token', {}, ['--create-oauth-app'], { GITEA_TOKEN: 'a b' }, undefined, /^--create-oauth-app: GITEA_TOKEN holds characters a Gitea token never has\.$/m],
    ['with a client id', {}, ['--create-oauth-app', '--oauth-client-id=abc'], undefined, undefined, /^--create-oauth-app: cannot be combined with --oauth-client-id/m],
  ];
  for (const [name, extra, args, env, apps, expected] of refusals) {
    const refused = await run({ ...extra }, args, env, apps);
    sameOutput(refused.results);
    for (const result of refused.results) {
      assert.notEqual(result.status, 0, `${result.kind} ${name}`);
      assert.equal(result.files['public/assets/gitea-dev/configuration.json'], undefined, `${result.kind} ${name} wrote files`);
      if (typeof expected === 'string') assert.ok(result.stderr.includes(expected), `${result.kind} ${name}: ${result.stderr}`);
      else assert.match(result.stderr, expected, `${result.kind} ${name}`);
    }
    assert.ok(!refused.results[0]!.stderr.includes('ffffffffffffffffffffffffffffffffffffffff'), `${name} printed the token`);
  }

  // Nothing answers at ROOT_URL: refused rather than installed without an application.
  const silent = await installAll(['https://127.0.0.1:9', ...LOCAL, '--create-oauth-app'], undefined, { env: { GITEA_TOKEN: TOKEN } });
  sameOutput(silent);
  for (const result of silent) {
    assert.notEqual(result.status, 0, result.kind);
    assert.match(result.stderr, /^--create-oauth-app: Gitea is not reachable at https:\/\/127\.0\.0\.1:9;/m);
    assert.equal(result.files['public/assets/gitea-dev/configuration.json'], undefined, `${result.kind} wrote files`);
  }
});

test('a running Gitea at ROOT_URL is checked: it is Gitea, its ROOT_URL, and the OAuth application', { skip: spawnSync('openssl', ['version']).status !== 0 && 'needs openssl' }, async () => {
  const client = 'd22e588f-d1bd-42af-84ef-7f888fa2d355';
  const cases: [string, Parameters<typeof fakeGitea>[0], (base: string) => string[], string | RegExp | null][] = [
    ['valid', { clients: { [client]: 'public' } }, () => [`--oauth-client-id=${client}`], null],
    ['proxy without Gitea', { gateway: true }, () => [`--oauth-client-id=${client}`], null],
    ['not Gitea', { gitea: false }, () => [...LOCAL], /^ROOT_URL: got "https:\/\/127\.0\.0\.1:\d+"; https:\/\/127\.0\.0\.1:\d+\/api\/v1\/version answered HTTP 404 without a Gitea version; pass Gitea's ROOT_URL\.$/m],
    ['other ROOT_URL', { appUrl: 'https://git.example.com/' }, () => [...LOCAL], /^ROOT_URL: got "https:\/\/127\.0\.0\.1:\d+"; Gitea at that address reports ROOT_URL https:\/\/git\.example\.com\/; pass that URL\.$/m],
    ['unknown client', {}, () => [`--oauth-client-id=${client}`], `--oauth-client-id: got "${client}"; Gitea has no OAuth application with this Client ID.`],
    ['confidential client', { clients: { [client]: 'confidential' } }, () => [`--oauth-client-id=${client}`], `--oauth-client-id: got "${client}"; the application is confidential; register a public one (confidential_client false).`],
    ['other redirect', { clients: { [client]: 'elsewhere' } }, () => [`--oauth-client-id=${client}`], /^--oauth-client-id: got "d22e588f-d1bd-42af-84ef-7f888fa2d355"; the application lacks the redirect URI https:\/\/127\.0\.0\.1:\d+\/assets\/gitea-dev\/oauth-callback\.html; add it\.$/m],
  ];
  for (const [name, behavior, args, expected] of cases) {
    const gitea = await fakeGitea(behavior);
    try {
      const results = await installAll([gitea.base, ...args(gitea.base)], undefined, { env: gitea.env });
      sameOutput(results);
      for (const result of results) {
        if (expected === null) assert.equal(result.status, 0, `${result.kind} ${name}: ${result.stderr}`);
        else {
          assert.notEqual(result.status, 0, `${result.kind} ${name}`);
          if (typeof expected === 'string') assert.ok(result.stderr.split('\n').includes(expected), `${result.kind} ${name}: ${result.stderr}`);
          else assert.match(result.stderr, expected, `${result.kind} ${name}`);
        }
      }
      if (name === 'valid') assert.doesNotMatch(results[0]!.stderr, /Note: Gitea/);
      if (name === 'proxy without Gitea') assert.match(results[0]!.stderr, /^Note: https:\/\/127\.0\.0\.1:\d+\/api\/v1\/version answered HTTP 502, so Gitea is not running behind it; skipped the online checks of ROOT_URL and --oauth-client-id\.$/m);
    } finally { await gitea.close(); }
  }
  // Nothing answers: the online checks are skipped with a note and the install goes ahead.
  const skipped = await installAll(['https://127.0.0.1:9', `--oauth-client-id=${client}`]);
  sameOutput(skipped);
  for (const result of skipped) {
    assert.equal(result.status, 0, `${result.kind}: ${result.stderr}`);
    assert.ok(result.stderr.includes('Note: Gitea is not reachable at https://127.0.0.1:9/api/v1/version; skipped the online checks of ROOT_URL and --oauth-client-id.'), result.stderr);
  }
});
