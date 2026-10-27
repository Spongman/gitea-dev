// Gitea under a sub-path (ROOT_URL http://host/git/). Gitea cannot serve a sub-path itself: it expects the
// operator's proxy to strip the prefix, so the fixture puts a prefix-stripping proxy in front, a TEST
// stand-in for that setup. This spec has its own Gitea, gallery and install; the default harness is untouched.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import net from 'node:net';
import { startGitea, type GiteaFixture } from '../helpers/gitea.js';
import { allowlist, createGalleryServer } from '../helpers/gallery.js';
import { browserGiteaIni, browserWorkbench } from '../helpers/workbench.js';
// @ts-ignore untyped .mjs module
import { install } from '../../scripts/run-installer.mjs';
import { command, activeEditor, replaceEditorText, withoutTrustPrompt } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

let gitea: GiteaFixture;
let gallery: ReturnType<typeof createGalleryServer>;
let galleryOrigin: string;
let base: string; // http://127.0.0.1:<proxy>/git
let origin: string;
const editor = (repo = 'sub-fixture') => `${base}/assets/gitea-dev/index.html?owner=owner&repository=${repo}&ref=main&refKind=branch`;

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const galleryPort = await freePort();
  galleryOrigin = `http://127.0.0.1:${galleryPort}`;
  const options = { gallery: galleryOrigin, extensionsAllowlist: allowlist.join(' '), testMode: true, ...browserWorkbench };
  gitea = await startGitea({
    subPath: '/git', users: [{ name: 'owner', tokens: { full: ['all'] } }], extraIni: browserGiteaIni,
    // The template must exist before Gitea starts; the real ROOT_URL is known only afterwards.
    custom: custom => install({ ...options, rootUrl: 'http://127.0.0.1:9/git/', custom }),
  });
  base = gitea.baseUrl;
  origin = new URL(base).origin;
  await gitea.createRepo('owner', 'sub-fixture');
  await gitea.commitFiles('owner', 'sub-fixture', 'main', 'Sub-path fixture', [
    { operation: 'create', path: 'hello.txt', content: 'Hello from a sub-path.\n' },
  ]);
  const oauth = await gitea.createOAuthApp({ name: 'owner' }, {
    name: 'Web IDE sub-path test', redirectUris: [`${base}/assets/gitea-dev/oauth-callback.html`],
  });
  await install({ ...options, rootUrl: `${base}/`, custom: gitea.customDir, oauthClientId: oauth.clientId });
  gallery = createGalleryServer(galleryOrigin);
  await new Promise<void>(resolve => gallery.listen(galleryPort, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  gallery?.closeAllConnections(); gallery?.close();
  await gitea?.stop();
});

async function waitReady(page: Page) {
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function ready(page: Page, repo?: string) {
  await page.goto(editor(repo));
  await waitReady(page);
}

async function signInOAuth(page: Page, context: BrowserContext) {
  const popupEvent = context.waitForEvent('page');
  const pending = command(page, 'gitea.signInOAuth');
  const popup = await popupEvent;
  await popup.waitForLoadState('domcontentloaded');
  await popup.locator('input[name="user_name"]').fill('owner');
  await popup.locator('input[name="password"]').fill(gitea.password('owner'));
  await popup.getByRole('button', { name: /sign in/i }).click();
  void popup.getByRole('button', { name: /authorize/i }).click().catch(() => undefined);
  expect(await pending).toMatchObject({ ok: true, auth: 'oauth' });
  if (!popup.isClosed()) await popup.waitForEvent('close', { timeout: 10_000 });
}

async function openFile(page: Page, path: string) {
  await page.evaluate(async path => {
    const folder = (globalThis as any).__giteaFolderUri;
    await (globalThis as any).__giteaWorkbench.commands.executeCommand('vscode.open', folder.with({ path: `/${path}` }));
  }, path);
  await expect(activeEditor(page).locator('[role="textbox"]')).toBeAttached();
}

async function replaceFile(page: Page, text: string) {
  await replaceEditorText(page, text);
  await command(page, 'workbench.action.files.save');
}

/** Same-origin requests outside the sub-path would hit the proxy's 404 (or a different app). */
function watchOutside(page: Page) {
  const outside: string[] = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (/^https?:$/.test(url.protocol) && url.origin === origin && !url.pathname.startsWith('/git/')) outside.push(req.url());
  });
  return outside;
}

test('Gitea serves a sub-path only behind a prefix-stripping proxy', async () => {
  // Evidence for the stand-in: Gitea (ROOT_URL .../git/) answers at its root, not under /git.
  expect((await fetch(`${gitea.directUrl}/assets/gitea-dev/index.html`)).status).toBe(200);
  expect((await fetch(`${gitea.directUrl}/git/assets/gitea-dev/index.html`)).status).toBe(404);
  expect((await fetch(`${base}/assets/gitea-dev/index.html`)).status).toBe(200);
});

test('the workbench loads under the sub-path, isolated, with the service worker scoped to it', async ({ page }) => {
  const outside = watchOutside(page);
  await ready(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const worker = await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return { controller: navigator.serviceWorker.controller?.scriptURL, scopes: registrations.map(r => r.scope) };
  });
  expect(worker.controller).toBe(`${base}/assets/gitea-dev/coi-sw.js`);
  expect(worker.scopes).toEqual([`${base}/assets/gitea-dev/`]);
  expect(await page.evaluate(() => (globalThis as any).__giteaLaunch.instance)).toBe(base);
  const served = await page.evaluate(async () => Object.fromEntries((await fetch(location.href)).headers));
  expect(served).toMatchObject({ 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
  const iframe = page.locator('iframe.web-worker-ext-host-iframe');
  await expect(iframe).toHaveAttribute('src', new RegExp(`^${base}/assets/gitea-dev/[0-9a-f]{12}-[0-9a-f]{12}/workbench/`));
  expect(await iframe.evaluate(frame => (frame as HTMLIFrameElement).contentWindow?.crossOriginIsolated)).toBe(true);
  expect(outside).toEqual([]);
});

test('the launch link and the period shortcut open the editor under the sub-path', async ({ page, context }) => {
  await page.goto(`${base}/owner/sub-fixture`);
  const link = page.locator('a[data-gitea-dev-launch]').first();
  await expect(link).toHaveAttribute('href', '/git/assets/gitea-dev/index.html?owner=owner&repository=sub-fixture&ref=main&refKind=branch');
  await page.locator('body').focus();
  const popup = context.waitForEvent('page');
  await page.keyboard.press('.');
  const opened = await popup;
  await opened.waitForURL(/\/assets\/gitea-dev\/index\.html\?owner=owner/);
  expect(new URL(opened.url()).pathname).toBe('/git/assets/gitea-dev/index.html');
  await waitReady(opened);
  expect(await opened.evaluate(() => (globalThis as any).__giteaLaunch)).toMatchObject({ instance: base, owner: 'owner', repository: 'sub-fixture', ref: 'main' });
  await opened.close();
});

test('OAuth sign-in and silent sign-in use the sub-path, and the repository is read and committed with the OAuth token', async ({ page, context }) => {
  const callbacks: string[] = [];
  context.on('request', req => {
    if (new URL(req.url()).pathname.endsWith('/oauth-callback.html')) callbacks.push(`${req.resourceType()} ${new URL(req.url()).pathname}`);
  });
  await ready(page);
  await signInOAuth(page, context);
  // The popup lands on the callback page under the sub-path.
  expect(callbacks).toEqual(['document /git/assets/gitea-dev/oauth-callback.html']);
  const popups: string[] = [], silent: string[] = [];
  context.on('page', opened => popups.push(opened.url()));
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/git/login/oauth/authorize' && req.resourceType() === 'fetch') silent.push(req.url());
  });
  const outside = watchOutside(page);
  await ready(page);
  await expect.poll(async () => (await command(page, 'gitea.status')).auth).toBe('oauth');
  expect(silent.length).toBeGreaterThan(0);
  expect(silent.every(url => new URL(url).searchParams.get('redirect_uri') === `${base}/assets/gitea-dev/oauth-callback.html`)).toBe(true);
  // The silent request follows Gitea's redirect to the callback page under the sub-path.
  expect(callbacks).toContain('fetch /git/assets/gitea-dev/oauth-callback.html');
  expect(popups).toEqual([]);
  expect(outside).toEqual([]);

  // Read, then commit through the sub-path API with the OAuth token.
  const before = (await gitea.apiOk({ name: 'owner' }, 'GET', '/repos/owner/sub-fixture/branches/main')).commit.id;
  await openFile(page, 'hello.txt');
  await expect(activeEditor(page).locator('.view-lines')).toContainText('Hello from a sub-path.');
  const content = `Committed under a sub-path from ${test.info().project.name}`;
  await replaceFile(page, content);
  await expect.poll(async () => (await command(page, 'gitea.status')).pending).toBe(1);
  expect((await command(page, 'gitea.status')).canWrite).toBe(true);
  const result = await command(page, 'gitea.commit', `Sub-path commit ${test.info().project.name}`);
  expect(result).toMatchObject({ ok: true, changes: 1 });
  const commit = await gitea.apiOk({ name: 'owner' }, 'GET', `/repos/owner/sub-fixture/git/commits/${result.sha}`);
  expect(commit.parents.map((parent: any) => parent.sha)).toEqual([before]);
  const file = await gitea.apiOk({ name: 'owner' }, 'GET', '/repos/owner/sub-fixture/contents/hello.txt?ref=main');
  expect(Buffer.from(file.content, 'base64').toString()).toContain(content);
  expect(outside).toEqual([]);
  expect(await command(page, 'gitea.signOut')).toMatchObject({ ok: true });
});

test('PAT sign-in works under the sub-path and survives a reload', async ({ page }) => {
  await ready(page);
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(gitea.token('owner'));
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true, auth: 'pat', instance: base });
  await ready(page);
  expect((await command(page, 'gitea.status')).auth).toBe('pat');
});

test('the gallery lists, installs and runs an extension, and applies the allowlist, under the sub-path', async ({ page }) => {
  await ready(page);
  await command(page, 'workbench.extensions.search', 'web fixture');
  const item = page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ });
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: /^Install/ }).click();
  await withoutTrustPrompt(page, expect.poll(async () => {
    try { return (await command(page, 'giteaTest.extensionPing')) === 'web-worker-ready'; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true));
  await command(page, 'workbench.extensions.search', 'blocked fixture');
  await expect(page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ })).toHaveCount(0);
  const status = (path: string) => page.evaluate(async url => (await fetch(url)).status, `${galleryOrigin}${path}`);
  expect(await status('/vscode/unpkg/gitea-test/blocked-fixture/1.0.0/extension/package.json')).toBe(403);
});
