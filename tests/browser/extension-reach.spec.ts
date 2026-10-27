import type { Page } from '@playwright/test';
import { test, expect, type Account } from './fixtures.ts';
import { command, withoutTrustPrompt } from './fixtures.js';

// plan.md (Constraints and decisions, item 4): characterization, not a fix. Gallery extensions run on the Gitea origin;
// this records what one can reach there. The outcome is documented in README.md (Security model) and docs/testing.md.

async function ready(page: Page, account: Account) {
  await page.goto(account.launch());
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

test('characterization: an installed gallery extension reads Gitea session pages and decrypts stored secrets', async ({ page, account }) => {
  const { user: username, password, token } = account;
  await page.goto('/user/login');
  await page.locator('input[name="user_name"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/user/login'));

  await ready(page, account);
  const signIn = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(token);
  await input.press('Enter');
  expect(await signIn).toMatchObject({ ok: true, auth: 'pat' });

  await command(page, 'workbench.extensions.search', 'probe fixture');
  const item = page.locator('.extensions-list .extension-list-item').filter({ hasText: /Probe Fixture/ });
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: /^Install/ }).click();
  let result: any;
  await withoutTrustPrompt(page, expect.poll(async () => {
    try { result = await command(page, 'giteaTest.probe', username); return true; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true));

  // The session cookie rides along: the settings page, CSRF token included, is readable.
  expect(result.settings).toMatchObject({ status: 200, path: '/user/settings', csrf: true, username: true });
  // The non-extractable key is still usable from the same origin, so the stored PAT decrypts.
  expect(result.secrets.records).toBeGreaterThan(0);
  expect(result.secrets.plaintexts.some((text: string) => text.includes(token))).toBe(true);
});
