// Phase 3 source control in the real workbench. Each test makes its own repository through the
// Gitea API, so runs on the three browsers do not share branches or commits.
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, type Account } from './fixtures.ts';
import { command, replaceEditorText } from './fixtures.js';

interface Fixture {
  repo: string;
  api: <T = any>(method: string, path: string, data?: unknown) => Promise<{ status: number; json: T }>;
}

async function fixture(request: APIRequestContext, { token, user }: Account, name: string, files: Record<string, string> = { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' }): Promise<Fixture> {
  const repo = `${name}-${test.info().project.name}-${Date.now()}`;
  const api = async (method: string, path: string, data?: unknown) => {
    const res = await request.fetch(`/api/v1${path}`, { method, headers: { Authorization: `token ${token}` }, data });
    const text = await res.text();
    return { status: res.status(), json: text ? JSON.parse(text) : null };
  };
  expect((await api('POST', '/user/repos', { name: repo, auto_init: true, default_branch: 'main', readme: 'Default' })).status).toBe(201);
  const seeded = await api('POST', `/repos/${user}/${repo}/contents`, {
    branch: 'main', message: 'seed',
    files: Object.entries(files).map(([path, content]) => ({ operation: 'create', path, content: Buffer.from(content).toString('base64') })),
  });
  expect(seeded.status).toBe(201);
  return { repo, api };
}

async function readyAt(page: Page, account: Account, repo: string, ref = 'main') {
  await page.goto(account.launch(repo, encodeURIComponent(ref)));
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

async function signInPat(page: Page, { token }: Account) {
  const pending = command(page, 'gitea.signIn');
  const input = page.locator('.quick-input-widget input[type="password"]');
  await expect(input).toBeVisible();
  await input.fill(token);
  await input.press('Enter');
  expect(await pending).toMatchObject({ ok: true, auth: 'pat' });
}

/** Opens a file, types into its editor and saves, so it becomes a pending change. */
async function writeFile(page: Page, path: string, content: string) {
  await page.evaluate(async ({ path }) => {
    const folder = (globalThis as any).__giteaFolderUri;
    await (globalThis as any).__giteaWorkbench.commands.executeCommand('vscode.open', folder.with({ path: `/${path}` }));
  }, { path });
  // Type only once this file's tab is active, or the text lands in the previous editor.
  await expect(page.locator('.tab.active').first()).toHaveAttribute('aria-label', new RegExp(path.replace('.', '\\.')));
  await replaceEditorText(page, content);
  await command(page, 'workbench.action.files.save');
}

async function pending(page: Page): Promise<number> {
  return (await command(page, 'gitea.status')).pending;
}

/** Runs a command with a workspace URI argument; the URI is built in the page so it stays a real Uri. */
const commandOnFile = (page: Page, id: string, path: string) =>
  page.evaluate(async ({ id, path }) => {
    const folder = (globalThis as any).__giteaFolderUri;
    return (globalThis as any).__giteaWorkbench.commands.executeCommand(id, folder.with({ path: `/${path}` }));
  }, { id, path });

test('a pull request page offers the head branch in the editor tab', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'prhead');
  await fx.api('POST', `/repos/${account.user}/${fx.repo}/branches`, { new_branch_name: 'pr-branch', old_ref_name: 'main' });
  await fx.api('POST', `/repos/${account.user}/${fx.repo}/contents`, {
    branch: 'pr-branch', message: 'work', files: [{ operation: 'create', path: 'w.txt', content: 'eA==' }],
  });
  const pull = await fx.api('POST', `/repos/${account.user}/${fx.repo}/pulls`, { head: 'pr-branch', base: 'main', title: 'work' });
  expect(pull.status).toBe(201);
  await page.goto(`/${account.user}/${fx.repo}/pulls/${pull.json.number}`);
  await expect(page.locator('a[data-gitea-dev-launch]').first()).toHaveAttribute('href', /ref=pr-branch&refKind=branch/);
});

test('the status bar shows the ref and switching reloads the editor at another branch', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'switch');
  await fx.api('POST', `/repos/${account.user}/${fx.repo}/branches`, { new_branch_name: 'other', old_ref_name: 'main' });
  await readyAt(page, account, fx.repo);
  await expect(page.locator('.statusbar')).toContainText('main');
  expect(await command(page, 'gitea.status')).toMatchObject({ ref: 'main', refKind: 'branch' });
  // The command reloads the page, so its evaluate never resolves; do not await it.
  void command(page, 'gitea.switchRef', { ref: 'other', refKind: 'branch' }).catch(() => undefined);
  await page.waitForURL(/ref=other/);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ref; } catch { return null; }
  }, { timeout: 40_000 }).toBe('other');
  await expect(page.locator('.statusbar')).toContainText('other');
});

test('switching to a ref the launch validator rejects does not navigate', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'badref');
  await readyAt(page, account, fx.repo);
  const result = await command(page, 'gitea.switchRef', { ref: 'bad..name', refKind: 'branch' });
  expect(result.ok).toBe(false);
  expect(new URL(page.url()).searchParams.get('ref')).toBe('main');
});

test('create branch moves pending changes to the new branch', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'mkbranch');
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  await writeFile(page, 'a.txt', 'work in progress');
  await expect.poll(() => pending(page)).toBe(1);
  void command(page, 'gitea.createBranch', { name: 'topic' }).catch(() => undefined);
  await page.waitForURL(/ref=topic/);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ref; } catch { return null; }
  }, { timeout: 40_000 }).toBe('topic');
  expect((await command(page, 'gitea.status')).pending).toBe(1);
  expect((await fx.api('GET', `/repos/${account.user}/${fx.repo}/branches/topic`)).status).toBe(200);
});

test('a protected branch refuses a direct commit and takes a commit to a new branch', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'protected');
  await fx.api('POST', `/repos/${account.user}/${fx.repo}/branch_protections`, { rule_name: 'main', enable_push: false });
  const before = (await fx.api('GET', `/repos/${account.user}/${fx.repo}/branches/main`)).json.commit.id;
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  expect(await command(page, 'gitea.status')).toMatchObject({ canWrite: false, canBranch: true });
  await writeFile(page, 'a.txt', 'proposed');
  await expect.poll(() => pending(page)).toBe(1);
  const result = await command(page, 'gitea.commit', { message: 'Propose a change\n\nWhy.', newBranch: 'proposal' });
  expect(result).toMatchObject({ ok: true, branch: 'proposal', newBranch: true });
  expect((await fx.api('GET', `/repos/${account.user}/${fx.repo}/branches/main`)).json.commit.id).toBe(before);
  const commit = (await fx.api('GET', `/repos/${account.user}/${fx.repo}/git/commits/${result.sha}`)).json;
  expect(commit.parents.map((p: any) => p.sha)).toEqual([before]);
  expect(await (await request.get(`/api/v1/repos/${account.user}/${fx.repo}/raw/a.txt?ref=proposal`)).text()).toBe('proposed');
  expect((await command(page, 'gitea.status')).pending).toBe(0);
});

test('pull request from the new branch: created once, a duplicate falls back to the compare page', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'pr');
  await fx.api('POST', `/repos/${account.user}/${fx.repo}/branch_protections`, { rule_name: 'main', enable_push: false });
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  await writeFile(page, 'a.txt', 'proposed');
  const committed = await command(page, 'gitea.commit', { message: 'Propose', newBranch: 'proposal' });
  expect(committed.ok).toBe(true);
  const first = await command(page, 'gitea.createPullRequest', { head: 'proposal', base: 'main', title: 'Propose', body: 'Because.' });
  expect(first).toMatchObject({ ok: true, number: 1 });
  const pull = (await fx.api('GET', `/repos/${account.user}/${fx.repo}/pulls/1`)).json;
  expect([pull.title, pull.body, pull.head.ref, pull.base.ref]).toEqual(['Propose', 'Because.', 'proposal', 'main']);
  const again = await command(page, 'gitea.createPullRequest', { head: 'proposal', base: 'main', title: 'Propose' });
  expect(again).toMatchObject({ ok: false, status: 409 });
  expect(again.compareUrl).toContain(`/${account.user}/${fx.repo}/compare/main...proposal?expand=1`);
  const same = await command(page, 'gitea.createPullRequest', { head: 'main', base: 'main', title: 'x' });
  expect(same.ok).toBe(false);
});

test('staging commits only the staged changes and keeps the rest pending, across reloads', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'staging');
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  await writeFile(page, 'a.txt', 'alpha 2');
  await writeFile(page, 'b.txt', 'bravo 2');
  await expect.poll(() => pending(page)).toBe(2);
  expect((await command(page, 'gitea.status')).staged).toEqual([]);
  expect(await commandOnFile(page, 'gitea.stage', 'a.txt')).toMatchObject({ ok: true, staged: ['a.txt'] });
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).staged; } catch { return null; }
  }, { timeout: 40_000 }).toEqual(['a.txt']);
  await signInPat(page, account);
  const result = await command(page, 'gitea.commit', 'Only a');
  expect(result).toMatchObject({ ok: true, changes: 1 });
  expect(await (await request.get(`/api/v1/repos/${account.user}/${fx.repo}/raw/a.txt?ref=main`)).text()).toBe('alpha 2');
  expect(await (await request.get(`/api/v1/repos/${account.user}/${fx.repo}/raw/b.txt?ref=main`)).text()).toBe('bravo\n');
  expect(await command(page, 'gitea.status')).toMatchObject({ pending: 1, staged: [] });
});

test('with nothing staged a commit takes every change, and unstage returns a file to Changes', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'smart');
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  await writeFile(page, 'a.txt', 'alpha 3');
  await writeFile(page, 'b.txt', 'bravo 3');
  await command(page, 'gitea.stageAll');
  expect((await command(page, 'gitea.status')).staged.sort()).toEqual(['a.txt', 'b.txt']);
  await commandOnFile(page, 'gitea.unstage', 'b.txt');
  expect((await command(page, 'gitea.status')).staged).toEqual(['a.txt']);
  await command(page, 'gitea.unstageAll');
  expect((await command(page, 'gitea.status')).staged).toEqual([]);
  expect(await command(page, 'gitea.commit', 'Both')).toMatchObject({ ok: true, changes: 2 });
});

test('a new remote commit is detected, counted, and applied only by an explicit update', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'remote');
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  expect((await command(page, 'gitea.status')).remote).toBe(null);
  expect(await command(page, 'gitea.checkRemote')).toMatchObject({ ok: true, behind: false });
  const base = (await command(page, 'gitea.status')).baseCommit;
  const pushed = await fx.api('POST', `/repos/${account.user}/${fx.repo}/contents`, {
    branch: 'main', message: 'remote', files: [{ operation: 'create', path: 'r.txt', content: 'eA==' }],
  });
  expect(pushed.status).toBe(201);
  expect(await command(page, 'gitea.checkRemote')).toMatchObject({ ok: true, behind: true, incoming: 1, head: pushed.json.commit.sha });
  expect(await command(page, 'gitea.status')).toMatchObject({ baseCommit: base, remote: { head: pushed.json.commit.sha, incoming: 1 } });
  expect(await command(page, 'gitea.refresh')).toMatchObject({ ok: true, moved: true });
  await expect.poll(async () => (await command(page, 'gitea.status')).remote).toBe(null);
  expect((await command(page, 'gitea.status')).baseCommit).toBe(pushed.json.commit.sha);
});

test('the Commit button is disabled with no changes, enabled after an edit, and commits', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'button');
  await readyAt(page, account, fx.repo);
  await signInPat(page, account);
  await command(page, 'workbench.view.scm');
  const button = page.getByLabel('Source Control Management').getByRole('button', { name: 'Commit', exact: true });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await writeFile(page, 'a.txt', 'from the button');
  await expect.poll(() => pending(page)).toBe(1);
  await command(page, 'workbench.view.scm');
  await expect(button).toBeEnabled();
  const before = (await fx.api('GET', `/repos/${account.user}/${fx.repo}/branches/main`)).json.commit.id;
  await page.locator('.scm-editor [role="textbox"]').first().focus();
  await command(page, 'type', { text: 'Commit from the button' });
  await expect(page.locator('.scm-editor')).toContainText('Commit from the button');
  await expect(page.getByText('committed directly to main').first()).toBeVisible();
  // The note floats over the button until dismissed.
  await page.locator('.context-view .codicon-close').click();
  await expect(page.locator('.scm-editor-validation').first()).toBeHidden();
  await button.click();
  await expect.poll(async () => (await fx.api('GET', `/repos/${account.user}/${fx.repo}/branches/main`)).json.commit.id).not.toBe(before);
  const head = (await fx.api('GET', `/repos/${account.user}/${fx.repo}/branches/main`)).json.commit;
  expect(head.message.trim()).toBe('Commit from the button');
  expect(await (await request.get(`/api/v1/repos/${account.user}/${fx.repo}/raw/a.txt?ref=main`)).text()).toBe('from the button');
  await expect.poll(() => pending(page)).toBe(0);
  await expect(button).toBeDisabled();
});

test('the more-actions menu groups Gitea actions like a git menu, and a changed file has Open File', async ({ page, request, account }) => {
  const fx = await fixture(request, account, 'menu');
  await readyAt(page, account, fx.repo);
  await command(page, 'workbench.view.scm');
  await writeFile(page, 'a.txt', 'changed');
  await expect.poll(() => pending(page)).toBe(1);
  await command(page, 'workbench.view.scm');
  await page.mouse.move(150, 51);
  await page.locator('a.codicon-toolbar-more:visible').first().click();
  const items = page.locator('.monaco-menu .action-item:visible');
  for (const label of ['Checkout to...', 'Fetch', 'Commit', 'Changes', 'Branch', 'Show Gitea Output']) {
    await expect(items.filter({ hasText: new RegExp(`^${label.replace('.', '\\.')}$`) }), label).toHaveCount(1);
  }
  await items.filter({ hasText: /^Changes$/ }).click();
  const submenu = page.locator('.monaco-submenu .action-item:visible').filter({ hasText: /\S/ });
  await expect(submenu).toHaveText(['Stage All Changes', 'Unstage All Changes', 'Discard All Changes']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const row = page.locator('.scm-view .monaco-list-row', { hasText: 'a.txt' }).first();
  await row.hover();
  await expect(row.locator('.action-label[aria-label="Open File"]')).toBeVisible();
  await expect(row.locator('.action-label[aria-label="Discard Changes"]')).toBeVisible();
  await row.locator('.action-label[aria-label="Open File"]').click();
  await expect(page.locator('.tabs-container .tab.active')).toContainText('a.txt');
});
