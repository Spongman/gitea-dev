import { gunzipSync } from 'node:zlib';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, controls, type Account } from './fixtures.ts';
import { command, withoutTrustPrompt } from './fixtures.js';

const baseURL = 'http://127.0.0.1:8081';
// This worker's account (module state is per worker process); set before each test.
let account: Account;
const syncApi = '/assets/gitea-dev/sync/v1/';
const ping = 'giteaTest.extensionPing';

async function ready(page: Page) {
  await page.goto(account.launch());
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function signInPat(page: Page) {
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(account.token);
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true, auth: 'pat' });
}

/** A fresh browser context (own IndexedDB and storage) with the editor open, signed in unless told otherwise. */
async function device(browser: Browser, options: { signIn?: boolean } = {}) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const external: string[] = [];
  page.on('request', req => { if (/^https?:/.test(req.url()) && !req.url().startsWith(`${baseURL}/`)) external.push(req.url()); });
  await ready(page);
  if (options.signIn !== false) await signInPat(page);
  return { context, page, external };
}

// The store as the editor sees it: a request from the controlled editor page, answered by the
// service worker's sync route with the same PAT.
async function store(page: Page, method: 'GET' | 'DELETE', path: string) {
  const { token } = account;
  return page.evaluate(async ({ method, url, token }) => {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag') };
  }, { method, url: `${syncApi}${path}`, token });
}

interface Variable { name: string; data: string }

/** The user's Actions variables straight from Gitea, bypassing the service worker. */
async function variables(page: Page): Promise<Variable[]> {
  const { token } = account;
  const all: Variable[] = [];
  for (let n = 1; ; n++) {
    const res = await page.request.get(`${baseURL}/api/v1/user/actions/variables?page=${n}&limit=50`, { headers: { Authorization: `token ${token}` } });
    expect(res.status()).toBe(200);
    const rows: Variable[] = await res.json();
    all.push(...rows);
    if (rows.length < 50) return all.filter(row => row.name.startsWith('WEBIDE_SYNC_'));
  }
}

/** Every sync variable is removed through Gitea's API, so each test starts from an empty store. */
async function clearRemote(page: Page) {
  const { token } = account;
  for (const { name } of await variables(page)) {
    const res = await page.request.delete(`${baseURL}/api/v1/user/actions/variables/${name}`, { headers: { Authorization: `token ${token}` } });
    expect([204, 404]).toContain(res.status());
  }
}

/** Decoded text of every resource version stored in Gitea (chunks joined per ref, then gunzipped). */
async function storedPayloads(page: Page): Promise<string[]> {
  const chunks = new Map<string, string[]>();
  for (const { name, data } of await variables(page)) {
    const match = /^WEBIDE_SYNC_B([0-9A-F]+)_(\d+)$/.exec(name);
    if (match) (chunks.get(match[1]) ?? chunks.set(match[1], []).get(match[1])!)[Number(match[2])] = data;
  }
  return [...chunks.values()].map(parts => gunzipSync(Buffer.from(parts.join(''), 'base64url')).toString('utf8'));
}

/** Text of the latest remote settings resource; undefined when the user has none. */
async function remoteSettings(page: Page): Promise<string | undefined> {
  const res = await store(page, 'GET', 'resource/settings/latest');
  if (res.status === 204) return undefined;
  expect(res.status).toBe(200);
  const outer = JSON.parse(res.text);
  const inner = typeof outer.content === 'string' ? JSON.parse(outer.content) : outer.content;
  return inner.settings;
}

const remoteRef = async (page: Page) => (await store(page, 'GET', 'resource/settings/latest')).etag;
const fontSizeOf = (text: string | undefined) => /"editor\.fontSize"\s*:\s*(\d+)/.exec(text ?? '')?.[1];
const remoteFont = async (page: Page) => fontSizeOf(await remoteSettings(page));

// User settings open in a modal editor dialog; `.monaco-editor` alone also matches other editors on the page.
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: /settings\.json/ });
const settingsEditor = (page: Page) => settingsDialog(page).locator('.monaco-editor').first();

async function openUserSettings(page: Page) {
  await command(page, 'workbench.action.closeAllEditors');
  await command(page, 'workbench.action.openSettingsJson');
  await expect(settingsDialog(page)).toBeVisible();
  await expect(settingsEditor(page).locator('[role="textbox"]')).toBeAttached();
}

async function editorText(page: Page) {
  return (await settingsEditor(page).locator('.view-lines').innerText()).replace(/\u00a0/g, ' ');
}

async function userFont(page: Page) {
  await openUserSettings(page);
  // Opening returns before the text is rendered; read once it is the whole, valid file.
  let text = '';
  await expect.poll(async () => {
    text = await editorText(page);
    try { JSON.parse(text.trim() || '{}'); return true; } catch { return false; }
  }).toBe(true);
  return fontSizeOf(text);
}

/** Native Open User Settings (JSON), replace its content, save. Not the repository's settings. */
async function setUserFont(page: Page, size: number) {
  await openUserSettings(page);
  const editor = settingsEditor(page).locator('[role="textbox"]');
  await editor.focus();
  // Editor commands, not keys: Monaco picks Mac bindings from the WebKit device's user agent.
  await command(page, 'editor.action.selectAll');
  // Whether insertText triggers brace auto-close varies by browser; delete anything after the cursor.
  await page.keyboard.insertText(`{ "editor.fontSize": ${size} }`);
  // The auto-closed brace can land after the insert in WebKit, so trim until the text parses.
  await expect.poll(async () => {
    await command(page, 'cursorBottomSelect');
    await command(page, 'deleteRight');
    try { return JSON.parse(await editorText(page))['editor.fontSize']; } catch { return undefined; }
  }).toBe(size);
  await command(page, 'workbench.action.files.save');
  await expect.poll(() => editorText(page)).toContain(`"editor.fontSize": ${size}`);
  expect(JSON.parse(await editorText(page))).toEqual({ 'editor.fontSize': size });
}

/** The native "Settings Sync is turned on" notification, which the automatic turn-on also shows. */
async function turnedOn(page: Page) {
  await expect(page.locator('.notification-toast').filter({ hasText: /is turned on/ })).toBeVisible({ timeout: 60_000 });
}

async function turnOff(page: Page, everywhere: boolean) {
  const pending = command(page, 'workbench.userDataSync.actions.turnOff');
  const dialog = page.locator('.monaco-dialog-box');
  await expect(dialog).toContainText('Do you want to turn off sync?');
  if (everywhere) await dialog.getByText('Turn off sync on all your devices and clear the data from the cloud.').click();
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await pending;
}

/**
 * Resolves once the sync it starts has finished (the native triggerSync with `immediately`); with sync
 * off it starts none. So a check right after it sees whatever this device would have synced.
 */
async function syncNow(page: Page) {
  try { await command(page, 'workbench.userDataSync.actions.syncNow'); } catch { /* not enabled */ }
}

/** The native Settings Sync flag as the next load reads it (key `sync.enable` of the workbench's application storage). */
const storedSyncEnabled = (page: Page) => page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('vscode-web-state-db-global');
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const get = db.transaction('ItemTable').objectStore('ItemTable').get('sync.enable');
      get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
    });
  } finally { db.close(); }
});

async function expectPristine(page: Page, trusted: boolean) {
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await command(page, 'gitea.status')).toMatchObject({ pending: 0, trusted });
}

// Two editors and several native sync cycles per test.
test.setTimeout(180_000);

let closing: BrowserContext[] = [];
test.beforeEach(async ({ page, account: own }) => {
  account = own;
  // The store is shared by every test of this worker through its one Gitea user.
  await page.goto(`${controls}/__test/ready`);
  closing = [];
  await clearRemote(page);
});
test.afterEach(async ({ page }) => {
  await Promise.all(closing.map(context => context.close()));
  await clearRemote(page);
});

test('sync turns on by itself after sign-in without a prompt, stores only gzip in Gitea variables, and stays off once the user turns it off', async ({ browser }) => {
  const a = await device(browser, { signIn: false }); closing.push(a.context);
  const trusted = (await command(a.page, 'gitea.status')).trusted;
  await expect(a.page.locator('.notification-toast').filter({ hasText: /is turned on/ })).toHaveCount(0);
  expect(await variables(a.page)).toEqual([]);

  await signInPat(a.page);
  await expect(a.page.locator('.quick-input-widget')).toBeHidden();
  // From here on, no quick input may ever be painted: the native turn-on prompts are answered in the background.
  await a.page.evaluate(() => {
    const shown: string[] = (globalThis as any).__quickInputsShown = [];
    new MutationObserver(() => {
      const widget = document.querySelector('.quick-input-widget');
      if (!widget) return;
      const style = getComputedStyle(widget);
      if (style.display !== 'none' && style.visibility !== 'hidden') shown.push(widget.querySelector('.quick-input-title')?.textContent ?? '(no title)');
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await turnedOn(a.page);
  expect(await a.page.evaluate(() => (globalThis as any).__quickInputsShown)).toEqual([]);

  await setUserFont(a.page, 21);
  await syncNow(a.page);
  await expect.poll(() => remoteFont(a.page)).toBe('21');
  expect((await store(a.page, 'GET', 'manifest')).status).toBe(200);

  // Everything lives in the user's Actions variables under one prefix, as gzip, and no credential is among it.
  const names = (await variables(a.page)).map(row => row.name);
  expect(names.length).toBeGreaterThan(2);
  expect(names.every(name => /^WEBIDE_SYNC_[A-Z0-9_]+$/.test(name))).toBe(true);
  expect((await variables(a.page)).every(row => !row.data.includes('editor.fontSize'))).toBe(true);
  const payloads = (await storedPayloads(a.page)).join('\n');
  expect(payloads).toContain('editor.fontSize');
  expect(payloads).not.toContain(account.token);
  expect(payloads).not.toMatch(/secret:\/\//);

  // The user can turn it off, and it stays off, also after a reload with the same credentials.
  await turnOff(a.page, false);
  // The workbench writes its stored flags to IndexedDB a moment after they change.
  await expect.poll(() => storedSyncEnabled(a.page)).toBe('false');
  // On load the extension hands the restored session to the automatic turn-on and to the theme check, which
  // requests the user's settings. A turn-on would start with its variables probe 1.5 s later (sync-auto.ts).
  const sessionSeen = a.page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1/user/settings').then(() => Date.now());
  const probes: string[] = [];
  a.page.on('request', req => { if (req.url().includes('/user/actions/variables/WEBIDE_SYNC_PROBE')) probes.push(req.url()); });
  await ready(a.page);
  await a.page.evaluate(() => {
    const seen: string[] = (globalThis as any).__notifications = [];
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll('.notification-toast')) {
        const text = toast.textContent ?? '';
        if (!seen.includes(text)) seen.push(text);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await a.page.waitForTimeout(Math.max(0, await sessionSeen + 2_500 - Date.now()));
  expect(probes).toEqual([]);
  expect(await a.page.evaluate(() => (globalThis as any).__notifications)).toEqual([]);
  const before = await remoteRef(a.page);
  await setUserFont(a.page, 22);
  await syncNow(a.page);
  expect(await remoteRef(a.page)).toBe(before);
  expect(await remoteFont(a.page)).toBe('21');
  await expectPristine(a.page, trusted);
  expect(a.external).toEqual([]);
});

test('settings sync from device A to B, and turning sync off in B stops propagation both ways', async ({ browser }) => {
  const a = await device(browser); closing.push(a.context);
  const trusted = (await command(a.page, 'gitea.status')).trusted;
  await turnedOn(a.page);
  expect(await remoteSettings(a.page)).toBeUndefined();

  await setUserFont(a.page, 21);
  await syncNow(a.page);
  await expect.poll(() => remoteFont(a.page)).toBe('21');

  const b = await device(browser); closing.push(b.context);
  expect(await command(b.page, 'gitea.status')).toMatchObject({ trusted });
  await turnedOn(b.page);
  await expect.poll(() => userFont(b.page)).toBe('21');
  await expect(settingsEditor(b.page).locator('.view-lines'))
    .toHaveCSS('font-size', '21px');

  await setUserFont(a.page, 22);
  await syncNow(a.page);
  await expect.poll(() => remoteFont(a.page)).toBe('22');
  await syncNow(b.page);
  await expect.poll(() => userFont(b.page)).toBe('22');

  await turnOff(b.page, false);
  await setUserFont(b.page, 23);
  const before = await remoteRef(a.page);
  await syncNow(b.page);
  expect(await remoteRef(a.page)).toBe(before);
  expect(await remoteFont(a.page)).toBe('22');

  await setUserFont(a.page, 24);
  await syncNow(a.page);
  await expect.poll(() => remoteFont(a.page)).toBe('24');
  await syncNow(b.page);
  // Polled: right after opening, the editor can render no text yet, which reads as no font size.
  await expect.poll(() => userFont(b.page)).toBe('23');
  expect(await remoteFont(a.page)).toBe('24');

  await expectPristine(a.page, trusted);
  await expectPristine(b.page, trusted);
  expect(a.external).toEqual([]);
  expect(b.external).toEqual([]);
});

test('Clear Data in Cloud removes the remote settings record', async ({ browser }) => {
  const a = await device(browser); closing.push(a.context);
  await turnedOn(a.page);
  await setUserFont(a.page, 21);
  await syncNow(a.page);
  await expect.poll(() => remoteFont(a.page)).toBe('21');
  expect((await store(a.page, 'GET', 'manifest')).status).toBe(200);

  const pending = command(a.page, 'workbench.actions.syncData.reset');
  const dialog = a.page.locator('.monaco-dialog-box');
  await expect(dialog).toContainText('This will clear your data in the cloud and stop sync on all your devices.');
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await pending;

  await expect.poll(async () => (await store(a.page, 'GET', 'manifest')).status).toBe(204);
  expect(await remoteSettings(a.page)).toBeUndefined();
  expect((await variables(a.page)).filter(row => row.name.startsWith('WEBIDE_SYNC_B'))).toEqual([]);
  await expectPristine(a.page, (await command(a.page, 'gitea.status')).trusted);
});

test('turning sync off on all devices clears the remote data', async ({ browser }) => {
  const a = await device(browser); closing.push(a.context);
  await turnedOn(a.page);
  await setUserFont(a.page, 21);
  await syncNow(a.page);
  await expect.poll(() => remoteFont(a.page)).toBe('21');

  await turnOff(a.page, true);
  await expect.poll(async () => (await store(a.page, 'GET', 'manifest')).status).toBe(204);
  expect(await remoteSettings(a.page)).toBeUndefined();

  await setUserFont(a.page, 22);
  await syncNow(a.page);
  expect(await remoteSettings(a.page)).toBeUndefined();
});

test('an installed extension syncs from A to B', async ({ browser }) => {
  const a = await device(browser); closing.push(a.context);
  // Before B starts: the turn-on notification hides after 10 s, less than B's startup can take.
  await turnedOn(a.page);
  const b = await device(browser, { signIn: false }); closing.push(b.context);
  const pings = async (page: Page) => {
    try { return (await command(page, ping)) === 'web-worker-ready'; } catch { return false; }
  };
  expect(await pings(b.page)).toBe(false);

  await command(a.page, 'workbench.extensions.search', 'web fixture');
  const item = a.page.locator('.extensions-list .extension-list-item').filter({ hasText: /Fixture/ });
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: /^Install/ }).click();
  await withoutTrustPrompt(a.page, expect.poll(() => pings(a.page), { timeout: 30_000 }).toBe(true));

  await syncNow(a.page);
  await expect.poll(async () => (await store(a.page, 'GET', 'resource/extensions/latest')).status).toBe(200);
  await signInPat(b.page);
  await turnedOn(b.page);
  await expect.poll(() => pings(b.page), { timeout: 60_000 }).toBe(true);
  await expectPristine(a.page, (await command(a.page, 'gitea.status')).trusted);
  await expectPristine(b.page, (await command(b.page, 'gitea.status')).trusted);
});
