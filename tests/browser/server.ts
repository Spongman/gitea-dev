// Browser test deployment: a disposable Gitea serves the installed static editor itself on
// BROWSER_PORT. A second origin serves the fixture gallery (CORS like Open VSX) and test controls.
// The workbench mode comes from tests/helpers/workbench.ts; BROWSER_HTTPS=1 serves Gitea over HTTPS,
// which WebKit needs for BROWSER_WORKBENCH=cdn.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGitea } from '../helpers/gitea.js';
import { allowlist, createGalleryServer } from '../helpers/gallery.js';
import { browserGiteaIni, browserWorkbench } from '../helpers/workbench.js';
// @ts-ignore untyped .mjs module
import { install } from '../../scripts/run-installer.mjs';

const port = Number(process.env.BROWSER_PORT ?? 8081);
const galleryPort = Number(process.env.BROWSER_GALLERY_PORT ?? 8082);
const tls = process.env.BROWSER_HTTPS === '1';
const instance = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
const galleryOrigin = `http://127.0.0.1:${galleryPort}`;
// One account per Playwright worker slot (tests/browser/fixtures.ts), so parallel workers never share user state.
const slots = Array.from({ length: Number(process.env.BROWSER_WORKERS ?? 4) }, (_, i) => `owner-w${i}`);
const options = { rootUrl: instance, gallery: galleryOrigin, extensionsAllowlist: allowlist.join(' '), testMode: true, ...browserWorkbench };

/** A throwaway self-signed certificate for 127.0.0.1. */
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-dev-tls-'));
  try {
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`openssl: ${result.stderr}`);
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The fixture's own API calls to Gitea must accept the throwaway certificate.
if (tls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const gitea = await startGitea({
  users: ['owner', ...slots].map(name => ({ name, tokens: { full: ['all'] } })), port, lfs: true,
  https: tls ? selfSigned() : undefined, extraIni: browserGiteaIni,
  custom: custom => install({ ...options, custom }),
});
for (const user of ['owner', ...slots]) {
  await gitea.createRepo(user, 'browser-fixture');
  await gitea.createRepo(user, 'browser-private', { private: true });
  await gitea.commitFiles(user, 'browser-fixture', 'main', 'Browser fixture', [
    { operation: 'create', path: 'hello.txt', content: 'Hello from Gitea.\n' },
    { operation: 'create', path: 'src/value.ts', content: 'export const answer = 42;\n' },
    { operation: 'create', path: 'src/main.ts', content: "import { answer } from './value';\nconsole.log(answer);\n" },
    { operation: 'create', path: 'image.bin', content: new Uint8Array([0, 1, 127, 128, 255]) },
  ]);
}
const oauth = await gitea.createOAuthApp({ name: 'owner' }, {
  name: 'Web IDE browser test', redirectUris: [`${instance}/assets/gitea-dev/oauth-callback.html`],
});
// The client id exists only once Gitea runs; static files are read per request, so reinstalling is enough.
await install({ ...options, custom: gitea.customDir, oauthClientId: oauth.clientId });

const send = (res: import('node:http').ServerResponse, body: unknown) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
// ?worker=<parallelIndex> selects that slot's account; without it, `owner`.
const accountOf = (url: URL) => {
  const worker = url.searchParams.get('worker');
  const name = worker === null ? 'owner' : `owner-w${worker}`;
  return gitea.users.has(name) ? name : undefined;
};
const server = createGalleryServer(galleryOrigin, (req, res) => {
  const url = new URL(req.url ?? '/', galleryOrigin);
  const account = accountOf(url);
  if (url.pathname === '/__test/ready') res.end('ready');
  else if (url.pathname === '/__test/token' || url.pathname === '/__test/login') {
    if (account) send(res, url.pathname === '/__test/token' ? { token: gitea.token(account) } : { username: account, password: gitea.password(account) });
    else {
      res.statusCode = 404;
      send(res, { error: `no account for worker ${url.searchParams.get('worker')}; set BROWSER_WORKERS to at least the worker count` });
    }
  }
  else if (url.pathname === '/__test/frame') {
    // A cross-origin page that tries to embed the editor.
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><iframe src="${instance}/assets/gitea-dev/index.html?owner=owner&amp;repository=browser-fixture&amp;ref=main"></iframe>`);
  }
  else return false;
  return true;
});
server.listen(galleryPort, '127.0.0.1', () => console.log(`Browser test Gitea on ${instance} (workbench ${options.workbench}), gallery and controls on ${galleryPort}`));
const stop = async () => {
  server.closeAllConnections(); server.close(); await gitea.stop(); process.exit();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
