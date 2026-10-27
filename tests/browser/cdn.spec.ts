// --workbench=cdn (README "Workbench install modes"). Opt-in, needs internet:
//   BROWSER_WORKBENCH=cdn npx playwright test            (Chromium and Firefox; loopback Gitea over http)
//   BROWSER_WORKBENCH=cdn BROWSER_HTTPS=1 npx playwright test cdn.spec.ts   (all browsers; WebKit needs HTTPS)
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, type Account } from './fixtures.ts';
import { command, replaceEditorText } from './fixtures.js';

const pin = JSON.parse(readFileSync('config/workbench.json', 'utf8'));
const CDN_ROOT = `https://main.vscode-cdn.net/stable/${pin.commit}/`;

test.skip(process.env.BROWSER_WORKBENCH !== 'cdn', 'needs BROWSER_WORKBENCH=cdn and internet');

async function ready(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench, undefined, { timeout: 60_000 });
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 60_000 }).toBe(true);
}

async function repository(request: APIRequestContext, { token, user }: Account, name: string) {
  const repo = `${name}-${test.info().project.name}-${Date.now()}`;
  const api = (method: string, path: string, data?: unknown) =>
    request.fetch(`/api/v1${path}`, { method, headers: { Authorization: `token ${token}` }, data });
  expect((await api('POST', '/user/repos', { name: repo, auto_init: true, default_branch: 'main' })).status()).toBe(201);
  expect((await api('POST', `/repos/${user}/${repo}/contents`, {
    branch: 'main', message: 'seed', files: [{ operation: 'create', path: 'a.txt', content: Buffer.from('alpha\n').toString('base64') }],
  })).status()).toBe(201);
  return { repo, api };
}

test('the pinned workbench loads from the CDN, none from Gitea, and the extension host runs on vscode-cdn.net', async ({ page, account }) => {
  const workbench: string[] = [], policy: string[] = [];
  page.on('request', req => { if (/\/out\/(nls\.messages|vs\/workbench\/workbench\.web\.main\.internal)\.js$/.test(req.url())) workbench.push(req.url()); });
  page.on('console', message => { if (/Refused|Content Security Policy|Invalid script url/.test(message.text())) policy.push(message.text()); });
  await ready(page, account.launch());
  expect(workbench.length).toBeGreaterThan(0);
  expect(workbench.filter(url => !url.startsWith(CDN_ROOT))).toEqual([]);
  const { version } = await (await page.request.get('/assets/gitea-dev/configuration.json')).json();
  expect((await page.request.get(`/assets/gitea-dev/${version}/workbench/out/nls.messages.js`)).status()).toBe(404);
  const src = new URL((await page.locator('iframe.web-worker-ext-host-iframe').getAttribute('src'))!);
  expect(src.hostname).toMatch(/^[a-z0-9-]+\.vscode-cdn\.net$/);
  expect(src.pathname.startsWith(`/stable/${pin.commit}/`)).toBe(true);
  const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' blob: https://main.vscode-cdn.net;");
  expect(csp).toContain("frame-src 'self' https://*.vscode-cdn.net;");
  // xterm loads through the workbench's package loader, which needs the Trusted Types policy (bootstrap.ts).
  await command(page, 'gitea.openShell');
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  expect(policy).toEqual([]);
});

test('the repository archive downloads from the CDN extension host', async ({ page, account }) => {
  await ready(page, account.launch());
  await command(page, 'workbench.action.findInFiles', { query: 'export const answer', triggerSearch: true });
  await expect(page.locator('.search-view')).toContainText('value.ts');
  await expect.poll(async () => (await command(page, 'gitea.status')).archive, { timeout: 60_000 }).toBe('ready');
});

test('pending edits survive a reload and move to a new branch', async ({ page, request, account }) => {
  const { repo, api } = await repository(request, account, 'cdn');
  await ready(page, account.launch(repo));
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(account.token);
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true });
  await page.evaluate(async () => {
    const folder = (globalThis as any).__giteaFolderUri;
    await (globalThis as any).__giteaWorkbench.commands.executeCommand('vscode.open', folder.with({ path: '/a.txt' }));
  });
  await expect(page.locator('.tab.active').first()).toHaveAttribute('aria-label', /a\.txt/);
  await replaceEditorText(page, 'work in progress');
  await command(page, 'workbench.action.files.save');
  await expect.poll(async () => (await command(page, 'gitea.status')).pending).toBe(1);
  await ready(page, account.launch(repo));
  expect((await command(page, 'gitea.status')).pending).toBe(1);
  void command(page, 'gitea.createBranch', { name: 'topic' }).catch(() => undefined);
  await page.waitForURL(/ref=topic/);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench, undefined, { timeout: 60_000 });
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ref; } catch { return null; }
  }, { timeout: 60_000 }).toBe('topic');
  expect((await command(page, 'gitea.status')).pending).toBe(1);
  expect((await api('GET', `/repos/${account.user}/${repo}/branches/topic`)).status()).toBe(200);
});
