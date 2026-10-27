import { test, expect, type Page } from '@playwright/test';
import { command, activeEditor } from './fixtures.js';

const launch = '/assets/gitea-dev/index.html?owner=owner&repository=browser-fixture&ref=main&refKind=branch';

async function ready(page: Page) {
  await page.goto(launch);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

/** Requests the editor makes to the Gitea API, by kind. Worker and iframe requests are included. */
function watch(page: Page) {
  const seen = { archive: [] as string[], blobs: [] as string[], recursiveTrees: [] as string[] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/archive\/[0-9a-f]+\.tar\.gz$/.test(url.pathname)) seen.archive.push(url.pathname);
    if (/\/git\/blobs\/|\/raw\//.test(url.pathname)) seen.blobs.push(url.pathname);
    if (/\/git\/trees\//.test(url.pathname) && url.searchParams.get('recursive') === 'true') seen.recursiveTrees.push(url.search);
  });
  return seen;
}

async function findInFiles(page: Page) {
  await command(page, 'workbench.action.findInFiles', { query: 'export const answer', triggerSearch: true });
  await expect(page.locator('.search-view')).toContainText('value.ts');
}

// Expectations follow the roadmap (Phase 4): archive prefetch by commit id, zero blob reads after completion, reuse by commit.
test('search reads from the archive: warns while downloading, then makes zero blob requests; reload on the same commit makes no archive request', async ({ page }) => {
  const seen = watch(page);
  await ready(page);

  await findInFiles(page);
  // The workbench drops TextSearchComplete.message from provider results, so the notice is shown in the status bar.
  await expect(page.locator('.statusbar')).toContainText(/files are searched one at a time/);
  expect(seen.recursiveTrees.length).toBeGreaterThan(0);
  await expect.poll(async () => (await command(page, 'gitea.status')).archive, { timeout: 40_000 }).toBe('ready');
  expect(seen.archive).toHaveLength(1);

  seen.blobs.length = 0;
  await command(page, 'workbench.action.closeAllEditors');
  await findInFiles(page);
  expect(seen.blobs).toEqual([]);
  expect(seen.archive).toHaveLength(1);

  // Same commit after a reload: the stored archive is used with no archive and no blob request.
  seen.archive.length = 0;
  seen.blobs.length = 0;
  await ready(page);
  await expect.poll(async () => (await command(page, 'gitea.status')).archive, { timeout: 20_000 }).toBe('ready');
  await findInFiles(page);
  expect(seen.archive).toEqual([]);
  expect(seen.blobs).toEqual([]);
});

test('opening a file after the archive completes makes no blob request', async ({ page }) => {
  const seen = watch(page);
  await ready(page);
  await findInFiles(page);
  await expect.poll(async () => (await command(page, 'gitea.status')).archive, { timeout: 40_000 }).toBe('ready');
  seen.blobs.length = 0;
  await page.evaluate(async () => {
    const api = (globalThis as any).__giteaWorkbench;
    const folder = (globalThis as any).__giteaFolderUri;
    await api.commands.executeCommand('vscode.open', folder.with({ path: '/hello.txt' }));
  });
  await expect(activeEditor(page).locator('[role="textbox"]')).toBeAttached();
  expect(seen.blobs).toEqual([]);
});
