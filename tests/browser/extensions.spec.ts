import { test, expect, type Page } from '@playwright/test';
import { command, withoutTrustPrompt } from './fixtures.js';

const launch = '/assets/gitea-dev/index.html?owner=owner&repository=browser-fixture&ref=main&refKind=branch';
const ping = 'giteaTest.extensionPing';
// Fixture gallery origin (tests/browser/server.ts); the browser talks to it directly, like Open VSX.
const gallery = 'http://127.0.0.1:8082';

async function ready(page: Page) {
  await page.goto(launch);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function search(page: Page, text: string) {
  await command(page, 'workbench.extensions.search', text);
  return page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ });
}

async function pings(page: Page): Promise<boolean> {
  try { return (await command(page, ping)) === 'web-worker-ready'; } catch { return false; }
}

test('installs a browser extension from the gallery, runs it in the worker, and persists it until uninstall', async ({ page }) => {
  const external: string[] = [], sockets: string[] = [];
  page.on('request', req => { if (/^https?:/.test(req.url()) && !req.url().startsWith('http://127.0.0.1:8081/')) external.push(req.url()); });
  page.on('websocket', socket => sockets.push(socket.url()));
  await ready(page);
  expect(await pings(page)).toBe(false);

  const item = await search(page, 'web fixture');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Web Fixture');
  await item.getByRole('button', { name: /^Install/ }).click();
  await withoutTrustPrompt(page, expect.poll(() => pings(page), { timeout: 30_000 }).toBe(true));

  await ready(page);
  await expect.poll(() => pings(page), { timeout: 30_000 }).toBe(true);

  const installed = await search(page, '@installed');
  await expect(installed).toHaveCount(1);
  await installed.dblclick();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect.poll(async () => (await installed.count()) === 0
    || await installed.getByText('Restart Required', { exact: true }).isVisible()).toBe(true);
  await ready(page);
  expect(await pings(page)).toBe(false);
  await search(page, '@installed');
  await expect(page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ })).toHaveCount(0);

  expect((await command(page, 'gitea.status')).pending).toBe(0);
  // Only the configured gallery is contacted besides Gitea (plan.md, Constraints and decisions, item 5).
  expect(external.length).toBeGreaterThan(0);
  expect(external.filter(url => !url.startsWith(`${gallery}/`))).toEqual([]);
  expect(sockets).toEqual([]);
});

test('gallery icons served with CORS but without CORP load under require-corp', async ({ page }) => {
  await ready(page);
  const item = await search(page, 'web fixture');
  await expect(item).toHaveCount(1);
  const icon = item.locator('img.icon');
  await expect(icon).toHaveAttribute('src', new RegExp(`^${gallery}/`));
  await expect.poll(() => icon.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('the operator allowlist hides other gallery extensions and refuses their resources', async ({ page }) => {
  await ready(page);
  await expect(await search(page, 'web fixture')).toHaveCount(1);
  await command(page, 'workbench.extensions.search', 'blocked fixture');
  await expect(page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ })).toHaveCount(0);
  const status = (path: string) => page.evaluate(async url => (await fetch(url)).status, `${gallery}${path}`);
  expect(await status('/vscode/unpkg/gitea-test/web-fixture/1.0.0/extension/package.json')).toBe(200);
  expect(await status('/vscode/unpkg/gitea-test/blocked-fixture/1.0.0/extension/package.json')).toBe(403);
  expect(await status('/api/gitea-test/blocked-fixture/1.0.0/file/package.json')).toBe(403);
  // The gallery itself serves it; only the service worker in this browser refuses it (advisory).
  expect((await page.request.get(`${gallery}/vscode/unpkg/gitea-test/blocked-fixture/1.0.0/extension/package.json`)).status()).toBe(200);
});

test('an extension that cannot run in the browser is not installable', async ({ page }) => {
  await ready(page);
  const item = await search(page, 'node only fixture');
  await expect(item).toHaveCount(1);
  await expect(item.getByRole('button', { name: /^Install/ })).toBeDisabled();
  await expect.poll(() => pings(page)).toBe(false);
  const attempt = command(page, 'workbench.extensions.installExtension', 'gitea-test.node-only-fixture')
    .then(() => ({ installed: true, error: '' }), error => ({ installed: false, error: String(error) }));
  expect(await withoutTrustPrompt(page, attempt)).toMatchObject({ installed: false });
  expect(await pings(page)).toBe(false);
});
