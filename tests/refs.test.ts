import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GiteaRefs, RepositoryError, validateBranchName } from '../packages/gitea-repository/src/index.js';
import { encodeRef } from '../packages/gitea-repository/src/path.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

interface Seen {
	method: string;
	url: URL;
	body: unknown;
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function refs(handler: (seen: Seen) => Response) {
	const seen: Seen[] = [];
	const client = new GiteaRefs({
		instance: 'https://git.example.com/sub',
		owner: 'alice',
		repository: 'demo',
		limits: { retryBaseDelayMs: 0, retryMaxDelayMs: 0 },
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const entry: Seen = {
				method: init?.method ?? 'GET',
				url: new URL(String(input)),
				body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
			};
			seen.push(entry);
			return handler(entry);
		}) as typeof fetch,
	});
	return { client, seen };
}

async function failure(promise: Promise<unknown>): Promise<RepositoryError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof RepositoryError, String(error));
		return error;
	}
	assert.fail('expected a rejection');
}

describe('GiteaRefs listing', () => {
	it('pages branches 50 at a time until an empty page', async () => {
		const page = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, commit: { id: A } }));
		const { client, seen } = refs((s) => json(200, s.url.searchParams.get('page') === '1' ? page(50) : s.url.searchParams.get('page') === '2' ? page(7) : []));
		const { branches, truncated } = await client.listBranches();
		assert.equal(branches.length, 57);
		assert.equal(truncated, false);
		assert.deepEqual(seen.map((s) => [s.url.pathname, s.url.searchParams.get('page'), s.url.searchParams.get('limit')]), [
			['/sub/api/v1/repos/alice/demo/branches', '1', '50'],
			['/sub/api/v1/repos/alice/demo/branches', '2', '50'],
			['/sub/api/v1/repos/alice/demo/branches', '3', '50'],
		]);
	});

	it('F5: keeps paging when the server caps pages below the requested limit', async () => {
		const all = Array.from({ length: 70 }, (_, i) => ({ name: `b${i}`, commit: { id: A } }));
		const { client } = refs((s) => json(200, all.slice((Number(s.url.searchParams.get('page')) - 1) * 30, Number(s.url.searchParams.get('page')) * 30)));
		const { branches, truncated } = await client.listBranches();
		assert.equal(branches.length, 70);
		assert.equal(truncated, false);
	});

	it('stops at the page cap and says so', async () => {
		const full = Array.from({ length: 50 }, (_, i) => ({ name: `b${i}`, commit: { id: A } }));
		const { client, seen } = refs(() => json(200, full));
		const { branches, truncated } = await client.listBranches();
		assert.equal(truncated, true);
		assert.equal(seen.length, 20);
		assert.equal(branches.length, 1000);
	});

	it('reads tags, whose commit is under commit.sha', async () => {
		const { client, seen } = refs((s) => json(200, s.url.searchParams.get('page') === '1' ? [{ name: 'v1', id: B, commit: { sha: A } }] : []));
		assert.deepEqual(await client.listTagRefs(), { branches: [{ name: 'v1', commit: A }], truncated: false });
		assert.equal(seen[0].url.pathname, '/sub/api/v1/repos/alice/demo/tags');
	});

	it('F9: listTagRefs reports truncation like listBranches', async () => {
		const full = Array.from({ length: 50 }, (_, i) => ({ name: `v${i}`, commit: { sha: A } }));
		const capped = refs(() => json(200, full));
		const { branches, truncated } = await capped.client.listTagRefs();
		assert.equal(truncated, true);
		assert.equal(branches.length, 1000);
		assert.equal(capped.seen[0].url.pathname, '/sub/api/v1/repos/alice/demo/tags');
		const short = refs(() => json(200, []));
		assert.deepEqual(await short.client.listTagRefs(), { branches: [], truncated: false });
	});

	it('rejects a malformed entry', async () => {
		const { client } = refs(() => json(200, [{ name: 'x', commit: { id: 'nope' } }]));
		assert.equal((await failure(client.listBranches())).code, 'protocol');
	});
});

describe('GiteaRefs.createBranch', () => {
	it('posts the new name and the source ref', async () => {
		const { client, seen } = refs(() => json(201, { name: 'topic/x', commit: { id: A } }));
		assert.deepEqual(await client.createBranch('topic/x', B), { name: 'topic/x', commit: A });
		assert.equal(seen[0].method, 'POST');
		assert.equal(seen[0].url.pathname, '/sub/api/v1/repos/alice/demo/branches');
		assert.deepEqual(seen[0].body, { new_branch_name: 'topic/x', old_ref_name: B });
	});

	it('maps 409 to branch-exists and 404 to not-found', async () => {
		const conflict = refs(() => json(409, { message: 'The branch already exists.' }));
		const error = await failure(conflict.client.createBranch('main', A));
		assert.deepEqual([error.code, error.status], ['branch-exists', 409]);
		const missing = refs(() => json(404, { message: 'The old branch does not exist' }));
		assert.equal((await failure(missing.client.createBranch('x', 'nope'))).code, 'not-found');
	});

	it('rejects invalid names before any request', async () => {
		const { client, seen } = refs(() => json(201, {}));
		for (const name of ['a..b', 'with space', 'refs/heads/x', '']) {
			assert.equal((await failure(client.createBranch(name, A))).code, 'invalid-argument');
		}
		assert.equal(seen.length, 0);
		assert.equal(validateBranchName('feature/ok-1'), 'feature/ok-1');
	});

	it('is not retried after a server error', async () => {
		const { client, seen } = refs(() => json(502, {}));
		await failure(client.createBranch('x', A));
		assert.equal(seen.length, 1);
	});
});

describe('GiteaRefs.branchHead and defaultBranch', () => {
	it('returns the head, encoding slash names per segment', async () => {
		const { client, seen } = refs(() => json(200, { name: 'a/b#c', commit: { id: A } }));
		assert.equal(await client.branchHead('a/b#c'), A);
		assert.equal(seen[0].url.pathname, '/sub/api/v1/repos/alice/demo/branches/a/b%23c');
	});

	it('returns undefined for a deleted branch but fails on other errors', async () => {
		assert.equal(await refs(() => json(404, { message: 'gone' })).client.branchHead('x'), undefined);
		assert.equal((await failure(refs(() => json(403, {})).client.branchHead('x'))).code, 'forbidden');
	});

	it('reads the default branch', async () => {
		assert.equal(await refs(() => json(200, { default_branch: 'trunk' })).client.defaultBranch(), 'trunk');
		assert.equal((await failure(refs(() => json(200, {})).client.defaultBranch())).code, 'protocol');
	});
});

describe('F6: ref validation on branchHead and compare', () => {
	it('rejects refs that would reach other API routes, without a request', async () => {
		const { client, seen } = refs(() => json(200, { total_commits: 1, commit: { id: A } }));
		for (const bad of ['..', '../../../x', 'a/../b', 'a/./b', 'a..b', '', 'a b', '/x', 'x/']) {
			assert.equal((await failure(client.branchHead(bad))).code, 'invalid-argument', `branchHead ${bad}`);
			assert.equal((await failure(client.compare(bad, A))).code, 'invalid-argument', `compare base ${bad}`);
			assert.equal((await failure(client.compare(A, bad))).code, 'invalid-argument', `compare head ${bad}`);
		}
		assert.equal(seen.length, 0);
	});

	it('encodeRef refuses . and .. segments', () => {
		for (const bad of ['..', '.', 'a/../b', 'a/./b', './a']) {
			assert.throws(() => encodeRef(bad), (error: unknown) => error instanceof RepositoryError && error.code === 'invalid-argument', bad);
		}
		assert.equal(encodeRef('a/b c'), 'a/b%20c');
	});
});

describe('GiteaRefs.compare', () => {
	it('asks for base...head without verification or file lists and returns the count', async () => {
		const { client, seen } = refs(() => json(200, { total_commits: 4, commits: [] }));
		assert.deepEqual(await client.compare(A, 'feature/x'), { ahead: 4 });
		assert.equal(seen[0].url.pathname, `/sub/api/v1/repos/alice/demo/compare/${A}...feature/x`);
		assert.equal(seen[0].url.searchParams.get('verification'), 'false');
		assert.equal(seen[0].url.searchParams.get('files'), 'false');
	});

	it('reports an unknown count when the unpaged response is over the cap', async () => {
		const huge = new Response(new Uint8Array(1024 * 1024 + 1), { status: 200, headers: { 'content-length': String(1024 * 1024 + 1) } });
		assert.deepEqual(await refs(() => huge).client.compare(A, B), { ahead: undefined });
	});

	it('reports an unknown count when the base commit no longer exists', async () => {
		assert.deepEqual(await refs(() => json(404, { message: 'no' })).client.compare(A, B), { ahead: undefined });
	});
});

describe('GiteaRefs.createPullRequest', () => {
	it('posts head, base, title and body', async () => {
		const { client, seen } = refs(() => json(201, { number: 7, html_url: 'https://git.example.com/sub/alice/demo/pulls/7' }));
		const created = await client.createPullRequest({ head: 'topic', base: 'main', title: 'T', body: 'B' });
		assert.deepEqual(created, { number: 7, url: 'https://git.example.com/sub/alice/demo/pulls/7' });
		assert.equal(seen[0].url.pathname, '/sub/api/v1/repos/alice/demo/pulls');
		assert.deepEqual(seen[0].body, { head: 'topic', base: 'main', title: 'T', body: 'B' });
	});

	it('keeps the status of a duplicate (409) and of same head and base (422)', async () => {
		const duplicate = refs(() => json(409, { message: 'pull request already exists for these targets' }));
		assert.equal((await failure(duplicate.client.createPullRequest({ head: 'a', base: 'b', title: 't' }))).status, 409);
		const same = refs(() => json(422, { message: 'no changes' }));
		assert.equal((await failure(same.client.createPullRequest({ head: 'a', base: 'a', title: 't' }))).status, 422);
	});
});
