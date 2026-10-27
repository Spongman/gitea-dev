import { firefox, type Browser, type Page } from '@playwright/test';
import { test, expect, type Account } from './fixtures.ts';
import { command } from './fixtures.js';

async function setGiteaTheme(page: Page, { user, password }: Account, theme: string) {
  const response = await page.request.patch('/api/v1/user/settings', {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
    data: { theme },
  });
  expect(response.ok()).toBe(true);
}

async function webLogin(page: Page, { user, password }: Account) {
  await page.goto('/user/login');
  await page.locator('input[name="user_name"]').fill(user);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/user/login'));
}

async function expectScheme(page: Page, account: Account, scheme: 'dark' | 'light') {
  await page.goto(account.launch());
  const workbench = page.locator('.monaco-workbench');
  await expect(workbench).toBeVisible({ timeout: 40_000 });
  await expect.poll(async () => (await workbench.getAttribute('class'))!.split(/\s+/).includes('vs-dark') ? 'dark' : 'light').toBe(scheme);
}

test.afterEach(async ({ page, account }) => { await setGiteaTheme(page, account, 'gitea-auto'); });

test('a signed-in user gets the light or dark editor matching their Gitea theme', async ({ page, account }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await webLogin(page, account);
  await setGiteaTheme(page, account, 'gitea-dark');
  await expectScheme(page, account, 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await setGiteaTheme(page, account, 'gitea-light');
  await expectScheme(page, account, 'light');
});

test('with Gitea auto (the default and anonymous visitors) the editor follows the OS scheme', async ({ browser, browserName, baseURL, account }) => {
  for (const scheme of ['dark', 'light'] as const) {
    // Firefox's colorScheme emulation does not reach the cross-origin-isolated editor page (a normal
    // Gitea page sees it, the editor does not), so Firefox gets its real system dark-theme preference.
    let own: Browser | undefined;
    if (browserName === 'firefox') own = await firefox.launch({ firefoxUserPrefs: { 'ui.systemUsesDarkTheme': scheme === 'dark' ? 1 : 0 } });
    const context = await (own ?? browser).newContext({ baseURL, colorScheme: scheme });
    try { await expectScheme(await context.newPage(), account, scheme); } finally { await context.close(); await own?.close(); }
  }
});

async function signInPat(page: Page, { token }: Account) {
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => { try { return (await command(page, 'gitea.status')).ready; } catch { return false; } }, { timeout: 40_000 }).toBe(true);
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(token);
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true, auth: 'pat' });
}

test('after sign-in the Gitea theme setting from the API corrects a stale scheme and applies on reload', async ({ page, account }) => {
  await webLogin(page, account);
  await setGiteaTheme(page, account, 'gitea-light');
  await expectScheme(page, account, 'light');
  // An earlier confirmation said light; the user has since switched Gitea to dark.
  await page.evaluate(() => localStorage.setItem('gitea-dev:color-scheme-confirmed', 'light'));
  await setGiteaTheme(page, account, 'gitea-dark');
  await expectScheme(page, account, 'light');
  await signInPat(page, account);
  await expect(page.locator('.notifications-toasts')).toContainText('Your Gitea theme is dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gitea-dev:color-scheme-confirmed'))).toBe('dark');
  // The reload checks the theme again once the restored session reads the user's settings; on a mismatch the
  // notification follows that response within about 0.2 s, so 1 s after it covers it.
  const checked = page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1/user/settings').then(() => Date.now());
  await expectScheme(page, account, 'dark');
  await page.waitForTimeout(Math.max(0, await checked + 1_000 - Date.now()));
  // Count, not not.toContainText: with no notification at all the toasts container may not exist.
  await expect(page.locator('.notifications-toasts .notification-toast', { hasText: 'Your Gitea theme is' })).toHaveCount(0);
});
