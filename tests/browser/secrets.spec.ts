import type { Page } from '@playwright/test';
import { test, expect, type Account } from './fixtures.ts';
import { command } from './fixtures.js';

async function ready(page: Page, account: Account) {
  await page.goto(account.launch());
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function signInPat(page: Page, token: string) {
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(token);
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true, auth: 'pat' });
}

/** Every string and byte sequence in every IndexedDB database of the origin, plus secret store metadata. */
async function readIndexedDb(page: Page) {
  return page.evaluate(async () => {
    const wait = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const texts: string[] = [];
    const walk = (value: unknown, depth = 0) => {
      if (depth > 12 || value === null || value === undefined) return;
      if (typeof value === 'string') texts.push(value);
      else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        texts.push(new TextDecoder('latin1').decode(bytes), btoa(String.fromCharCode(...bytes)));
      } else if (typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
    };
    const names = ((await indexedDB.databases?.()) ?? [{ name: 'gitea-web-ide-secrets' }]).map(d => d.name!);
    const secretNames: string[] = [];
    let secretCount = 0;
    let key: { isCryptoKey: boolean; extractable: boolean; algorithm: unknown } | undefined;
    for (const name of names) {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const os = db.transaction(store).objectStore(store);
        const [keys, values] = await Promise.all([wait(os.getAllKeys()), wait(os.getAll())]);
        walk(keys); walk(values);
        if (name === 'gitea-web-ide-secrets' && store === 'secrets') {
          secretCount = values.length;
          for (const k of keys) if (Array.isArray(k)) secretNames.push(String(k[1]));
        }
        if (name === 'gitea-web-ide-secrets' && store === 'keys' && values[0]) {
          const v = values[0] as CryptoKey;
          key = { isCryptoKey: v instanceof CryptoKey, extractable: v.extractable, algorithm: v.algorithm };
        }
      }
      db.close();
    }
    return { texts, names, secretCount, secretNames, key };
  });
}

test('a PAT sign-in survives reload and IndexedDB never holds the plaintext token', async ({ page, account }) => {
  const { token } = account;
  await ready(page, account);
  expect((await command(page, 'gitea.status')).auth).toBe(null);
  await signInPat(page, token);
  expect((await command(page, 'gitea.status')).auth).toBe('pat');

  await ready(page, account);
  expect(await command(page, 'gitea.status')).toMatchObject({ ready: true, auth: 'pat', failure: null });

  const db = await readIndexedDb(page);
  expect(db.names).toContain('gitea-web-ide-secrets');
  expect(db.secretCount).toBeGreaterThan(0);
  expect(db.secretNames.some(name => name.includes('gitea-dev:pat:'))).toBe(true);
  expect(db.key).toMatchObject({ isCryptoKey: true, extractable: false, algorithm: { name: 'AES-GCM', length: 256 } });
  expect(token.length).toBeGreaterThan(8);
  expect(db.texts.filter(text => text.includes(token))).toEqual([]);
});

test('sign out deletes the stored credential so a reload is signed out', async ({ page, account }) => {
  const { token } = account;
  await ready(page, account);
  await signInPat(page, token);
  expect(await command(page, 'gitea.signOut')).toMatchObject({ ok: true });
  await ready(page, account);
  expect((await command(page, 'gitea.status')).auth).toBe(null);
  const db = await readIndexedDb(page);
  expect(db.secretNames.filter(name => name.includes('gitea-dev:pat:'))).toEqual([]);
});
