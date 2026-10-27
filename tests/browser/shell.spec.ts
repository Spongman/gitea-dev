// Virtual shell (README.md "Usage", plan.md "Shell"): a Pseudoterminal in the extension host over the overlay.
// Each test makes its own repository through the Gitea API.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { command } from './fixtures.js';

const controls = 'http://127.0.0.1:8082';
const files = {
  'hello.txt': 'Hello from Gitea.\n',
  'notes.txt': 'alpha\nbeta\ngamma\n',
  'src/main.ts': 'export const needle = 1;\n',
};

async function makeRepo(request: APIRequestContext) {
  const { token } = await (await request.get(`${controls}/__test/token`)).json();
  const repo = `shell-${test.info().project.name}-${Date.now()}`;
  const api = async (method: string, path: string, data?: unknown) => {
    const res = await request.fetch(`/api/v1${path}`, { method, headers: { Authorization: `token ${token}` }, data });
    const text = await res.text();
    return { status: res.status(), json: text ? JSON.parse(text) : null };
  };
  expect((await api('POST', '/user/repos', { name: repo, auto_init: true, default_branch: 'main', readme: 'Default' })).status).toBe(201);
  expect((await api('POST', `/repos/owner/${repo}/contents`, {
    branch: 'main', message: 'seed',
    files: Object.entries(files).map(([path, content]) => ({ operation: 'create', path, content: Buffer.from(content).toString('base64') })),
  })).status).toBe(201);
  return { repo, api };
}

async function readyAt(page: Page, repo: string) {
  await page.goto(`/assets/gitea-dev/index.html?owner=owner&repository=${repo}&ref=main&refKind=branch`);
  await page.waitForFunction(() => !!(globalThis as any).__giteaWorkbench);
  await expect.poll(async () => {
    try { return (await command(page, 'gitea.status')).ready; } catch { return false; }
  }, { timeout: 40_000 }).toBe(true);
}

const terminals = async (page: Page): Promise<number> => (await command(page, 'gitea.status')).terminals;

/** The terminal draws on canvas; screen reader mode adds an accessibility tree with one element per row. */
async function screen(page: Page): Promise<string> {
  return page.evaluate(() => [...(document.querySelector('.xterm-accessibility-tree')?.children ?? [])].map(row => row.textContent ?? '').join('\n').replace(/\u00a0/g, ' '));
}

const promptsIn = (text: string, repo: string) => text.split(`owner/${repo}@main:`).length - 1;

/** Types a line and waits for the next prompt, returning the screen after Ctrl+L cleared the old output. */
async function run(page: Page, repo: string, line: string): Promise<string> {
  await page.keyboard.press('Control+L');
  await expect.poll(async () => promptsIn(await screen(page), repo)).toBe(1);
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await expect.poll(async () => promptsIn(await screen(page), repo)).toBe(2);
  return screen(page);
}

async function openShell(page: Page) {
  expect(await command(page, 'gitea.openShell')).toMatchObject({ ok: true });
  await shellReady(page);
}

/** Waits for the one open terminal to show the shell's greeting and focuses it. */
async function shellReady(page: Page) {
  await expect(page.locator('.xterm')).toHaveCount(1);
  await command(page, 'editor.action.toggleScreenReaderAccessibilityMode');
  await expect.poll(async () => (await screen(page)).includes('Type "help"')).toBe(true);
  await page.locator('.xterm').first().click();
}

test('no terminal exists at startup, and New Terminal opens the Gitea shell', async ({ page, request }) => {
  const { repo } = await makeRepo(request);
  await readyAt(page, repo);
  // Nothing may open a terminal on its own after startup: wait for the workbench's last startup phase
  // (Eventually, which marks code/LifecyclePhase/Eventually once every startup contribution has run).
  await page.waitForFunction(() => performance.getEntriesByName('code/LifecyclePhase/Eventually').length > 0);
  expect(await terminals(page)).toBe(0);
  expect(await command(page, 'gitea.status')).toMatchObject({ web: true, remoteName: null });
  await command(page, 'workbench.action.terminal.new');
  await shellReady(page);
  expect(await terminals(page)).toBe(1);
  expect(await screen(page)).toContain(`owner/${repo}@main:~$`);
});

test('Gitea: Open Shell opens one terminal, and New Terminal adds a second shell', async ({ page, request }) => {
  const { repo } = await makeRepo(request);
  await readyAt(page, repo);
  await openShell(page);
  expect(await terminals(page)).toBe(1);
  expect(await screen(page)).toContain(`owner/${repo}@main:~$`);
  await command(page, 'workbench.action.terminal.new');
  await expect.poll(() => terminals(page)).toBe(2);
});

test('the empty terminal panel offers Open Gitea Shell, and the profile list offers Gitea Shell', async ({ page, request }) => {
  const { repo } = await makeRepo(request);
  await readyAt(page, repo);
  await command(page, 'workbench.action.terminal.toggleTerminal');
  await page.locator('.panel a:has-text("Open Gitea Shell"), .panel .monaco-button:has-text("Open Gitea Shell")').first().click();
  await shellReady(page);
  expect(await terminals(page)).toBe(1);
  void command(page, 'workbench.action.terminal.newWithProfile').catch(() => undefined);
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Gitea Shell' }).click();
  await expect.poll(() => terminals(page)).toBe(2);
});

test('ls, cat, grep, a pipe, a redirect and rm work on the overlay; status lists them; nothing is committed or sent out', async ({ page, request }) => {
  const external: string[] = [], sockets: string[] = [], lazy: string[] = [];
  const { repo, api } = await makeRepo(request);
  const before = (await api('GET', `/repos/owner/${repo}/branches/main`)).json.commit.id;
  await readyAt(page, repo);
  page.on('request', req => {
    const url = req.url();
    if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:8081/')) external.push(url);
    // The workbench loads its own wasm (onig.wasm); the extension must load none.
    if (/\/extension\/.*(\.wasm|\/chunks\/)/.test(url)) lazy.push(url);
  });
  page.on('websocket', socket => sockets.push(socket.url()));
  await openShell(page);

  expect(await run(page, repo, 'ls')).toMatch(/README\.md\s+hello\.txt\s+notes\.txt\s+src/);
  expect(await run(page, repo, 'cat hello.txt')).toContain('Hello from Gitea.');
  expect(await run(page, repo, 'grep -rn needle src')).toContain('src/main.ts:1:export const needle = 1;');
  expect(await run(page, repo, 'cat notes.txt | grep a | wc -l')).toMatch(/\n3\s*\n/);
  expect(await run(page, repo, 'curl http://example.com')).toContain('curl: command not found');
  expect((await command(page, 'gitea.status')).pending).toBe(0);
  expect(await run(page, repo, 'status')).toContain('No pending changes.');

  await run(page, repo, 'echo x > t.txt');
  await expect.poll(async () => (await command(page, 'gitea.status')).counts).toMatchObject({ added: 1, modified: 0, deleted: 0 });
  expect((await command(page, 'gitea.status')).pending).toBe(1);
  expect(await run(page, repo, 'cat t.txt')).toMatch(/\nx\s*\n/);
  expect(await run(page, repo, 'status')).toMatch(/A {2}t\.txt/);

  await run(page, repo, 'rm hello.txt');
  await expect.poll(async () => (await command(page, 'gitea.status')).counts).toMatchObject({ added: 1, deleted: 1 });
  expect((await command(page, 'gitea.status')).pending).toBe(2);
  const status = await run(page, repo, 'status');
  expect(status).toMatch(/A {2}t\.txt/);
  expect(status).toMatch(/D {2}hello\.txt/);
  expect(await run(page, repo, 'ls')).not.toContain('hello.txt');
  expect(await run(page, repo, 'cat hello.txt')).toContain('cat: hello.txt: No such file or directory');

  // The same overlay the editor shows: discarding from Source Control empties what status reports.
  expect(await command(page, 'gitea.discardAll', { confirmed: true })).toMatchObject({ ok: true, discarded: 2 });
  expect(await run(page, repo, 'status')).toContain('No pending changes.');
  expect(await run(page, repo, 'cat hello.txt')).toContain('Hello from Gitea.');

  expect((await api('GET', `/repos/owner/${repo}/branches/main`)).json.commit.id).toBe(before);
  expect(external).toEqual([]);
  expect(sockets).toEqual([]);
  expect(lazy).toEqual([]);
});

test('cd changes the prompt, Ctrl+D closes the terminal', async ({ page, request }) => {
  const { repo } = await makeRepo(request);
  await readyAt(page, repo);
  await openShell(page);
  expect(await run(page, repo, 'cd src')).toContain(`owner/${repo}@main:~/src$`);
  expect(await run(page, repo, 'cat main.ts')).toContain('export const needle = 1;');
  await page.keyboard.press('Control+D');
  await expect.poll(() => terminals(page)).toBe(0);
});
