import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type {
	InitializableGiteaRepository,
	RepositoryCommit,
	RepositoryEntry,
	RepositoryFile,
	RepositoryState,
} from '../packages/gitea-repository/src/types.js';
import { descriptorIdentity, type Descriptor } from '../packages/gitea-vscode-web/src/descriptor.js';
import { MemorySecretStore } from '../packages/gitea-repository/src/index.js';
import { AuthRegistry } from '../packages/gitea-vscode-web/src/auth.js';
import { OverlayError } from '../packages/gitea-vscode-web/src/overlay.js';
import { Session, type RefsApi } from '../packages/gitea-vscode-web/src/session.js';
import { SessionRegistry } from '../packages/gitea-vscode-web/src/sessions.js';
import { MemoryOverlayStorage } from '../packages/gitea-vscode-web/src/storage.js';

const enc = new TextEncoder();
const WRITE = { create: true, overwrite: true };
const HEAD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

const blobSha = (text: string) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${text.length}\0`), Buffer.from(text)])).digest('hex');

class NotFound extends Error {
	readonly code = 'not-found';
}

class FakeRepo implements InitializableGiteaRepository {
	readonly files = new Map<string, string>([['a.txt', 'alpha'], ['b.txt', 'bravo']]);
	readonly commits: RepositoryCommit[] = [];
	readonly refreshed: Array<string | undefined> = [];
	state: RepositoryState = { commit: HEAD, branch: 'main', canWrite: true, canBranch: true };

	async initialize() {
		return this.state;
	}

	async refresh(commit?: string) {
		this.refreshed.push(commit);
	}

	#entry(path: string): RepositoryEntry {
		const text = this.files.get(path);
		if (text !== undefined) return { path, name: path, type: 'file', sha: blobSha(text), size: text.length };
		if (path === '') return { path, name: '', type: 'directory', sha: 'd'.repeat(40), size: 0 };
		throw new NotFound(path);
	}

	async getEntry(path: string) {
		return this.#entry(path);
	}

	async readDirectory(): Promise<RepositoryEntry[]> {
		return [...this.files.keys()].map((path) => this.#entry(path));
	}

	async readFile(path: string): Promise<RepositoryFile> {
		return { entry: this.#entry(path), content: enc.encode(this.files.get(path)) };
	}

	async commit(change: RepositoryCommit) {
		this.commits.push(change);
		return { sha: NEW };
	}
}

class FakeRefs implements RefsApi {
	readonly created: Array<[string, string]> = [];
	head: string | undefined = HEAD;
	incoming: number | undefined = 3;
	compared: Array<[string, string]> = [];

	async listBranches() {
		return { branches: [], truncated: false };
	}

	async listTagRefs() {
		return { branches: [], truncated: false };
	}

	async createBranch(name: string, from: string) {
		this.created.push([name, from]);
		return { name, commit: from };
	}

	async branchHead() {
		return this.head;
	}

	async defaultBranch() {
		return 'main';
	}

	async compare(base: string, head: string) {
		this.compared.push([base, head]);
		return { ahead: this.incoming };
	}

	async createPullRequest() {
		return { number: 1, url: 'https://git.example/o/r/pulls/1' };
	}
}

const DESCRIPTOR: Descriptor = { instance: 'https://git.example', owner: 'o', repository: 'r', ref: 'main', refKind: 'branch' };

async function open(options: { descriptor?: Descriptor; state?: Partial<RepositoryState> } = {}) {
	const repo = new FakeRepo();
	Object.assign(repo.state, options.state);
	const refs = new FakeRefs();
	const storage = new MemoryOverlayStorage();
	const descriptor = options.descriptor ?? DESCRIPTOR;
	const session = await Session.open(descriptor, {
		storage,
		auth: { headers: async () => ({}) },
		createRepository: () => repo,
		createRefs: () => refs,
	});
	return { session, repo, refs, storage, descriptor };
}

async function rejectsWith(promise: Promise<unknown>, code: OverlayError['code']) {
	await assert.rejects(promise, (error: unknown) => error instanceof OverlayError && error.code === code);
}

describe('Session.commit on a protected branch', () => {
	it('rejects with Protected, sends nothing and keeps the changes', async () => {
		const { session, repo } = await open({ state: { canWrite: false, canBranch: true } });
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		await rejectsWith(session.commit('m'), 'Protected');
		assert.equal(repo.commits.length, 0);
		assert.equal(session.overlay.size, 1);
	});

	it('commits to a new branch instead, leaving the opened branch and its base alone', async () => {
		const { session, repo } = await open({ state: { canWrite: false, canBranch: true } });
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		const result = await session.commit('Fix a\n\nbody', { newBranch: 'fix-a' });
		assert.equal(repo.commits.length, 1);
		assert.equal(repo.commits[0].newBranch, 'fix-a');
		assert.equal(repo.commits[0].baseCommit, HEAD);
		assert.deepEqual([result.sha, result.branch, result.changes], [NEW, 'fix-a', 1]);
		assert.equal(session.baseCommit, HEAD, 'the opened branch did not move');
		assert.equal(session.overlay.size, 0);
		assert.equal(repo.refreshed.at(-1), HEAD);
	});

	it('refuses a new branch without write access to the repository', async () => {
		const { session, repo } = await open({ state: { canWrite: false, canBranch: false } });
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		await rejectsWith(session.commit('m'), 'ReadOnly');
		await rejectsWith(session.commit('m', { newBranch: 'x' }), 'ReadOnly');
		assert.equal(repo.commits.length, 0);
	});
});

describe('Session.commit on a writable branch', () => {
	it('moves the base to the new commit and sends no newBranch', async () => {
		const { session, repo } = await open();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		const result = await session.commit('m');
		assert.equal(repo.commits[0].newBranch, undefined);
		assert.equal(result.branch, 'main');
		assert.equal(session.baseCommit, NEW);
	});

	it('commits only the given paths', async () => {
		const { session, repo } = await open();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		await session.overlay.writeFile('b.txt', enc.encode('mine too'), WRITE);
		await session.commit('m', { paths: ['b.txt'] });
		assert.deepEqual(repo.commits[0].changes.map((c) => c.path), ['b.txt']);
		assert.deepEqual(session.overlay.list().map((c) => c.path), ['a.txt']);
		assert.equal(session.baseCommit, NEW);
	});

	it('refuses tags and read-only sessions', async () => {
		const tag = await open({ state: { branch: null, canWrite: false, canBranch: false } });
		await tag.session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		await rejectsWith(tag.session.commit('m', { newBranch: 'x' }), 'ReadOnly');
		const readonly = await open({ descriptor: { ...DESCRIPTOR, mode: 'readonly' } });
		await rejectsWith(readonly.session.commit('m'), 'ReadOnly');
		await rejectsWith(readonly.session.createBranch('x'), 'ReadOnly');
	});
});

describe('Session.createBranch', () => {
	it('cuts the branch at the base commit and moves pending changes to its overlay', async () => {
		const { session, refs, storage, descriptor } = await open();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		const created = await session.createBranch('topic');
		assert.deepEqual(refs.created, [['topic', HEAD]]);
		assert.equal(created.name, 'topic');
		assert.equal(session.overlay.size, 0);
		const rows = await storage.loadIdentity(descriptorIdentity({ ...descriptor, ref: 'topic', refKind: 'branch' }));
		assert.deepEqual(rows.map((row) => [row.path, row.baseCommit]), [['a.txt', HEAD]]);
	});

	it('leaves pending changes alone when the server refuses the branch', async () => {
		const { session, refs } = await open();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		refs.createBranch = async () => {
			throw new Error('exists');
		};
		await assert.rejects(session.createBranch('topic'), /exists/);
		assert.equal(session.overlay.size, 1);
	});
});

describe('Session remote checks', () => {
	it('reads the branch head, and nothing for a tag', async () => {
		const { session, refs } = await open();
		refs.head = NEW;
		assert.equal(await session.remoteHead(), NEW);
		const tag = await open({ state: { branch: null } });
		assert.equal(await tag.session.remoteHead(), undefined);
	});

	it('counts incoming commits from the session base to the head', async () => {
		const { session, refs } = await open();
		assert.equal(await session.countIncoming(NEW), 3);
		assert.deepEqual(refs.compared, [[HEAD, NEW]]);
		refs.incoming = undefined;
		assert.equal(await session.countIncoming(NEW), undefined);
	});
});

describe('Session refresh and commit together', () => {
	it('never moves the base back when a refresh probed before a commit landed', async () => {
		const { session, repo } = await open();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let probes = 0;
		repo.initialize = async () => {
			const snapshot = { ...repo.state };
			if (probes++ === 0) await gate;
			return snapshot;
		};
		const commit = repo.commit.bind(repo);
		repo.commit = async (change) => {
			const result = await commit(change);
			repo.state = { ...repo.state, commit: result.sha };
			return result;
		};
		const refreshing = session.refresh();
		const committing = session.commit('m');
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();
		await Promise.all([refreshing, committing]);
		assert.equal(session.baseCommit, NEW);
		assert.equal(repo.refreshed.at(-1), NEW, 'the reader is at the same commit as the overlay');
		assert.equal(session.overlay.size, 0);
	});
});

describe('Session.createBranch when opening the branch fails', () => {
	it('moves the pending changes back to the opened branch', async () => {
		const { session, storage, descriptor } = await open();
		await session.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		await assert.rejects(
			session.createBranch('topic', async () => {
				throw new Error('navigation blocked');
			}),
			/navigation blocked/,
		);
		assert.deepEqual(session.overlay.list().map((c) => c.path), ['a.txt']);
		assert.deepEqual(await storage.loadIdentity(descriptorIdentity({ ...descriptor, ref: 'topic', refKind: 'branch' })), []);
	});
});

describe('SessionRegistry', () => {
	it('opens one session even when an open listener throws', async () => {
		const repo = new FakeRepo();
		const logs: string[] = [];
		const registry = new SessionRegistry({
			storage: new MemoryOverlayStorage(),
			auth: new AuthRegistry(new MemorySecretStore()),
			createRepository: () => repo,
			createRefs: () => new FakeRefs(),
			log: (message) => logs.push(message),
		});
		let opened = 0;
		registry.onDidOpen(() => {
			opened++;
			throw new Error('listener broke');
		});
		const query = JSON.stringify(DESCRIPTOR);
		const first = await registry.resolve(query);
		const second = await registry.resolve(query);
		assert.equal(first, second);
		assert.equal(opened, 1);
		assert.equal(registry.sessions.length, 1);
		assert.ok(logs.some((message) => message.includes('listener broke')), logs.join('\n'));
	});
});
