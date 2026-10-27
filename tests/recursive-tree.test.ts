// Recursive tree listing: GET git/trees/{sha}?recursive=true, paged by total_count, which also
// fills the per-directory cache so later directory reads and searches need no request.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { HttpGiteaRepository, RepositoryError, type RepositoryEntry } from '../packages/gitea-repository/src/index.js';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

interface Row {
	path: string;
	mode: string;
	type: string;
	size: number;
	sha: string;
}

type Spec = string | { symlink: string } | { submodule: string };

/** The tree endpoints of Gitea 1.24+, as documented in its swagger: recursive, page, per_page, truncated = more pages follow. */
class FakeTrees {
	readonly instance = 'https://git.example.com';
	readonly commit = 'c'.repeat(40);
	readonly trees = new Map<string, Row[]>();
	readonly requests: URL[] = [];
	root = '';
	perPageCap = 1000;
	mutate: (url: URL, body: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined;

	constructor(files: Record<string, Spec>) {
		this.root = this.build(new Map(Object.entries(files)));
	}

	build(files: Map<string, Spec>): string {
		const rows: Row[] = [];
		const groups = new Map<string, Map<string, Spec>>();
		for (const [path, spec] of files) {
			const slash = path.indexOf('/');
			if (slash >= 0) {
				const head = path.slice(0, slash);
				groups.set(head, (groups.get(head) ?? new Map()).set(path.slice(slash + 1), spec));
			} else if (typeof spec === 'string') {
				rows.push({ path, mode: '100644', type: 'blob', size: spec.length, sha: sha1(`blob ${spec}`) });
			} else if ('symlink' in spec) {
				rows.push({ path, mode: '120000', type: 'blob', size: spec.symlink.length, sha: sha1(`link ${spec.symlink}`) });
			} else {
				rows.push({ path, mode: '160000', type: 'commit', size: 0, sha: sha1(`sub ${spec.submodule}`) });
			}
		}
		for (const [name, group] of groups) {
			rows.push({ path: name, mode: '040000', type: 'tree', size: 0, sha: this.build(group) });
		}
		rows.sort((a, b) => (a.path < b.path ? -1 : 1));
		const sha = sha1(`tree ${JSON.stringify(rows)}`);
		this.trees.set(sha, rows);
		return sha;
	}

	/** Pre-order listing, like `git ls-tree -r -t`. */
	flatten(sha: string, prefix = ''): Row[] {
		const out: Row[] = [];
		for (const row of this.trees.get(sha) as Row[]) {
			out.push({ ...row, path: prefix + row.path });
			if (row.type === 'tree') {
				out.push(...this.flatten(row.sha, `${prefix}${row.path}/`));
			}
		}
		return out;
	}

	get treeRequests(): URL[] {
		return this.requests.filter((url) => url.pathname.includes('/git/trees/'));
	}

	readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		this.requests.push(url);
		init?.signal?.throwIfAborted();
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
		const path = url.pathname.replace('/api/v1/repos/alice/demo', '');
		if (path === '') {
			return json({ empty: false, permissions: { push: true } });
		}
		if (path === '/branches/main') {
			return json({ commit: { id: this.commit }, user_can_push: true });
		}
		if (path === `/git/commits/${this.commit}`) {
			return json({ sha: this.commit, commit: { tree: { sha: this.root } } });
		}
		const match = /^\/git\/trees\/([0-9a-f]+)$/.exec(path);
		const rows = match === null ? undefined : this.trees.get(match[1]);
		if (match === null || rows === undefined) {
			return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
		}
		const recursive = url.searchParams.get('recursive') === 'true';
		const all = recursive ? this.flatten(match[1]) : rows;
		const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 1000), this.perPageCap);
		const page = Number(url.searchParams.get('page') ?? 1);
		const slice = all.slice((page - 1) * perPage, page * perPage);
		const body = {
			sha: match[1],
			tree: slice.map((row) => ({ ...row, url: 'x' })),
			truncated: page * perPage < all.length,
			page,
			total_count: all.length,
		};
		return json(this.mutate(url, body) ?? body);
	}) as typeof fetch;

	open(limits: ConstructorParameters<typeof HttpGiteaRepository>[0]['limits'] = {}): HttpGiteaRepository {
		return new HttpGiteaRepository({ instance: this.instance, owner: 'alice', repository: 'demo', ref: 'main', fetch: this.fetch, limits: { maxRetries: 0, ...limits } });
	}
}

const FILES: Record<string, Spec> = {
	'README.md': 'readme',
	'a/one.txt': '1',
	'a/two.txt': '22',
	'a/b/three.txt': '333',
	'a/b/c/four.txt': '4444',
	'z/last.txt': 'last',
	link: { symlink: 'README.md' },
	vendor: { submodule: 'deadbeef' },
};

const view = (entries: RepositoryEntry[]) => entries.map(({ path, name, type, sha, size }) => ({ path, name, type, sha, size }));

async function failure(promise: Promise<unknown>): Promise<RepositoryError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
		return error;
	}
	assert.fail('expected rejection');
}

describe('recursive tree listing', () => {
	it('lists every entry below the root in tree order with sizes and shas', async () => {
		const fake = new FakeTrees(FILES);
		const repo = fake.open();
		await repo.initialize();
		const entries = await repo.readTree('');
		const expected = fake.flatten(fake.root).map((row) => ({
			path: row.path,
			name: row.path.slice(row.path.lastIndexOf('/') + 1),
			type: row.type === 'tree' ? 'directory' : row.mode === '120000' ? 'symlink' : row.type === 'commit' ? 'submodule' : 'file',
			sha: row.sha,
			size: row.type === 'blob' ? row.size : 0,
		}));
		assert.deepEqual(view(entries), expected);
		assert.deepEqual(entries.map((e) => e.type).filter((t) => t === 'symlink' || t === 'submodule'), ['symlink', 'submodule']);
	});

	it('asks for recursive=true and reads pages 1..n of per_page 1000 until total_count', async () => {
		const files: Record<string, Spec> = {};
		for (let i = 0; i < 2500; i++) {
			files[`d${i % 10}/f${i}.txt`] = String(i);
		}
		const fake = new FakeTrees(files);
		const repo = fake.open();
		await repo.initialize();
		fake.requests.length = 0;
		const entries = await repo.readTree('');
		assert.equal(entries.filter((e) => e.type === 'file').length, 2500);
		assert.equal(entries.length, 2510);
		const requests = fake.treeRequests;
		assert.equal(requests.length, 3);
		assert.deepEqual(requests.map((u) => u.searchParams.get('page')), ['1', '2', '3']);
		for (const url of requests) {
			assert.equal(url.searchParams.get('recursive'), 'true');
			assert.equal(url.searchParams.get('per_page'), '1000');
			assert.ok(url.pathname.endsWith(`/git/trees/${fake.root}`));
		}
	});

	it('F2: keeps every directory of a large listing cached, past the cache entry limit', async () => {
		const files: Record<string, Spec> = {};
		for (let i = 0; i < 2100; i++) {
			files[`d${i}/f.txt`] = String(i);
		}
		const fake = new FakeTrees(files);
		const repo = fake.open();
		await repo.initialize();
		await repo.readTree('');
		fake.requests.length = 0;
		assert.equal((await repo.readDirectory('d0')).length, 1);
		assert.equal((await repo.readDirectory('d2099')).length, 1);
		assert.equal(fake.treeRequests.length, 0, 'directory reads below a listed tree need no request');
	});

	it('C1: directory reads apply the same entry checks as recursive listings', async () => {
		const bodies: Array<(body: Record<string, unknown>) => Record<string, unknown>> = [
			(body) => ({ ...body, tree: [{ ...(body.tree as Array<Record<string, unknown>>)[0], path: '..' }] }),
			(body) => ({ ...body, total_count: 1.5 }),
			(body) => ({ ...body, total_count: 1 }),
		];
		for (const change of bodies) {
			const fake = new FakeTrees(FILES);
			fake.mutate = (url, body) => (url.searchParams.get('recursive') === null ? change(body) : undefined);
			const repo = fake.open();
			await repo.initialize();
			assert.equal((await failure(repo.readDirectory(''))).code, 'protocol', String(change));
		}
	});

	it('keeps reading when the server caps the page size below the requested one', async () => {
		const fake = new FakeTrees(FILES);
		fake.perPageCap = 3;
		const repo = fake.open();
		await repo.initialize();
		const entries = await repo.readTree('');
		assert.equal(entries.length, fake.flatten(fake.root).length);
		assert.ok(fake.treeRequests.length >= 4);
	});

	it('does not treat truncated=true on a non-final page as a failure or a stop', async () => {
		const fake = new FakeTrees(FILES);
		fake.perPageCap = 4;
		const repo = fake.open();
		await repo.initialize();
		const pages: boolean[] = [];
		fake.mutate = (_url, body) => {
			pages.push(body.truncated as boolean);
			return undefined;
		};
		assert.equal((await repo.readTree('')).length, fake.flatten(fake.root).length);
		assert.deepEqual(pages, [true, true, false]);
	});

	it('serves later directory reads below the root from the cache, identical to per-directory reads', async () => {
		const fake = new FakeTrees(FILES);
		const recursive = fake.open();
		await recursive.initialize();
		await recursive.readTree('');
		fake.requests.length = 0;
		const viaTree: Record<string, unknown> = {};
		for (const dir of ['', 'a', 'a/b', 'a/b/c', 'z']) {
			viaTree[dir] = await recursive.readDirectory(dir);
		}
		assert.equal(fake.treeRequests.length, 0, 'readDirectory must hit the seeded cache');
		assert.equal((await recursive.getEntry('a/b/three.txt')).size, 3);
		assert.equal(fake.treeRequests.length, 0);

		const plain = fake.open();
		await plain.initialize();
		for (const dir of ['', 'a', 'a/b', 'a/b/c', 'z']) {
			assert.deepEqual(viaTree[dir], await plain.readDirectory(dir), dir);
		}
	});

	it('does not repeat the request chain for a listing it already has, and shares one among concurrent callers', async () => {
		const fake = new FakeTrees(FILES);
		fake.perPageCap = 5;
		const repo = fake.open();
		await repo.initialize();
		fake.requests.length = 0;
		const [first, second] = await Promise.all([repo.readTree(''), repo.readTree('')]);
		const pages = fake.treeRequests.length;
		assert.deepEqual(view(first), view(second));
		assert.equal(pages, Math.ceil(fake.flatten(fake.root).length / 5));
		await repo.readTree('');
		assert.equal(fake.treeRequests.length, pages);
	});

	it('lists a subdirectory with repository-relative paths', async () => {
		const fake = new FakeTrees(FILES);
		const repo = fake.open();
		await repo.initialize();
		const entries = await repo.readTree('a');
		assert.deepEqual(entries.map((e) => e.path), ['a/b', 'a/b/c', 'a/b/c/four.txt', 'a/b/three.txt', 'a/one.txt', 'a/two.txt']);
		assert.deepEqual(entries.map((e) => e.name), ['b', 'c', 'four.txt', 'three.txt', 'one.txt', 'two.txt']);
		const directory = (await repo.getEntry('a')).sha;
		assert.ok(fake.treeRequests.some((u) => u.pathname.endsWith(`/git/trees/${directory}`) && u.searchParams.get('recursive') === 'true'));
	});

	it('rejects a file and a missing path', async () => {
		const fake = new FakeTrees(FILES);
		const repo = fake.open();
		await repo.initialize();
		assert.equal((await failure(repo.readTree('README.md'))).code, 'not-a-directory');
		assert.equal((await failure(repo.readTree('nope'))).code, 'not-found');
	});

	it('refuses a tree over maxTreeEntries after the first page and fills no cache', async () => {
		const fake = new FakeTrees(FILES);
		const repo = fake.open({ maxTreeEntries: 5 });
		await repo.initialize();
		fake.requests.length = 0;
		const error = await failure(repo.readTree(''));
		assert.equal(error.code, 'file-too-large');
		assert.equal(fake.treeRequests.length, 1);
		await repo.readDirectory('a');
		assert.ok(fake.treeRequests.length > 1, 'directory reads still work and are fetched one at a time');
	});

	it('rejects malformed pages and fills no cache from a partial listing', async () => {
		const cases: Array<[string, (url: URL, body: Record<string, unknown>) => Record<string, unknown> | undefined]> = [
			[
				'an entry without a listed parent directory',
				(_u, body) => {
					const tree = (body.tree as Row[]).filter((r) => r.path !== 'a/b');
					return { ...body, tree, total_count: tree.length };
				},
			],
			['an empty page before total_count', (_u, body) => ({ ...body, tree: [] })],
			['no total_count', (_u, body) => ({ ...body, total_count: undefined })],
			['a negative size', (_u, body) => ({ ...body, tree: (body.tree as Row[]).map((r) => ({ ...r, size: r.type === 'blob' ? -1 : r.size })) })],
			['an entry named ..', (_u, body) => ({ ...body, tree: (body.tree as Row[]).map((r) => ({ ...r, path: r.path === 'README.md' ? '..' : r.path })) })],
			['more entries than total_count', (_u, body) => ({ ...body, total_count: 1 })],
		];
		for (const [name, mutate] of cases) {
			const fake = new FakeTrees(FILES);
			const repo = fake.open();
			await repo.initialize();
			fake.mutate = (url, body) => (url.searchParams.get('recursive') === 'true' ? mutate(url, body) : undefined);
			assert.equal((await failure(repo.readTree(''))).code, 'protocol', name);
			fake.requests.length = 0;
			await repo.readDirectory('');
			assert.equal(fake.treeRequests.length, 1, `${name}: the cache must not have been filled`);
		}
	});

	it('honors an aborted signal', async () => {
		const fake = new FakeTrees(FILES);
		const repo = fake.open();
		await repo.initialize();
		const controller = new AbortController();
		controller.abort();
		assert.equal((await failure(repo.readTree('', { signal: controller.signal }))).code, 'aborted');
	});

	it('forgets cached listings on logout', async () => {
		const fake = new FakeTrees(FILES);
		const repo = fake.open();
		await repo.initialize();
		await repo.readTree('');
		await repo.logout();
		await repo.initialize();
		fake.requests.length = 0;
		await repo.readTree('');
		assert.ok(fake.treeRequests.length > 0);
	});
});
