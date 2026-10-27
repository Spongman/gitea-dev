// Worker-scoped Gitea account. Each Playwright worker slot (parallelIndex, stable across worker
// restarts) gets its own user with its own seeded repositories (tests/browser/server.ts), so
// specs that write user-level or repository state do not interfere across parallel workers.
import { test as base, expect, type Locator, type Page } from '@playwright/test';

// Test controls live on the fixture gallery origin (tests/browser/server.ts).
export const controls = 'http://127.0.0.1:8082';

export interface Account {
  user: string;
  password: string;
  token: string;
  /** Editor launch path for one of the user's repositories. */
  launch: (repo?: string, ref?: string) => string;
}

/**
 * Runs a workbench command in the page and returns its result only when it is plain data. Rich
 * results (openSettingsJson returns an editor pane) would be serialized by Playwright on the page's
 * main thread, typed arrays included, which took up to 20 s per call and grew with each call.
 */
export async function command(page: Page, id: string, ...args: unknown[]): Promise<any> {
  return base.step(`command ${id}`, () => page.evaluate(async ({ id, args }) => {
    const result = await (globalThis as any).__giteaWorkbench.commands.executeCommand(id, ...args);
    const plain = result === null || typeof result !== 'object' || Array.isArray(result) || Object.getPrototypeOf(result) === Object.prototype;
    return plain ? result : undefined;
  }, { id, args }), { box: true });
}

/**
 * The editor of the active editor group. `.monaco-editor` alone also matches other editors on the
 * page (the Source Control input box), so `.first()` can pick the wrong one.
 */
export const activeEditor = (page: Page): Locator => page.locator('.editor-group-container.active .editor-instance .monaco-editor');

/** Text of the active editor as rendered, lines joined by newlines (an empty last line keeps its newline). */
export const activeEditorText = (page: Page): Promise<string> => activeEditor(page).locator('.view-lines').evaluate(lines =>
  [...lines.children].sort((a, b) => (a as HTMLElement).offsetTop - (b as HTMLElement).offsetTop)
    .map(line => line.textContent ?? '').join('\n').replace(/\u00a0/g, ' '));

/**
 * Replaces the whole text of the active editor. Editor commands, not keys (as sync.spec.ts setUserFont):
 * Monaco picks Mac bindings from the WebKit device's user agent, where Ctrl+A is not select-all.
 * Each attempt replaces everything, then drops anything after the cursor (an auto-closed or
 * duplicated insert), until the text is exact.
 */
export async function replaceEditorText(page: Page, text: string) {
  await activeEditor(page).locator('[role="textbox"]').focus();
  await expect.poll(async () => {
    await command(page, 'editor.action.selectAll');
    await command(page, 'type', { text });
    await command(page, 'cursorBottomSelect');
    await command(page, 'deleteRight');
    return activeEditorText(page);
  }).toBe(text);
}

/**
 * Awaits `pending` (an install and what follows it), failing as soon as the publisher trust prompt shows.
 * The workbench skips that prompt for ids allowed by `extensions.allowed` (`isPublisherTrusted`, docs/testing.md),
 * and every harness installs its fixtures with the allowlist, so the prompt never shows for them.
 */
export async function withoutTrustPrompt<T>(page: Page, pending: Promise<T>): Promise<T> {
  const prompt = page.getByRole('button', { name: 'Trust Publisher & Install', exact: true });
  let settled = false;
  const result = pending.finally(() => { settled = true; });
  result.catch(() => undefined);
  while (!settled) {
    expect(await prompt.isVisible(), 'publisher trust prompt for an allowlisted extension').toBe(false);
    await Promise.race([result.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 100))]);
  }
  return result;
}

export { expect } from '@playwright/test';
export const test = base.extend<{}, { account: Account }>({
  account: [async ({}, use, workerInfo) => {
    const get = async (what: 'token' | 'login') => {
      const res = await fetch(`${controls}/__test/${what}?worker=${workerInfo.parallelIndex}`);
      if (!res.ok) throw new Error(`${what} for worker ${workerInfo.parallelIndex}: HTTP ${res.status} ${await res.text()}`);
      return res.json();
    };
    const { token } = await get('token');
    const { username: user, password } = await get('login');
    const launch = (repo = 'browser-fixture', ref = 'main') =>
      `/assets/gitea-dev/index.html?owner=${user}&repository=${repo}&ref=${ref}&refKind=branch`;
    await use({ user, password, token, launch });
  }, { scope: 'worker' }],
});
