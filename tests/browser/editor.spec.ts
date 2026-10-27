import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, controls, type Account } from './fixtures.ts';
import { command, activeEditor, activeEditorText, replaceEditorText } from './fixtures.js';

async function ready(page: Page, account: Account) {
  await page.goto(account.launch());
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function openFile(page: Page, path: string) {
  await page.evaluate(async path => {
    const api = (globalThis as any).__giteaWorkbench;
    const folder = (globalThis as any).__giteaFolderUri;
    await api.commands.executeCommand('vscode.open', folder.with({ path: `/${path}` }));
  }, path);
  await expect(activeEditor(page).locator('[role="textbox"]')).toBeAttached();
}

async function replaceFile(page: Page, text: string) {
  await replaceEditorText(page, text);
  await command(page, 'workbench.action.files.save');
}

async function signInPat(page: Page, { token }: Account) {
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(token);
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true, auth: 'pat' });
}

async function signInOAuth(page: Page, context: BrowserContext, credentials: Account) {
  const popupEvent = context.waitForEvent('page');
  const pending = command(page, 'gitea.signInOAuth');
  const popup = await popupEvent;
  await popup.waitForLoadState('domcontentloaded');
  await popup.locator('input[name="user_name"]').fill(credentials.user);
  await popup.locator('input[name="password"]').fill(credentials.password);
  await popup.getByRole('button', { name: /sign in/i }).click();
  // Consent is shown only until the first grant; the fixture app skips it afterwards.
  void popup.getByRole('button', { name: /authorize/i }).click().catch(() => undefined);
  expect(await pending).toMatchObject({ ok: true, auth: 'oauth' });
  if (!popup.isClosed()) await popup.waitForEvent('close', { timeout: 10_000 });
}

/** Records popups and authorization requests made by fetch (silent sign-in). */
function watchSilent(page: Page, context: BrowserContext) {
  const popups: string[] = [], silent: string[] = [];
  context.on('page', opened => popups.push(opened.url()));
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/login/oauth/authorize' && req.resourceType() === 'fetch') silent.push(req.url());
  });
  return { popups, silent };
}

test('Gitea serves the editor as static files and the service worker adds isolation and CSP', async ({ page, account }) => {
  // What Gitea itself sends: its static cache policy and no isolation headers (roadmap Phase 0).
  const direct = await page.request.get('/assets/gitea-dev/index.html');
  expect(direct.headers()['cache-control']).toMatch(/max-age=21600/);
  expect(direct.headers()['cross-origin-embedder-policy']).toBeUndefined();
  await ready(page, account);
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe('http://127.0.0.1:8081/assets/gitea-dev/coi-sw.js');
  const served = await page.evaluate(async () => Object.fromEntries((await fetch(location.href)).headers));
  expect(served).toMatchObject({
    'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff',
  });
  expect(served['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(served['content-security-policy']).toContain("connect-src 'self' http://127.0.0.1:8082;");
  const iframe = page.locator('iframe.web-worker-ext-host-iframe');
  await expect(iframe).toHaveAttribute('src', /\/assets\/gitea-dev\/[0-9a-f]{12}-[0-9a-f]{12}\/workbench\//);
  expect(await iframe.evaluate(frame => (frame as HTMLIFrameElement).contentWindow?.crossOriginIsolated)).toBe(true);
  const iframePolicy = await iframe.evaluate(async frame => (await fetch((frame as HTMLIFrameElement).src)).headers.get('content-security-policy'));
  expect(iframePolicy).toContain("connect-src 'self' http://127.0.0.1:8082;");
  // Settings Sync: the worker answers sync/ itself (Gitea has no such file) and every route needs a bearer token.
  expect((await page.request.get('/assets/gitea-dev/sync/v1/manifest')).status()).toBe(404);
  expect(await page.evaluate(async () => {
    const response = await fetch('/assets/gitea-dev/sync/v1/manifest');
    return { status: response.status, body: await response.text(), authenticate: response.headers.get('www-authenticate') };
  })).toEqual({ status: 401, body: 'Authentication required', authenticate: 'Bearer realm="gitea-settings-sync"' });
});

test('the editor refuses to start without cross-origin isolation and does not run framed by another origin', async ({ browser, page, account }) => {
  const blocked = await browser.newContext({ baseURL: 'http://127.0.0.1:8081', serviceWorkers: 'block' });
  const unisolated = await blocked.newPage();
  await unisolated.goto(account.launch());
  await expect(unisolated.locator('body')).toContainText(/needs (service workers|cross-origin isolation)/);
  expect(await unisolated.evaluate(() => !!(globalThis as any).__giteaWorkbench)).toBe(false);
  await blocked.close();
  // The framed start page registers coi-sw.js and reloads once; the browser refuses that reload (frame-ancestors 'self').
  const refused = page.waitForEvent('requestfailed', req => req.url().startsWith('http://127.0.0.1:8081/assets/gitea-dev/index.html'));
  await page.goto(`${controls}/__test/frame`);
  await refused;
  const framed = page.frames().find(frame => frame.url().startsWith('http://127.0.0.1:8081/'));
  expect(await framed?.evaluate(() => !!(globalThis as any).__giteaWorkbench).catch(() => false) ?? false).toBe(false);
});

test('loads the workbench and browser worker using local resources, with no remote host or process terminal', async ({ page, account }) => {
  const external: string[] = [], sockets: string[] = [], policy: string[] = [];
  page.on('request', req => { if (/^https?:/.test(req.url()) && !req.url().startsWith('http://127.0.0.1:8081/')) external.push(req.url()); });
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('console', message => { if (/Refused|Content Security Policy|EvalError/.test(message.text())) policy.push(message.text()); });
  await ready(page, account);
  expect(await command(page, 'gitea.status')).toMatchObject({ web: true, remoteName: null, terminals: 0 });
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator('iframe.web-worker-ext-host-iframe')).toHaveAttribute('src', /^http:\/\/127\.0\.0\.1:8081\//);
  // No process terminal: New Terminal is unavailable, and a terminal exists only once gitea.openShell runs (shell.spec.ts).
  await command(page, 'workbench.action.terminal.new');
  expect((await command(page, 'gitea.status')).terminals).toBe(0);
  await expect(page.locator('.xterm')).toHaveCount(0);
  expect(external).toEqual([]);
  expect(sockets).toEqual([]);
  expect(policy).toEqual([]);
});

test('save remains local, reload restores it, discard restores remote content, and explicit commit creates one commit', async ({ page, account }) => {
  await ready(page, account);
  const head = await (await page.request.get(`/api/v1/repos/${account.user}/browser-fixture/branches/main`)).json();
  const before = head.commit.id;
  await openFile(page, 'hello.txt');
  const content = `Browser-local ${test.info().project.name}\n`;
  await replaceFile(page, content);
  await expect.poll(async () => (await command(page, 'gitea.status')).pending).toBe(1);
  expect((await (await page.request.get(`/api/v1/repos/${account.user}/browser-fixture/branches/main`)).json()).commit.id).toBe(before);
  await ready(page, account);
  expect((await command(page, 'gitea.status')).pending).toBe(1);
  await openFile(page, 'hello.txt');
  await expect(activeEditor(page).locator('.view-lines')).toContainText(content.trim());
  expect(await command(page, 'gitea.discardAll', { confirmed: true })).toMatchObject({ ok: true });
  await expect.poll(async () => (await command(page, 'gitea.status')).pending).toBe(0);
  await command(page, 'workbench.action.closeAllEditors');
  await openFile(page, 'hello.txt');
  await replaceFile(page, `Committed from ${test.info().project.name}\n`);
  await signInPat(page, account);
  expect((await command(page, 'gitea.status')).canWrite).toBe(true);
  const result = await command(page, 'gitea.commit', `Browser commit ${test.info().project.name}`);
  expect(result).toMatchObject({ ok: true, changes: 1 });
  expect((await command(page, 'gitea.status')).pending).toBe(0);
  const commit = await (await page.request.get(`/api/v1/repos/${account.user}/browser-fixture/git/commits/${result.sha}`)).json();
  expect(commit.parents.map((parent: any) => parent.sha)).toEqual([before]);
  expect(await command(page, 'gitea.signOut')).toMatchObject({ ok: true });
  expect((await command(page, 'gitea.status')).auth).toBe(null);
});

test('period shortcut opens the validated repository in a new tab and ignores inputs', async ({ page, context, account }) => {
  await page.goto(`/${account.user}/browser-fixture`);
  const link = page.locator('a[data-gitea-dev-launch]').first();
  await expect(link).toHaveAttribute('href', new RegExp(`owner=${account.user}.*repository=browser-fixture.*ref=main`));
  await page.locator('body').focus();
  const popup = context.waitForEvent('page');
  await page.keyboard.press('.');
  const editor = await popup;
  await editor.waitForURL(url => url.pathname === '/assets/gitea-dev/index.html' && url.searchParams.get('owner') === account.user);
  expect(new URL(editor.url()).searchParams.get('ref')).toBe('main');
  await editor.close();
  const input = page.locator('input').first();
  if (await input.isVisible()) {
    await input.focus();
    const count = context.pages().length;
    await page.keyboard.press('.');
    expect(context.pages().length).toBe(count);
  }
});

test('period shortcut on a file page opens that file and drops path from the address', async ({ page, context, account }) => {
  await page.goto(`/${account.user}/browser-fixture/src/branch/main/src/value.ts`);
  await expect(page.locator('a[data-gitea-dev-launch]').first()).toHaveAttribute('href', /[?&]path=src%2Fvalue\.ts(&|$)/i);
  await page.locator('body').focus();
  const popup = context.waitForEvent('page');
  await page.keyboard.press('.');
  const editor = await popup;
  await expect(activeEditor(editor)).toBeVisible({ timeout: 40_000 });
  await expect.poll(() => activeEditorText(editor)).toContain('export const answer');
  expect(new URL(editor.url()).searchParams.has('path')).toBe(false);
  await editor.close();
});

test('a launch at an older commit with a path shows that commit\'s tree and version of the file', async ({ page, account }) => {
  const repo = `history-${test.info().project.name}-${Date.now()}`;
  const api = async (method: string, path: string, data?: unknown) => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, headers: { Authorization: `token ${account.token}` }, data });
    expect(res.status(), `${method} ${path}`).toBeLessThan(300);
    return res.json();
  };
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  await api('POST', '/user/repos', { name: repo, auto_init: true, default_branch: 'main' });
  const first = await api('POST', `/repos/${account.user}/${repo}/contents`, { branch: 'main', message: 'first', files: [
    { operation: 'create', path: 'old.txt', content: base64('old\n') },
    { operation: 'create', path: 'note.txt', content: base64('version one\n') },
  ] });
  const note = (await api('GET', `/repos/${account.user}/${repo}/contents/note.txt?ref=main`)).sha;
  await api('POST', `/repos/${account.user}/${repo}/contents`, { branch: 'main', message: 'second', files: [
    { operation: 'update', path: 'note.txt', sha: note, content: base64('version two\n') },
    { operation: 'create', path: 'new.txt', content: base64('new\n') },
  ] });
  await page.goto(`/assets/gitea-dev/index.html?owner=${account.user}&repository=${repo}&ref=${first.commit.sha}&refKind=commit&path=note.txt`);
  await expect(activeEditor(page)).toBeVisible({ timeout: 40_000 });
  await expect.poll(() => activeEditorText(page)).toBe('version one\n');
  await command(page, 'workbench.action.quickOpen', 'txt');
  const list = page.locator('.quick-input-list');
  await expect(list).toContainText('old.txt');
  await expect(list).not.toContainText('new.txt');
});

test('Quick Open and Find in Files use the selected virtual tree', async ({ page, account }) => {
  await ready(page, account);
  await command(page, 'workbench.action.quickOpen', 'value');
  await expect(page.locator('.quick-input-list')).toContainText('value.ts');
  await page.keyboard.press('Escape');
  await command(page, 'workbench.action.findInFiles', { query: 'export const answer', triggerSearch: true });
  await expect(page.locator('.search-view')).toContainText('value.ts');
});

test('TypeScript Go to Definition resolves an unopened virtual file in a browser worker', async ({ page, account }) => {
  await ready(page, account);
  await openFile(page, 'src/main.ts');
  await activeEditor(page).locator('[role="textbox"]').focus();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await command(page, 'cursorMove', { to: 'right', by: 'character', value: 8 });
  await expect.poll(async () => {
    await command(page, 'editor.action.revealDefinition');
    return page.locator('.tab.active').first().getAttribute('aria-label');
  }, { timeout: 30_000 }).toContain('value.ts');
});

test('OAuth PKCE callback signs in without a browser-stored token and logout clears authentication', async ({ page, context, account }) => {
  await ready(page, account);
  await signInOAuth(page, context, account);
  expect((await command(page, 'gitea.status')).canWrite).toBe(true);
  expect(await command(page, 'gitea.signOut')).toMatchObject({ ok: true });
  expect((await command(page, 'gitea.status')).auth).toBe(null);
  await ready(page, account);
  expect((await command(page, 'gitea.status')).auth).toBe(null);
});

test('after one interactive OAuth consent a reload signs in silently, and Gitea logout ends it on the next load', async ({ page, context, account }) => {
  await ready(page, account);
  await signInOAuth(page, context, account);
  const watched = watchSilent(page, context);
  await ready(page, account);
  await expect.poll(async () => (await command(page, 'gitea.status')).auth).toBe('oauth');
  expect((await command(page, 'gitea.status')).canWrite).toBe(true);
  expect(watched.silent.length).toBeGreaterThan(0);
  expect(watched.popups).toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/assets/gitea-dev/index.html');
  await context.clearCookies();
  const silentBefore = watched.silent.length;
  await ready(page, account);
  expect((await command(page, 'gitea.status')).auth).toBe(null);
  expect(watched.silent.length).toBeGreaterThan(silentBefore);
  expect(watched.popups).toEqual([]);
});

test('without a Gitea session, silent OAuth sign-in leaves the editor signed out without a popup', async ({ page, context, account }) => {
  const watched = watchSilent(page, context);
  await ready(page, account);
  expect((await command(page, 'gitea.status')).auth).toBe(null);
  expect(watched.silent.length).toBe(1);
  expect(watched.popups).toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/assets/gitea-dev/index.html');
});

test('private repository opens after sign-in and stays signed in after reload', async ({ page, account }) => {
  await page.goto(account.launch('browser-private'));
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).activated; } catch { return false; }
  }).toBe(true);
  expect((await command(page, 'gitea.status')).ready).toBe(false);
  await signInPat(page, account);
  expect(await command(page, 'gitea.status')).toMatchObject({ ready: true, auth: 'pat', failure: null });
  await openFile(page, 'README.md');
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return undefined; }
  }).toBe(true);
  expect((await command(page, 'gitea.status')).auth).toBe('pat');
});

test('a conflicting remote edit is preserved and local changes remain pending', async ({ page, account }) => {
  await ready(page, account);
  await openFile(page, 'hello.txt');
  await replaceFile(page, `Keep my local ${test.info().project.name}\n`);
  await signInPat(page, account);
  const file = await (await page.request.get(`/api/v1/repos/${account.user}/browser-fixture/contents/hello.txt?ref=main`)).json();
  const remote = `Remote update ${test.info().project.name}\n`;
  const result = await page.request.post(`/api/v1/repos/${account.user}/browser-fixture/contents`, {
    headers: { Authorization: `token ${account.token}` },
    data: { branch: 'main', message: 'Concurrent remote edit', files: [
      { operation: 'update', path: 'hello.txt', sha: file.sha, content: Buffer.from(remote).toString('base64') },
    ] },
  });
  expect(result.status()).toBe(201);
  const commit = await command(page, 'gitea.commit', 'Must retain conflicting edits');
  expect(commit.ok).toBe(false);
  expect((await command(page, 'gitea.status')).pending).toBe(1);
  expect(await (await page.request.get(`/api/v1/repos/${account.user}/browser-fixture/raw/hello.txt?ref=main`)).text()).toBe(remote);
  expect(await command(page, 'gitea.discardAll', { confirmed: true })).toMatchObject({ ok: true });
});
