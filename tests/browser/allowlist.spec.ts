// An extension installed while allowed must not run once the operator removes it from the allowlist
// (configuration.json). Own Gitea, gallery and install; the default harness is untouched. The allowlist is
// advisory (browser-enforced), see README "Browser extensions".
import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { startGitea, type GiteaFixture } from '../helpers/gitea.js';
import { allowlist, createGalleryServer } from '../helpers/gallery.js';
import { browserGiteaIni, browserWorkbench } from '../helpers/workbench.js';
// @ts-ignore untyped .mjs module
import { install } from '../../scripts/run-installer.mjs';
import { command, withoutTrustPrompt } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

const removed = 'gitea-test.web-fixture';
const without = allowlist.filter(id => id !== removed);
let gitea: GiteaFixture;
let gallery: ReturnType<typeof createGalleryServer>;
let galleryOrigin: string;
let options: Record<string, unknown>;
const launch = () => `${gitea.baseUrl}/assets/gitea-dev/index.html?owner=owner&repository=allow-fixture&ref=main&refKind=branch`;

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const galleryPort = await freePort();
  galleryOrigin = `http://127.0.0.1:${galleryPort}`;
  options = { gallery: galleryOrigin, testMode: true, ...browserWorkbench };
  gitea = await startGitea({
    users: [{ name: 'owner', tokens: { full: ['all'] } }], extraIni: browserGiteaIni,
    custom: custom => install({ ...options, extensionsAllowlist: allowlist.join(' '), rootUrl: 'http://127.0.0.1:9', custom }),
  });
  await gitea.createRepo('owner', 'allow-fixture');
  gallery = createGalleryServer(galleryOrigin);
  await new Promise<void>(resolve => gallery.listen(galleryPort, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  gallery?.closeAllConnections(); gallery?.close();
  await gitea?.stop();
});

async function ready(page: Page) {
  await page.goto(launch());
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

const pings = async (page: Page) => {
  try { return (await command(page, 'giteaTest.extensionPing')) === 'web-worker-ready'; } catch { return false; }
};

/** The operator reinstalls with another allowlist; the open page's worker is then updated. */
async function setAllowlist(page: Page | undefined, ids: string[], mutate?: (worker: string) => string) {
  await install({ ...options, extensionsAllowlist: ids.join(' '), rootUrl: gitea.baseUrl, custom: gitea.customDir });
  if (mutate) {
    const file = `${gitea.customDir}/public/assets/gitea-dev/coi-sw.js`;
    await writeFile(file, mutate(await readFile(file, 'utf8')));
  }
  // Bounded wait: the effect is checked by the callers.
  await page?.evaluate(async () => {
    const registration = (await navigator.serviceWorker.getRegistration())!;
    await registration.update();
    const next = registration.installing ?? registration.waiting;
    if (next && next.state !== 'activated') {
      await Promise.race([
        new Promise<void>(resolve => next.addEventListener('statechange', () => { if (next.state === 'activated') resolve(); })),
        new Promise<void>(resolve => setTimeout(resolve, 10_000)),
      ]);
    }
  });
}

async function installFixture(page: Page) {
  await command(page, 'workbench.extensions.search', 'web fixture');
  const item = page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ });
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: /^Install/ }).click();
  // Allowlisted ids are vetted by the operator, so the workbench shows no publisher trust prompt.
  await withoutTrustPrompt(page, expect.poll(() => pings(page), { timeout: 30_000 }).toBe(true));
  await ready(page);
  await expect.poll(() => pings(page), { timeout: 30_000 }).toBe(true);
}

const resourceStatus = (page: Page) => page.evaluate(
  async url => (await fetch(url)).status, `${galleryOrigin}/vscode/unpkg/gitea-test/web-fixture/1.0.0/extension/package.json`);

async function expectBlocked(page: Page) {
  await ready(page);
  // Decisive at once: for a command no extension has registered, executeCommand first waits for the installed
  // extensions to be registered and for its onCommand activation, the fixture's only activation event.
  expect(await pings(page)).toBe(false);
  const rows = (query: string) => command(page, 'workbench.extensions.search', query)
    .then(() => page.locator('.extensions-list .extension-list-item').filter({ hasText: /Web Fixture/ }));
  // Shown as installed but disabled, with the reason in its details.
  await expect(await rows('@disabled')).toHaveCount(1);
  await expect(await rows('@enabled')).toHaveCount(0);
  await (await rows('@installed')).dblclick();
  await expect(page.locator('.extension-editor')).toContainText('disabled because it is not in the allowed list');
}

test('an extension installed before it left the allowlist is refused by the worker, does not activate and is shown as disabled', async ({ page }) => {
  await setAllowlist(undefined, allowlist);
  await ready(page);
  await installFixture(page);
  expect(await resourceStatus(page)).toBe(200);

  await setAllowlist(page, without);
  await expect.poll(() => resourceStatus(page)).toBe(403);
  await expectBlocked(page);
});

test('the workbench disables it even when the worker no longer enforces the allowlist', async ({ page }) => {
  await setAllowlist(undefined, allowlist);
  await ready(page);
  await installFixture(page);

  // Stale or replaced worker: it serves everything, configuration.json still lists the allowlist.
  await setAllowlist(page, without, worker => worker.replace(/"extensionsAllowlist":\[[^\]]*\]/, '"extensionsAllowlist":null'));
  await expect.poll(() => resourceStatus(page)).toBe(200);
  await expectBlocked(page);
});
