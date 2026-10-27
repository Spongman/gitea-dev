import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { beforeEach, describe, it } from 'node:test';
import type { InitializableGiteaRepository, RepositoryEntry, RepositoryFile, RepositoryState } from '../packages/gitea-repository/src/types.js';
import { descriptorIdentity, type Descriptor } from '../packages/gitea-vscode-web/src/descriptor.js';
import { Session, type RefsApi } from '../packages/gitea-vscode-web/src/session.js';
import { MemoryOverlayStorage } from '../packages/gitea-vscode-web/src/storage.js';

const stub = new URL('./vscode-stub.ts', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === 'vscode' ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : n(s, c); }`)}`);
const vscode = await import(stub);
const { registerRefUi } = await import('../packages/gitea-vscode-web/src/refs-ui.js');

const enc = new TextEncoder();
const HEAD = 'a'.repeat(40);
const DESCRIPTOR: Descriptor = { instance: 'https://git.example', owner: 'o', repository: 'r', ref: 'main', refKind: 'branch' };

class NotFound extends Error {
	readonly code = 'not-found';
}

function repository(): InitializableGiteaRepository {
	const text = 'alpha';
	const entry = (path: string): RepositoryEntry => {
		if (path === '') return { path, name: '', type: 'directory', sha: 'd'.repeat(40), size: 0 };
		if (path !== 'a.txt') throw new NotFound(path);
		return { path, name: path, type: 'file', sha: createHash('sha1').update(`blob ${text.length}\0${text}`).digest('hex'), size: text.length };
	};
	const state: RepositoryState = { commit: HEAD, branch: 'main', canWrite: true, canBranch: true };
	return {
		initialize: async () => state,
		refresh: async () => undefined,
		getEntry: async (path: string) => entry(path),
		readDirectory: async () => [entry('a.txt')],
		readFile: async (path: string): Promise<RepositoryFile> => ({ entry: entry(path), content: enc.encode(text) }),
		commit: async () => ({ sha: 'b'.repeat(40) }),
	} as unknown as InitializableGiteaRepository;
}

const refs = (): RefsApi => ({
	listBranches: async () => ({ branches: [], truncated: false }),
	listTagRefs: async () => ({ branches: [], truncated: false }),
	createBranch: async (name: string, from: string) => ({ name, commit: from }),
	branchHead: async () => HEAD,
	defaultBranch: async () => 'main',
	compare: async () => ({ ahead: 0 }),
	createPullRequest: async () => ({ number: 7, url: 'https://evil.example/phish' }),
});

async function setup(api: RefsApi = refs()) {
	const storage = new MemoryOverlayStorage();
	const session = await Session.open(DESCRIPTOR, { storage, auth: { headers: async () => ({}) }, createRepository: repository, createRefs: () => api });
	const view = { session, sourceControl: {} };
	const context = { subscriptions: [] as { dispose(): void }[] };
	registerRefUi(context as never, {
		scm: { views: [view] },
		registry: { onDidOpen: () => () => undefined, sessions: [] },
		pickView: async () => view,
		log: () => undefined,
	} as never);
	const run = (id: string, arg?: unknown) => vscode.commands.executeCommand(id, arg) as Promise<Record<string, unknown>>;
	return { session, storage, run, context };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => vscode.testing.reset());

describe('create branch', () => {
	it('keeps pending changes on the opened branch when opening the new branch fails', async () => {
		const { session, storage, run } = await setup();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), { create: true, overwrite: true });
		vscode.testing.hostCommands.set('giteaHost.openRef', () => {
			throw new Error('navigation blocked');
		});
		const result = await run('gitea.createBranch', { name: 'topic' });
		assert.equal(result.ok, false);
		assert.deepEqual(session.overlay.list().map((c) => c.path), ['a.txt']);
		assert.deepEqual(await storage.loadIdentity(descriptorIdentity({ ...DESCRIPTOR, ref: 'topic', refKind: 'branch' })), []);
	});
});

describe('pull request link', () => {
	it('opens a pull request page on the instance, never a URL from elsewhere', async () => {
		const { run } = await setup();
		vscode.testing.answers.info = 'Open Pull Request';
		const result = await run('gitea.createPullRequest', { head: 'topic', base: 'main', title: 't' });
		assert.equal(result.ok, true);
		await settle();
		assert.deepEqual(vscode.testing.opened, ['https://git.example/o/r/pulls/7']);
	});

	it('opens the returned URL when it is on the instance', async () => {
		const { run } = await setup({ ...refs(), createPullRequest: async () => ({ number: 8, url: 'https://git.example/o/r/pulls/8' }) });
		vscode.testing.answers.info = 'Open Pull Request';
		await run('gitea.createPullRequest', { head: 'topic', base: 'main', title: 't' });
		await settle();
		assert.deepEqual(vscode.testing.opened, ['https://git.example/o/r/pulls/8']);
	});
});
