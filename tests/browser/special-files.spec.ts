// Git LFS files, symlinks and submodules in the real workbench. Each test makes its own repository
// (git over HTTP for symlinks and a submodule, the LFS batch API for objects), so the three browsers
// do not share state. Expectations: the editor shows the LFS object, not the pointer; a link opens its
// target and a directory link expands; links that leave the repository or dangle fail to open without
// breaking the explorer; a submodule is not openable; none of them is editable.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { pushSpecialFiles, SPECIAL_LFS_OBJECT, SPECIAL_SUBMODULE_COMMIT } from '../helpers/git-push.ts';
import { command, activeEditor } from './fixtures.js';

const controls = 'http://127.0.0.1:8082';
const instance = 'http://127.0.0.1:8081';

async function specialRepo(request: APIRequestContext): Promise<string> {
  const { token } = await (await request.get(`${controls}/__test/token`)).json();
  const repo = `special-${test.info().project.name}-${Date.now()}`;
  const created = await request.post(`${instance}/api/v1/user/repos`, {
    headers: { Authorization: `token ${token}` },
    data: { name: repo, auto_init: true, default_branch: 'main', readme: 'Default' },
  });
  expect(created.status()).toBe(201);
  await pushSpecialFiles({ baseUrl: instance, token: () => token }, 'owner', repo);
  return repo;
}

async function readyAt(page: Page, repo: string) {
  await page.goto(`/assets/gitea-dev/index.html?owner=owner&repository=${repo}&ref=main&refKind=branch`);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

/** vscode.open on a path in the repository; resolves to the error message when the open fails. */
async function open(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async ({ path }) => {
    const folder = (globalThis as any).__giteaFolderUri;
    try {
      await (globalThis as any).__giteaWorkbench.commands.executeCommand('vscode.open', folder.with({ path: `/${path}` }));
      return undefined;
    } catch (error) {
      return String((error as Error)?.message ?? error);
    }
  }, { path });
}

const explorerRow = (page: Page, name: string) => page.locator('.explorer-folders-view .monaco-list-row').filter({ has: page.getByText(name, { exact: true }) });
const editorText = (page: Page) => activeEditor(page).locator('.view-lines');

test('explorer, editor and search treat LFS files, symlinks and submodules as specified', async ({ page, request }) => {
  const repo = await specialRepo(request);
  await readyAt(page, repo);

  // Explorer: every entry is listed, including links that cannot be followed.
  for (const name of ['data.bin', 'docs', 'link-file', 'link-dir', 'link-dangling', 'link-escape', 'link-abs', 'sub']) {
    await expect(explorerRow(page, name)).toBeVisible();
  }
  // The workbench labels links as symbolic links; a submodule carries its commit in its decoration, and a directory link expands.
  const label = (name: string) => explorerRow(page, name).locator('.monaco-icon-label');
  await expect(label('link-file')).toHaveAttribute('aria-label', /Symbolic Link/);
  await expect(label('link-dangling')).toHaveAttribute('aria-label', /Symbolic Link/);
  await expect(label('sub')).toHaveAttribute('aria-label', new RegExp(`Submodule at commit ${SPECIAL_SUBMODULE_COMMIT}`));
  await explorerRow(page, 'link-dir').click();
  await expect(explorerRow(page, 'notes.txt')).toBeVisible();

  // LFS: the editor shows the object, not the pointer, and refuses typing.
  expect(await open(page, 'data.bin')).toBeUndefined();
  await expect(editorText(page)).toContainText(SPECIAL_LFS_OBJECT.split('\n')[0]);
  await expect(editorText(page)).not.toContainText('git-lfs.github.com');
  await editorText(page).click();
  await page.keyboard.type('ZZZ');
  await expect(editorText(page)).not.toContainText('ZZZ');
  await expect(page.locator('.tabs-container .tab.active')).not.toHaveClass(/dirty/);

  // A link to a file opens its target's content; a file below a directory link opens too.
  expect(await open(page, 'link-file')).toBeUndefined();
  await expect(editorText(page)).toContainText('plain needle');
  expect(await open(page, 'link-dir/notes.txt')).toBeUndefined();
  await expect(editorText(page)).toContainText('plain needle');

  // Links that dangle or leave the repository, and the submodule, fail to open (the workbench shows its generic
  // error page for a provider error; the message with the link target or commit is covered by the integration
  // tests) and the workbench keeps working.
  for (const name of ['link-dangling', 'link-escape', 'link-abs', 'sub']) {
    await command(page, 'workbench.action.closeAllEditors');
    await open(page, name);
    await expect(page.locator('.tab.active').first(), name).toHaveAttribute('aria-label', new RegExp(name));
    await expect(page.getByText(/could not be opened/).first(), name).toBeVisible();
  }
  await expect(explorerRow(page, 'link-escape')).toBeVisible();
  expect((await command(page, 'gitea.status')).ready).toBe(true);

  // Search skips LFS objects, links and the submodule: only the ordinary file matches.
  await command(page, 'workbench.action.findInFiles', { query: 'needle', triggerSearch: true });
  await expect(page.locator('.search-view')).toContainText('notes.txt');
  await expect(page.locator('.search-view')).not.toContainText('data.bin');
  await expect(page.locator('.search-view .monaco-list-row').filter({ hasText: 'link-file' })).toHaveCount(0);
});
