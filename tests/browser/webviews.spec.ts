// Webview hosting (README "Browser extensions"). Default: disabled, no frame on another origin.
// `--webviews=vscode-cdn`: real webviews (Markdown preview, an extension panel) load on *.vscode-cdn.net
// and are isolated from the Gitea origin. Each describe has its own Gitea and install.
// The isolation probe runs inside the webview itself (fixture extension `panel-check`), because Playwright
// cannot evaluate in these cross-origin frames on Firefox.
import { test, expect, type Page } from '@playwright/test';
import net from 'node:net';
import { startGitea, type GiteaFixture } from '../helpers/gitea.js';
import { allowlist, createGalleryServer } from '../helpers/gallery.js';
import { browserGiteaIni, browserWorkbench } from '../helpers/workbench.js';
// @ts-ignore untyped .mjs module
import { install } from '../../scripts/run-installer.mjs';
import { command, activeEditor, withoutTrustPrompt } from './fixtures.js';

const marker = 'Webview isolation marker';
const cdnOrigin = /^https:\/\/[^/]+\.vscode-cdn\.net$/;

async function offlineReason(): Promise<string | undefined> {
  try {
    await fetch('https://webview-probe.vscode-cdn.net/', { signal: AbortSignal.timeout(8_000) });
    return undefined;
  } catch (error) {
    return `needs network access to *.vscode-cdn.net (${(error as Error).cause ?? error})`;
  }
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

async function deploy(webviews: 'disabled' | 'vscode-cdn', gallery = 'off') {
  const options = { gallery, webviews, extensionsAllowlist: allowlist.join(' '), testMode: true, ...browserWorkbench };
  const gitea = await startGitea({
    users: [{ name: 'owner', tokens: { full: ['all'] } }], extraIni: browserGiteaIni,
    custom: custom => install({ ...options, rootUrl: 'http://127.0.0.1:9', custom }),
  });
  await install({ ...options, rootUrl: gitea.baseUrl, custom: gitea.customDir });
  await gitea.createRepo('owner', 'webview-fixture');
  await gitea.commitFiles('owner', 'webview-fixture', 'main', 'Notes', [
    { operation: 'create', path: 'NOTES.md', content: `# Notes\n\n${marker}\n` },
  ]);
  return gitea;
}

async function ready(page: Page, gitea: GiteaFixture) {
  await page.goto(`${gitea.baseUrl}/assets/gitea-dev/index.html?owner=owner&repository=webview-fixture&ref=main&refKind=branch`);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function openPreview(page: Page, gitea: GiteaFixture) {
  await ready(page, gitea);
  await page.evaluate(async () => {
    const folder = (globalThis as any).__giteaFolderUri;
    await (globalThis as any).__giteaWorkbench.commands.executeCommand('vscode.open', folder.with({ path: '/NOTES.md' }));
  });
  await expect(activeEditor(page).locator('[role="textbox"]')).toBeAttached();
  await command(page, 'markdown.showPreview');
}

/** Origins of the `src` of every iframe in the editor page. */
const iframeSources = (page: Page) => page.locator('iframe').evaluateAll(frames => frames.map(frame => (frame as HTMLIFrameElement).src));

test.describe('--webviews=vscode-cdn', () => {
  test.describe.configure({ mode: 'serial' });
  let gitea: GiteaFixture;
  let gallery: ReturnType<typeof createGalleryServer> | undefined;
  let offline: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    offline = await offlineReason();
    if (offline) return;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    gitea = await deploy('vscode-cdn', origin);
    gallery = createGalleryServer(origin);
    await new Promise<void>(resolve => gallery!.listen(port, '127.0.0.1', resolve));
  });
  test.afterAll(async () => {
    gallery?.closeAllConnections(); gallery?.close();
    await gitea?.stop();
  });

  test('the Markdown preview of a repository file is hosted on vscode-cdn.net', async ({ page }) => {
    test.skip(!!offline, offline);
    await openPreview(page, gitea);
    const preview = page.locator('iframe.webview');
    await expect(preview).toHaveCount(1);
    const src = new URL((await preview.getAttribute('src'))!);
    expect(src.origin).toMatch(cdnOrigin);
    expect(src.searchParams.get('extensionId')).toBe('vscode.markdown-language-features');
    expect(src.searchParams.get('parentOrigin')).toBe(new URL(gitea.baseUrl).origin);
  });

  // The preview's styles and scripts live on the Gitea origin. The webview page is cross-origin with COEP
  // require-corp and Gitea static files carry no CORP, so those requests fail and the preview stays empty.
  // The preview is expected to work with --webviews=vscode-cdn; plan.md ("Not implemented") records the gap.
  test.fixme('the Markdown preview shows the rendered repository file', async ({ page }) => {
    test.skip(!!offline, offline);
    await openPreview(page, gitea);
    await expect.poll(async () => {
      for (const frame of page.frames()) {
        if ((await frame.evaluate(() => document.body?.textContent ?? '').catch(() => '')).includes(marker)) return true;
      }
      return false;
    }, { timeout: 45_000 }).toBe(true);
  });

  test('an extension webview runs on vscode-cdn.net, isolated from the Gitea origin and its session', async ({ page }) => {
    test.skip(!!offline, offline);
    // A Gitea web session exists, so its cookie would be visible if the origins were shared.
    await page.goto(`${gitea.baseUrl}/user/login`);
    await page.locator('input[name="user_name"]').fill('owner');
    await page.locator('input[name="password"]').fill(gitea.password('owner'));
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(url => !url.pathname.startsWith('/user/login'));
    expect((await page.context().cookies(new URL(gitea.baseUrl).origin)).length).toBeGreaterThan(0);

    await ready(page, gitea);
    await command(page, 'workbench.extensions.search', 'panel check');
    const item = page.locator('.extensions-list .extension-list-item').filter({ hasText: /Panel Check/ });
    await expect(item).toHaveCount(1);
    await item.getByRole('button', { name: /^Install/ }).click();

    const api = `${gitea.baseUrl}/api/v1/user`;
    let result: any;
    await withoutTrustPrompt(page, expect.poll(async () => {
      try { result = await command(page, 'giteaTest.panelCheck', api); return true; } catch { return false; }
    }, { timeout: 60_000 }).toBe(true));
    // The webview script ran on a vscode-cdn.net origin.
    expect(result.origin).toMatch(cdnOrigin);
    expect(result.origin).not.toBe(new URL(gitea.baseUrl).origin);
    // Framed under the editor page, whose document is not accessible. (In the webview `window.parent` is the window itself.)
    expect(result.framed).toBe(true);
    expect(result.top).toBe('SecurityError');
    expect(result.databases).not.toContain('gitea-web-ide-secrets');
    expect(result.cookie).not.toMatch(/i_like_gitea|_csrf/);
    expect(result.fetched).toMatch(/^rejected/);
    // Control: the same request from the editor page itself is answered (401: the API ignores the cookie).
    expect(await page.evaluate(async url => (await fetch(url, { credentials: 'include' })).status, api)).toBe(401);
  });
});

test.describe('default (--webviews=disabled)', () => {
  test.describe.configure({ mode: 'serial' });
  let gitea: GiteaFixture;

  test.beforeAll(async () => { test.setTimeout(180_000); gitea = await deploy('disabled'); });
  test.afterAll(async () => { await gitea?.stop(); });

  test('a Markdown preview opens no frame and makes no request on another origin', async ({ page }) => {
    const giteaOrigin = new URL(gitea.baseUrl).origin;
    const foreign: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && url.origin !== giteaOrigin) foreign.push(request.url());
    });
    await openPreview(page, gitea);
    // The preview's webview frame has loaded the deployment's placeholder page in place of webview content.
    await expect(page.frameLocator('iframe.webview').locator('body')).toContainText('Embedded extension pages are unavailable');
    const origins = page.frames().map(frame => frame.url()).filter(url => /^https?:/.test(url)).map(url => new URL(url).origin);
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.filter(origin => origin !== giteaOrigin)).toEqual([]);
    expect((await iframeSources(page)).filter(src => new URL(src).origin !== giteaOrigin)).toEqual([]);
    expect(foreign).toEqual([]);
  });
});
