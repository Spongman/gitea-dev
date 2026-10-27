import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
	AlreadyExistsError,
	CommitOutcomeUnknownError,
	DEFAULT_LIMITS,
	FileTooLargeError,
	HttpGiteaRepository,
	PersonalAccessTokenAuth,
	RepositoryError,
	StaleBlobError,
	StaleHeadError,
	type AuthProvider,
	type HttpGiteaRepositoryOptions,
	type RepositoryChange,
	type RepositoryErrorCode,
} from '../packages/gitea-repository/src/index.js';

type Spec = string | Uint8Array | { symlink: string } | { submodule: string };

interface Row {
	path: string;
	mode: string;
	type: string;
	size: number;
	sha: string;
}

interface Rec {
	method: string;
	url: URL;
	rawPath: string;
	headers: Headers;
	body: unknown;
	signal: AbortSignal | null | undefined;
	init: RequestInit | undefined;
}

type Interceptor = (rec: Rec) => Response | Promise<Response> | undefined;

const sha1 = (text: string | Uint8Array) => createHash('sha1').update(text).digest('hex');
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const bytes = (spec: Spec): Uint8Array => {
	if (typeof spec === 'string') {
		return new TextEncoder().encode(spec);
	}
	if (spec instanceof Uint8Array) {
		return spec;
	}
	return 'symlink' in spec ? new TextEncoder().encode(spec.symlink) : new Uint8Array();
};
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

/** Minimal Gitea v1.24 model: refs, trees, blobs and the POST /contents guards read from the official source. */
class FakeGitea {
	readonly instance = 'https://git.example.com/sub/gitea';
	readonly commits = new Map<string, { files: Map<string, Spec>; tree: string; parent?: string }>();
	readonly branches = new Map<string, string>();
	readonly tags = new Map<string, string>();
	readonly blobs = new Map<string, Uint8Array>();
	readonly trees = new Map<string, Row[]>();
	/** LFS objects by oid, served by the media route like Gitea with its LFS server on. */
	readonly lfsObjects = new Map<string, Uint8Array>();
	readonly requests: Rec[] = [];
	readonly interceptors: Interceptor[] = [];
	push = true;
	archived = false;
	mirror = false;
	empty = false;
	userCanPush = true;
	maxBlob = 10 * 1024 * 1024;
	treePageCap = 1000;
	#counter = 0;

	constructor(public readonly owner = 'alice', public readonly repo = 'demo') {}

	treeSha(files: Map<string, Spec>): string {
		const rows: Row[] = [];
		const groups = new Map<string, Map<string, Spec>>();
		for (const [path, spec] of files) {
			const slash = path.indexOf('/');
			if (slash >= 0) {
				const head = path.slice(0, slash);
				groups.set(head, (groups.get(head) ?? new Map()).set(path.slice(slash + 1), spec));
				continue;
			}
			if (typeof spec === 'object' && !(spec instanceof Uint8Array) && 'submodule' in spec) {
				rows.push({ path, mode: '160000', type: 'commit', size: 0, sha: spec.submodule });
				continue;
			}
			const data = bytes(spec);
			const blob = sha1(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]));
			this.blobs.set(blob, data);
			const symlink = typeof spec === 'object' && !(spec instanceof Uint8Array);
			rows.push({ path, mode: symlink ? '120000' : '100644', type: 'blob', size: data.length, sha: blob });
		}
		for (const [name, group] of groups) {
			rows.push({ path: name, mode: '040000', type: 'tree', size: 0, sha: this.treeSha(group) });
		}
		rows.sort((a, b) => (a.path < b.path ? -1 : 1));
		const sha = sha1(`tree${JSON.stringify(rows)}`);
		this.trees.set(sha, rows);
		return sha;
	}

	commitFiles(files: Map<string, Spec>, parent?: string): string {
		const id = sha1(`commit ${this.#counter++}`);
		this.commits.set(id, { files, tree: this.treeSha(files), parent });
		return id;
	}

	/** Creates the branch (or advances it) with a new commit built from `files` or a mutation of the head. */
	seed(files: Record<string, Spec>, branch = 'main'): string {
		const id = this.commitFiles(new Map(Object.entries(files)), this.branches.get(branch));
		this.branches.set(branch, id);
		return id;
	}

	advance(mutate: (files: Map<string, Spec>) => void, branch = 'main'): string {
		const head = this.branches.get(branch) as string;
		const files = new Map((this.commits.get(head) as { files: Map<string, Spec> }).files);
		mutate(files);
		const id = this.commitFiles(files, head);
		this.branches.set(branch, id);
		return id;
	}

	blobSha(data: string | Uint8Array): string {
		const raw = bytes(data);
		return sha1(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]));
	}

	headFiles(branch = 'main') {
		return (this.commits.get(this.branches.get(branch) as string) as { files: Map<string, Spec> }).files;
	}

	posts() {
		return this.requests.filter((rec) => rec.method === 'POST');
	}

	count(fragment: string) {
		return this.requests.filter((rec) => rec.rawPath.includes(fragment)).length;
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const rec: Rec = {
			method: init?.method ?? 'GET',
			url,
			rawPath: url.pathname,
			headers: new Headers(init?.headers),
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
			signal: init?.signal,
			init,
		};
		this.requests.push(rec);
		for (const interceptor of this.interceptors) {
			const response = interceptor(rec);
			if (response !== undefined) {
				return response;
			}
		}
		return this.route(rec);
	};

	route(rec: Rec): Response {
		const prefix = '/sub/gitea/api/v1';
		if (!rec.rawPath.startsWith(prefix)) {
			return json(404, { message: 'not an api path' });
		}
		const parts = rec.rawPath.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
		if (parts[0] !== 'repos' || parts[1] !== this.owner || parts[2] !== this.repo) {
			return json(404, { message: 'repository does not exist' });
		}
		const rest = parts.slice(3);
		const head = rest[0];
		if (head === undefined) {
			return json(200, { empty: this.empty, archived: this.archived, mirror: this.mirror, permissions: { admin: false, push: this.push, pull: true } });
		}
		if (head === 'branches' && rec.method === 'GET') {
			const name = rest.slice(1).join('/');
			const id = this.branches.get(name);
			return id === undefined ? json(404, { message: 'branch does not exist' }) : json(200, { name, commit: { id }, user_can_push: this.userCanPush });
		}
		if (head === 'tags') {
			const name = rest.slice(1).join('/');
			const id = this.tags.get(name);
			return id === undefined ? json(404, { message: 'tag does not exist' }) : json(200, { name, id: sha1(`tag ${name}`), commit: { sha: id } });
		}
		if (head === 'git' && rest[1] === 'commits') {
			const full = [...this.commits.keys()].find((id) => id.startsWith(rest[2]));
			const commit = full === undefined ? undefined : this.commits.get(full);
			return commit === undefined || full === undefined ? json(404, { message: 'commit does not exist' }) : json(200, { sha: full, commit: { tree: { sha: commit.tree } } });
		}
		if (head === 'git' && rest[1] === 'trees') {
			const rows = this.trees.get(rest[2]);
			if (rows === undefined) {
				return json(400, { message: `sha not found [${rest[2]}]` });
			}
			const perPage = Math.min(Number(rec.url.searchParams.get('per_page')) || this.treePageCap, this.treePageCap);
			const page = Number(rec.url.searchParams.get('page')) || 1;
			const slice = rows.slice(perPage * (page - 1), perPage * page);
			return json(200, { sha: rest[2], tree: slice.length === 0 ? null : slice, truncated: perPage * page < rows.length, page, total_count: rows.length });
		}
		if (head === 'git' && rest[1] === 'blobs') {
			const data = this.blobs.get(rest[2]);
			if (data === undefined) {
				return json(400, { message: 'blob not found' });
			}
			const big = data.length > this.maxBlob;
			return json(200, { sha: rest[2], size: data.length, encoding: big ? null : 'base64', content: big ? null : b64(data) });
		}
		if (head === 'raw' && rec.method === 'GET') {
			const ref = rec.url.searchParams.get('ref') as string;
			const files = this.commits.get(ref)?.files;
			const spec = files?.get(rest.slice(1).join('/'));
			return spec === undefined ? json(404, { message: 'not found' }) : new Response(new Uint8Array(bytes(spec)), { status: 200 });
		}
		if (head === 'media' && rec.method === 'GET') {
			const ref = rec.url.searchParams.get('ref') as string;
			const spec = this.commits.get(ref)?.files.get(rest.slice(1).join('/'));
			if (spec === undefined || typeof spec === 'object' && !(spec instanceof Uint8Array)) {
				return json(404, { message: 'not found' });
			}
			// Gitea answers with the stored blob when it holds no LFS object for the pointer.
			const pointer = bytes(spec);
			const oid = /oid sha256:([0-9a-f]{64})/.exec(text(pointer))?.[1];
			return new Response(new Uint8Array(this.lfsObjects.get(oid ?? '') ?? pointer), { status: 200 });
		}
		if (head === 'contents' && rec.method === 'POST') {
			return this.contents(rec.body as ContentsBody);
		}
		return json(404, { message: `unrouted ${rec.method} ${rec.rawPath}` });
	}

	contents(body: ContentsBody): Response {
		if (!this.push || this.archived) {
			return this.archived ? json(423, { message: 'repo archived' }) : json(403, { message: 'user should have a permission to write to this branch' });
		}
		const id = this.branches.get(body.branch);
		if (id === undefined) {
			return json(404, { message: 'branch does not exist' });
		}
		if (body.new_branch !== undefined && body.new_branch !== body.branch) {
			if (this.branches.has(body.new_branch)) {
				return json(422, { message: `branch already exists [name: ${body.new_branch}]` });
			}
		} else if (!this.userCanPush) {
			return json(403, { message: 'user cannot commit to repo' });
		}
		const files = new Map(this.headFiles(body.branch));
		for (const file of body.files) {
			const from = file.from_path || file.path;
			if (file.operation === 'update' || file.operation === 'delete') {
				const current = files.get(from);
				if (current === undefined) {
					return json(500, { message: 'tree entry missing' });
				}
				if (file.sha === undefined || file.sha === '') {
					return json(500, { message: 'a SHA or commit ID must be proved when updating a file' });
				}
				if (file.sha !== this.blobSha(current as string)) {
					return json(422, { message: `sha does not match [given: ${file.sha}, expected: ${this.blobSha(current as string)}]` });
				}
			}
			if ((file.operation === 'create' || from !== file.path) && files.has(file.path)) {
				return json(422, { message: `repository file already exists [path: ${file.path}]` });
			}
			if (file.operation === 'delete') {
				files.delete(file.path);
				continue;
			}
			if (from !== file.path) {
				files.delete(from);
			}
			files.set(file.path, new Uint8Array(Buffer.from(file.content ?? '', 'base64')));
		}
		const commit = this.commitFiles(files, id);
		this.branches.set(body.new_branch ?? body.branch, commit);
		return json(201, { files: [], commit: { sha: commit } });
	}
}

interface ContentsBody {
	branch: string;
	new_branch?: string;
	message: string;
	files: Array<{ operation: string; path: string; content?: string; sha?: string; from_path?: string }>;
}

const FAST = { retryBaseDelayMs: 0, retryMaxDelayMs: 0 };

function make(fake: FakeGitea, overrides: Partial<HttpGiteaRepositoryOptions> = {}): HttpGiteaRepository {
	return new HttpGiteaRepository({
		instance: fake.instance,
		owner: fake.owner,
		repository: fake.repo,
		ref: 'main',
		fetch: fake.fetch,
		...overrides,
		limits: { ...FAST, ...overrides.limits },
	});
}

async function ready(fake: FakeGitea, overrides: Partial<HttpGiteaRepositoryOptions> = {}) {
	const repository = make(fake, overrides);
	const state = await repository.initialize();
	return { repository, state };
}

async function rejectsCode(promise: Promise<unknown>, code: RepositoryErrorCode) {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
		assert.equal(error.code, code, error.message);
		return true;
	});
}

async function until(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.ok(condition(), 'condition not reached');
}

const text = (data: Uint8Array | string) => (typeof data === 'string' ? data : new TextDecoder().decode(data));

function sample() {
	const fake = new FakeGitea();
	const binary = new Uint8Array(256).map((_, i) => i);
	const commit = fake.seed({
		'README.md': 'hello\n',
		'empty.txt': '',
		'bin/all-bytes.dat': binary,
		'src/main.ts': 'export {};\n',
		'src/deep/nested/file.txt': 'nested',
		'link': { symlink: 'README.md' },
		'vendor/lib': { submodule: sha1('submodule') },
		'big.lfs': 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12345\n',
	});
	return { fake, commit, binary };
}

describe('constructor validation', () => {
	const base = { instance: 'https://git.example.com', owner: 'alice', repository: 'demo', ref: 'main', fetch: (async () => json(200, {})) as typeof fetch };
	for (const [name, override] of Object.entries({
		'credentials in instance': { instance: 'https://user:pw@git.example.com' },
		'query in instance': { instance: 'https://git.example.com?token=x' },
		'fragment in instance': { instance: 'https://git.example.com#x' },
		'relative instance': { instance: '/gitea' },
		'non-http instance': { instance: 'ftp://git.example.com' },
		'plain http on a remote host': { instance: 'http://git.example.com' },
		'plain http on a lookalike of localhost': { instance: 'http://localhost.example.com' },
		'plain http on a lookalike of a loopback address': { instance: 'http://127.0.0.1.example.com' },
		'owner with slash': { owner: 'a/b' },
		'owner traversal': { owner: '..' },
		'empty repository': { repository: '' },
		'repository with percent': { repository: 'a%2Fb' },
		'ref with ..': { ref: 'a..b' },
		'ref with space': { ref: 'a b' },
		'ref with control': { ref: 'a\u0000b' },
		'ref ending slash': { ref: 'a/' },
		'empty ref': { ref: '' },
		'zero maxFileSize': { maxFileSize: 0 },
		'fractional maxFileSize': { maxFileSize: 1.5 },
	})) {
		it(`rejects ${name}`, () => {
			assert.throws(() => new HttpGiteaRepository({ ...base, ...override }), (error: unknown) => error instanceof RepositoryError && error.code === 'invalid-argument');
		});
	}

	it('F12: accepts plain http on loopback hosts only', () => {
		for (const instance of ['http://localhost:3000', 'http://127.0.0.1:3000/sub', 'http://127.1.2.3', 'http://[::1]:3000']) {
			assert.doesNotThrow(() => new HttpGiteaRepository({ ...base, instance }), instance);
		}
	});

	it('accepts Unicode refs and sub-path instances with a trailing slash', () => {
		assert.doesNotThrow(() => new HttpGiteaRepository({ ...base, instance: 'https://git.example.com/sub/', ref: 'feature/\u00fcn\u00ef-\u6587' }));
	});
});

describe('initialize', () => {
	it('pins a branch to its head commit and reports write permission', async () => {
		const { fake, commit } = sample();
		const { state } = await ready(fake);
		assert.deepEqual(state, { commit, branch: 'main', canWrite: true, canBranch: true });
	});

	it('uses the sub-path and encodes owner, repository and branch independently', async () => {
		const fake = new FakeGitea('org-1', 'my.repo');
		fake.seed({ a: 'x' }, 'feature/\u00fcn\u00ef-\u6587');
		const { state } = await ready(fake, { ref: 'feature/\u00fcn\u00ef-\u6587' });
		assert.equal(state.branch, 'feature/\u00fcn\u00ef-\u6587');
		const branchRequest = fake.requests.find((rec) => rec.rawPath.includes('/branches/'));
		assert.equal(branchRequest?.rawPath, '/sub/gitea/api/v1/repos/org-1/my.repo/branches/feature/%C3%BCn%C3%AF-%E6%96%87');
	});

	it('keeps a literal %2F in a ref distinct from a slash', async () => {
		const fake = new FakeGitea();
		fake.seed({ a: 'x' }, 'a%2Fb');
		const { state } = await ready(fake, { ref: 'a%2Fb' });
		assert.equal(state.branch, 'a%2Fb');
		assert.ok(fake.requests.some((rec) => rec.rawPath.endsWith('/branches/a%252Fb')));
	});

	it('resolves tags to read-only states, including annotated tag targets', async () => {
		const { fake, commit } = sample();
		fake.tags.set('v1', commit);
		const { state } = await ready(fake, { ref: 'v1' });
		assert.deepEqual(state, { commit, branch: null, canWrite: false, canBranch: false });
	});

	it('resolves full and abbreviated commit ids as read-only', async () => {
		const { fake, commit } = sample();
		for (const ref of [commit, commit.slice(0, 10)]) {
			const { state } = await ready(fake, { ref });
			assert.deepEqual(state, { commit, branch: null, canWrite: false, canBranch: false });
		}
	});

	it('honors refs/heads/ and refs/tags/ prefixes to disambiguate', async () => {
		const { fake, commit } = sample();
		fake.tags.set('main', commit);
		const older = fake.advance((files) => files.set('new', 'x'));
		assert.equal((await ready(fake, { ref: 'refs/tags/main' })).state.commit, commit);
		assert.equal((await ready(fake, { ref: 'refs/heads/main' })).state.commit, older);
		assert.equal((await ready(fake, { ref: 'main' })).state.commit, older, 'branch wins like Gitea');
		await rejectsCode(ready(fake, { ref: 'refs/heads/v-none' }).then(() => undefined), 'not-found');
	});

	it('reports not-found for unknown refs, repositories and 401 as unauthenticated', async () => {
		const { fake } = sample();
		await rejectsCode(make(fake, { ref: 'nope' }).initialize(), 'not-found');
		await rejectsCode(make(fake, { repository: 'missing' }).initialize(), 'not-found');
		fake.interceptors.push(() => json(401, { message: 'token is required' }));
		await rejectsCode(make(fake).initialize(), 'unauthenticated');
	});

	it('rejects empty repositories', async () => {
		const { fake } = sample();
		fake.empty = true;
		await rejectsCode(make(fake).initialize(), 'empty-repository');
	});

	const readOnlyCases: Record<string, (fake: FakeGitea) => void> = {
		archived: (fake) => {
			fake.archived = true;
		},
		mirror: (fake) => {
			fake.mirror = true;
		},
		'no push permission': (fake) => {
			fake.push = false;
		},
		'protected branch': (fake) => {
			fake.userCanPush = false;
		},
	};
	for (const [name, mutate] of Object.entries(readOnlyCases)) {
		it(`canWrite is false for ${name}`, async () => {
			const { fake } = sample();
			mutate(fake);
			assert.equal((await ready(fake)).state.canWrite, false);
		});
	}

	it('requires initialize before use', async () => {
		const { fake } = sample();
		const repository = make(fake);
		await rejectsCode(repository.getEntry('README.md'), 'not-initialized');
		await rejectsCode(repository.commit({ message: 'm', baseCommit: 'a'.repeat(40), changes: [] }), 'not-initialized');
	});
});

describe('reads', () => {
	it('maps entry types, names, shas and sizes', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const entries = await repository.readDirectory('');
		const byName = new Map(entries.map((entry) => [entry.name, entry]));
		assert.equal(byName.get('README.md')?.type, 'file');
		assert.equal(byName.get('README.md')?.size, 6);
		assert.equal(byName.get('README.md')?.sha, fake.blobSha('hello\n'));
		assert.equal(byName.get('src')?.type, 'directory');
		assert.equal(byName.get('src')?.size, 0);
		assert.equal(byName.get('link')?.type, 'symlink');
		assert.equal(byName.get('vendor')?.type, 'directory');
		assert.deepEqual(await repository.getEntry('vendor/lib'), { path: 'vendor/lib', name: 'lib', type: 'submodule', sha: sha1('submodule'), size: 0 });
		assert.deepEqual(entries.find((entry) => entry.name === 'empty.txt'), { path: 'empty.txt', name: 'empty.txt', type: 'file', sha: fake.blobSha(''), size: 0 });
	});

	it('returns the root, nested directories and nested files', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const root = await repository.getEntry('');
		assert.deepEqual([root.path, root.name, root.type], ['', '', 'directory']);
		assert.deepEqual((await repository.getEntry('/')).path, '');
		const nested = await repository.readDirectory('src/deep');
		assert.deepEqual(nested.map((entry) => entry.path), ['src/deep/nested']);
		assert.equal(text((await repository.readFile('src/deep/nested/file.txt')).content), 'nested');
		assert.equal((await repository.getEntry('/src/main.ts')).path, 'src/main.ts');
	});

	it('round-trips binary and empty content', async () => {
		const { fake, binary } = sample();
		const { repository } = await ready(fake);
		const file = await repository.readFile('bin/all-bytes.dat');
		assert.deepEqual([...file.content], [...binary]);
		assert.equal(file.lfs, undefined);
		assert.equal((await repository.readFile('empty.txt')).content.length, 0);
	});

	it('reads a symlink as its target path text, without following it', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const link = await repository.readFile('link');
		assert.equal(link.entry.type, 'symlink');
		assert.equal(text(link.content), 'README.md');
		assert.equal(link.lfs, undefined);
		assert.equal(fake.count('/raw/'), 0);
		assert.equal(fake.count('/media/'), 0);
	});

	it('names the target commit when a submodule is read', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		await assert.rejects(repository.readFile('vendor/lib'), (error: unknown) => {
			assert.ok(error instanceof RepositoryError);
			assert.equal(error.code, 'unsupported');
			assert.match(error.message, new RegExp(sha1('submodule')));
			return true;
		});
		assert.equal(fake.count('/git/blobs/'), 0);
	});

	describe('Git LFS files', () => {
		const object = new TextEncoder().encode('large file body\n'.repeat(20));
		const oid = createHash('sha256').update(object).digest('hex');
		const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${object.length}\n`;

		function lfs(hold = true) {
			const fake = new FakeGitea();
			if (hold) fake.lfsObjects.set(oid, object);
			const commit = fake.seed({ 'data.bin': pointer, 'plain.txt': 'x\n' });
			return { fake, commit };
		}

		it('reads the LFS object named by the pointer, not the pointer', async () => {
			const { fake, commit } = lfs();
			const { repository } = await ready(fake);
			const file = await repository.readFile('data.bin');
			assert.deepEqual([...file.content], [...object]);
			assert.deepEqual(file.lfs, { oid, size: object.length, resolved: true });
			assert.equal(file.entry.sha, fake.blobSha(pointer));
			const media = fake.requests.filter((rec) => rec.rawPath.includes('/media/'));
			assert.equal(media.length, 1);
			assert.equal(media[0].rawPath.endsWith('/media/data.bin'), true);
			assert.equal(media[0].url.searchParams.get('ref'), commit);
			assert.equal((await repository.readFile('plain.txt')).lfs, undefined);
			assert.equal(fake.count('/media/'), 1);
		});

		it('returns a copy and fetches the object once', async () => {
			const { fake } = lfs();
			const { repository } = await ready(fake);
			(await repository.readFile('data.bin')).content.fill(0);
			assert.deepEqual([...(await repository.readFile('data.bin')).content], [...object]);
			assert.equal(fake.count('/media/'), 1);
		});

		it('returns the pointer as stored, without a media request, when asked', async () => {
			const { fake } = lfs();
			const { repository } = await ready(fake);
			const file = await repository.readFile('data.bin', { lfs: 'pointer' });
			assert.equal(text(file.content), pointer);
			assert.deepEqual(file.lfs, { oid, size: object.length, resolved: false });
			assert.equal(fake.count('/media/'), 0);
		});

		it('keeps the pointer, marked unresolved, when the server holds no object', async () => {
			const { fake } = lfs(false);
			const { repository } = await ready(fake);
			const file = await repository.readFile('data.bin');
			assert.equal(text(file.content), pointer);
			assert.deepEqual(file.lfs, { oid, size: object.length, resolved: false });
		});

		it('rejects an object that does not hash to the pointer oid', async () => {
			const { fake } = lfs();
			fake.lfsObjects.set(oid, new Uint8Array(object.length).fill(65));
			const { repository } = await ready(fake);
			await rejectsCode(repository.readFile('data.bin'), 'protocol');
		});

		it('refuses an object over maxFileSize without downloading it', async () => {
			const { fake } = lfs();
			const { repository } = await ready(fake, { maxFileSize: 200 });
			await rejectsCode(repository.readFile('data.bin'), 'file-too-large');
			assert.equal(fake.count('/media/'), 0);
			assert.equal(text((await repository.readFile('data.bin', { lfs: 'pointer' })).content), pointer);
		});
	});

	it('maps domain errors for bad targets', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		await rejectsCode(repository.getEntry('missing.txt'), 'not-found');
		await rejectsCode(repository.getEntry('README.md/child'), 'not-a-directory');
		await rejectsCode(repository.readDirectory('README.md'), 'not-a-directory');
		await rejectsCode(repository.readFile('src'), 'is-a-directory');
		await rejectsCode(repository.readFile('vendor/lib'), 'unsupported');
	});

	it('rejects bad paths before sending any request', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const before = fake.requests.length;
		for (const path of ['a//b', './a', '../a', 'a/../b', 'a/./b', 'src/', '.git/config', 'a/.GIT/b', 'a\u0000b', 'a\nb', 'a/\ud800', 'x'.repeat(5000)]) {
			await rejectsCode(repository.getEntry(path), 'invalid-path');
			await rejectsCode(repository.readFile(path), 'invalid-path');
		}
		assert.equal(fake.requests.length, before);
	});

	it('refuses files over maxFileSize without fetching their blob', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake, { maxFileSize: 100 });
		fake.seed({ 'huge.bin': new Uint8Array(101) });
		await repository.refresh();
		await assert.rejects(repository.readFile('huge.bin'), (error: unknown) => error instanceof FileTooLargeError && error.size === 101 && error.limit === 100);
		assert.equal(fake.count('/git/blobs/'), 0);
	});

	it('falls back to the raw endpoint for blobs above the server API limit and verifies the hash', async () => {
		const { fake } = sample();
		fake.maxBlob = 10;
		const data = new Uint8Array(64).map((_, i) => (i * 7) & 0xff);
		fake.seed({ 'dir/sp ace/\u6587\u4ef6 #1?%2F.bin': data });
		const { repository, state } = await ready(fake);
		const file = await repository.readFile('dir/sp ace/\u6587\u4ef6 #1?%2F.bin');
		assert.deepEqual([...file.content], [...data]);
		const raw = fake.requests.find((rec) => rec.rawPath.includes('/raw/'));
		assert.equal(raw?.rawPath, '/sub/gitea/api/v1/repos/alice/demo/raw/dir/sp%20ace/%E6%96%87%E4%BB%B6%20%231%3F%252F.bin');
		assert.equal(raw?.url.searchParams.get('ref'), state.commit, 'raw reads are addressed by the pinned commit');

		fake.interceptors.push((rec) => (rec.rawPath.includes('/raw/') ? new Response(new Uint8Array(64), { status: 200 }) : undefined));
		const fresh = make(fake);
		await fresh.initialize();
		await rejectsCode(fresh.readFile('dir/sp ace/\u6587\u4ef6 #1?%2F.bin'), 'protocol');
	});

	it('enforces response size caps from content-length and while streaming', async () => {
		const { fake } = sample();
		fake.maxBlob = 1;
		fake.seed({ 'a.bin': new Uint8Array(50) });
		const { repository } = await ready(fake, { maxFileSize: 60 });
		fake.interceptors.push((rec) => (rec.rawPath.includes('/raw/') ? new Response(new Uint8Array(80), { status: 200 }) : undefined));
		await rejectsCode(repository.readFile('a.bin'), 'file-too-large');
	});

	it('paginates large directories and enforces the entry cap', async () => {
		const fake = new FakeGitea();
		const files: Record<string, string> = {};
		for (let i = 0; i < 2500; i++) {
			files[`f${String(i).padStart(4, '0')}`] = String(i);
		}
		fake.seed(files);
		const { repository } = await ready(fake);
		const entries = await repository.readDirectory('');
		assert.equal(entries.length, 2500);
		assert.equal(new Set(entries.map((entry) => entry.name)).size, 2500);
		assert.equal(fake.count('/git/trees/'), 3 + 0);
		const capped = make(fake, { limits: { maxDirectoryEntries: 100 } });
		await capped.initialize();
		await rejectsCode(capped.readDirectory(''), 'file-too-large');
	});

	it('reads the pinned commit until refreshed, then the new head', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const moved = fake.advance((files) => files.set('README.md', 'changed\n'));
		assert.equal(text((await repository.readFile('README.md')).content), 'hello\n');
		await repository.refresh();
		assert.equal(text((await repository.readFile('README.md')).content), 'changed\n');
		await repository.refresh(commit);
		assert.equal(text((await repository.readFile('README.md')).content), 'hello\n');
		await repository.refresh(moved);
		assert.equal(text((await repository.readFile('README.md')).content), 'changed\n');
		await rejectsCode(repository.refresh(sha1('unknown commit')), 'not-found');
		await rejectsCode(repository.refresh('abc'), 'invalid-argument');
	});

	it('reads files by blob id so a branch named like a commit cannot shadow the pinned state', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const other = fake.seed({ 'README.md': 'shadow\n' }, commit);
		assert.notEqual(other, commit);
		assert.equal(text((await repository.readFile('README.md')).content), 'hello\n');
	});
});

describe('cache and in-flight sharing', () => {
	it('serves repeated reads from the immutable cache', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		await repository.readFile('src/main.ts');
		const before = fake.requests.length;
		await repository.readFile('src/main.ts');
		assert.equal(fake.requests.length, before, 'a repeated read needs no request');
		await repository.getEntry('src/deep/nested/file.txt');
		await repository.readFile('src/deep/nested/file.txt');
		assert.equal(fake.requests.length - before, 3, 'only the uncached deep and nested trees and the blob are fetched');
	});

	it('keeps tree and blob caches across refresh because they are content addressed', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		await repository.readFile('src/main.ts');
		fake.advance((files) => files.set('other.txt', 'x'));
		const blobs = fake.count('/git/blobs/');
		await repository.refresh();
		await repository.readFile('src/main.ts');
		assert.equal(fake.count('/git/blobs/'), blobs);
	});

	it('bounds the cache by bytes', async () => {
		const fake = new FakeGitea();
		fake.seed({ a: 'x'.repeat(100), b: 'y'.repeat(100) });
		const { repository } = await ready(fake, { limits: { cacheBytes: 250 } });
		await repository.readFile('a');
		await repository.readFile('b');
		await repository.readFile('a');
		assert.equal(fake.count('/git/blobs/'), 3, 'a was evicted by b');
		const huge = make(fake, { limits: { cacheBytes: 10 } });
		await huge.initialize();
		await huge.readFile('a');
		await huge.readFile('a');
		assert.equal(fake.count('/git/blobs/'), 5, 'entries over the budget are never cached');
	});

	it('F3: trees and blobs share one byte budget', async () => {
		const fake = new FakeGitea();
		const files: Record<string, string> = { a: 'x'.repeat(1000), b: 'y'.repeat(1000) };
		for (let i = 0; i < 40; i++) {
			files[`f${String(i).padStart(2, '0')}`] = String(i);
		}
		fake.seed(files);
		// Each part fits in 3000 bytes alone (root tree about 2600, both blobs about 2100); together they cannot.
		const { repository } = await ready(fake, { limits: { cacheBytes: 3000 } });
		const readAll = async () => {
			await repository.readDirectory('');
			await repository.readFile('a');
			await repository.readFile('b');
		};
		await readAll();
		const before = fake.requests.length;
		await readAll();
		assert.ok(fake.requests.length > before, 'the cache held more than its budget');
	});

	it('hands out copies so callers cannot corrupt the cache', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const first = await repository.readFile('README.md');
		first.content.fill(0);
		first.entry.name = 'mutated';
		const second = await repository.readFile('README.md');
		assert.equal(text(second.content), 'hello\n');
		assert.equal(second.entry.name, 'README.md');
		const dir = await repository.readDirectory('');
		dir[0].name = 'mutated';
		assert.notEqual((await repository.readDirectory(''))[0].name, 'mutated');
	});

	it('shares one request between concurrent readers', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const results = await Promise.all(Array.from({ length: 5 }, () => repository.readFile('README.md')));
		assert.ok(results.every((file) => text(file.content) === 'hello\n'));
		assert.equal(fake.count('/git/blobs/'), 1);
	});
});

describe('retry, timeout and cancellation', () => {
	it('retries safe reads on 503 and network errors, bounded by maxRetries', async () => {
		const { fake } = sample();
		const script: Array<() => Response> = [
			() => json(503, { message: 'busy' }, { 'retry-after': '0' }),
			() => {
				throw new TypeError('fetch failed');
			},
		];
		fake.interceptors.push((rec) => (rec.rawPath.endsWith('/demo') ? script.shift()?.() : undefined));
		const repository = make(fake);
		assert.equal((await repository.initialize()).branch, 'main');

		const always = new FakeGitea();
		always.seed({ a: 'x' });
		always.interceptors.push(() => json(503, { message: 'down' }));
		await rejectsCode(make(always, { limits: { maxRetries: 2 } }).initialize(), 'unavailable');
		assert.equal(always.requests.length, 3);
	});

	it('does not retry 404, 403 or 500 reads', async () => {
		for (const status of [403, 404, 500]) {
			const fake = new FakeGitea();
			fake.seed({ a: 'x' });
			fake.interceptors.push(() => json(status, { message: 'no' }));
			await assert.rejects(make(fake).initialize(), RepositoryError);
			assert.equal(fake.requests.length, 1, `status ${status}`);
		}
	});

	it('F11: fails with rate-limited and the delay when Retry-After is over the delay cap', async () => {
		const fake = new FakeGitea();
		fake.seed({ a: 'x' });
		fake.interceptors.push((rec) => (rec.rawPath.endsWith('/demo') ? json(429, { message: 'slow down' }, { 'retry-after': '3600' }) : undefined));
		const error = await make(fake, { limits: { retryMaxDelayMs: 5 } }).initialize().catch((caught: unknown) => caught);
		assert.ok(error instanceof RepositoryError && error.code === 'rate-limited', String(error));
		assert.equal(error.retryAfterMs, 3_600_000);
		assert.equal(fake.count('/demo'), 1, 'no early retry');
	});

	it('honors a Retry-After within the delay cap', async () => {
		const fake = new FakeGitea();
		fake.seed({ a: 'x' });
		let first = true;
		fake.interceptors.push((rec) => {
			if (first && rec.rawPath.endsWith('/demo')) {
				first = false;
				return json(429, { message: 'slow down' }, { 'retry-after': '0' });
			}
			return undefined;
		});
		assert.equal((await make(fake, { limits: { retryMaxDelayMs: 5 } }).initialize()).branch, 'main');
	});

	it('never retries commits', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		fake.interceptors.push((rec) => (rec.method === 'POST' ? json(503, { message: 'busy' }) : undefined));
		await assert.rejects(
			repository.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: new Uint8Array([1]) }] }),
			CommitOutcomeUnknownError,
		);
		assert.equal(fake.posts().length, 1);
	});

	it('times out hung requests', async () => {
		const fake = new FakeGitea();
		fake.seed({ a: 'x' });
		fake.interceptors.push((rec) => new Promise<Response>((_, reject) => rec.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
		await rejectsCode(make(fake, { limits: { timeoutMs: 20, maxRetries: 0 } }).initialize(), 'network');
	});

	it('aborts before sending when the signal is already aborted', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		const before = fake.requests.length;
		await rejectsCode(repository.readFile('README.md', { signal: AbortSignal.abort() }), 'aborted');
		assert.equal(fake.requests.length, before);
	});

	it('aborts an in-flight request and cancels the underlying fetch when every waiter leaves', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		let underlying: AbortSignal | null | undefined;
		fake.interceptors.push((rec) => {
			if (rec.rawPath.includes('/git/blobs/')) {
				underlying = rec.signal;
				return new Promise<Response>((_, reject) => rec.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
			}
			return undefined;
		});
		const a = new AbortController();
		const b = new AbortController();
		const first = repository.readFile('README.md', { signal: a.signal });
		const second = repository.readFile('README.md', { signal: b.signal });
		await until(() => underlying !== undefined);
		a.abort();
		await rejectsCode(first, 'aborted');
		assert.equal(underlying?.aborted, false, 'a remaining waiter keeps the fetch alive');
		b.abort();
		await rejectsCode(second, 'aborted');
		assert.equal(underlying?.aborted, true);
		fake.interceptors.length = 0;
		assert.equal(text((await repository.readFile('README.md')).content), 'hello\n', 'a later read starts a fresh request');
	});

	it('lets a surviving waiter finish when another aborts', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake);
		let release: (() => void) | undefined;
		fake.interceptors.push((rec) => {
			if (rec.rawPath.includes('/git/blobs/') && release === undefined) {
				return new Promise<Response>((resolve) => {
					release = () => resolve(fake.route(rec));
				});
			}
			return undefined;
		});
		const a = new AbortController();
		const first = repository.readFile('README.md', { signal: a.signal });
		const second = repository.readFile('README.md');
		await until(() => release !== undefined);
		a.abort();
		await rejectsCode(first, 'aborted');
		release?.();
		assert.equal(text((await second).content), 'hello\n');
	});
});

describe('commit', () => {
	const bin = new Uint8Array([0, 255, 128, 10, 13, 0, 1]);

	it('sends one atomic POST with every operation and the stock guard fields only', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake, { auth: new PersonalAccessTokenAuth('tok_0123456789abcdef') });
		const readme = fake.blobSha('hello\n');
		const main = fake.blobSha('export {};\n');
		const changes: RepositoryChange[] = [
			{ type: 'create', path: 'new/\u6587\u4ef6 1.bin', content: bin },
			{ type: 'update', path: 'README.md', content: new TextEncoder().encode('edited\n'), originalSha: readme },
			{ type: 'delete', path: 'src/deep/nested/file.txt', originalSha: fake.blobSha('nested') },
			{ type: 'update', path: 'src/renamed.ts', previousPath: 'src/main.ts', originalSha: main },
		];
		const result = await repository.commit({ message: '  Edit things\n', baseCommit: commit, changes });
		assert.equal(fake.posts().length, 1);
		const post = fake.posts()[0];
		assert.equal(post.rawPath, '/sub/gitea/api/v1/repos/alice/demo/contents');
		assert.equal(post.headers.get('authorization'), 'token tok_0123456789abcdef');
		assert.deepEqual(post.body, {
			branch: 'main',
			message: 'Edit things\n'.trim(),
			files: [
				{ operation: 'create', path: 'new/\u6587\u4ef6 1.bin', content: b64(bin) },
				{ operation: 'update', path: 'README.md', content: b64(new TextEncoder().encode('edited\n')), sha: readme },
				{ operation: 'delete', path: 'src/deep/nested/file.txt', sha: fake.blobSha('nested') },
				{ operation: 'update', path: 'src/renamed.ts', content: b64(new TextEncoder().encode('export {};\n')), sha: main, from_path: 'src/main.ts' },
			],
		});
		const forbidden = ['last_commit_id', 'new_branch', 'force', 'author', 'committer', 'dates', 'signoff'];
		for (const key of forbidden) {
			assert.ok(!(key in (post.body as object)), `${key} must not be sent`);
		}
		assert.equal(fake.branches.get('main'), result.sha);
		const files = fake.headFiles();
		assert.deepEqual([...(files.get('new/\u6587\u4ef6 1.bin') as Uint8Array)], [...bin]);
		assert.equal(text(files.get('README.md') as Uint8Array), 'edited\n');
		assert.ok(!files.has('src/deep/nested/file.txt') && !files.has('src/main.ts'));
		assert.equal(text(files.get('src/renamed.ts') as Uint8Array), 'export {};\n');
		assert.equal(fake.commits.get(result.sha)?.parent, commit, 'exactly one new commit on top of the base');
	});

	it('detects a moved branch head before posting', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const moved = fake.advance((files) => files.set('unrelated.txt', 'x'));
		await assert.rejects(
			repository.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: new Uint8Array() }] }),
			(error: unknown) => error instanceof StaleHeadError && error.baseCommit === commit && error.headCommit === moved,
		);
		assert.equal(fake.posts().length, 0);
	});

	it('maps a file changed between preflight and POST to StaleBlobError naming the path', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const readme = fake.blobSha('hello\n');
		fake.interceptors.push((rec) => {
			if (rec.method === 'POST') {
				fake.advance((files) => files.set('README.md', 'someone else\n'));
			}
			return undefined;
		});
		await assert.rejects(
			repository.commit({
				message: 'm',
				baseCommit: commit,
				changes: [
					{ type: 'update', path: 'README.md', content: new Uint8Array([1]), originalSha: readme },
					{ type: 'delete', path: 'empty.txt', originalSha: fake.blobSha('') },
				],
			}),
			(error: unknown) => error instanceof StaleBlobError && error.status === 422 && error.paths.length === 1 && error.paths[0] === 'README.md',
		);
		assert.equal(text(fake.headFiles().get('README.md') as Uint8Array), 'someone else\n', 'remote content untouched');
		assert.ok(fake.headFiles().has('empty.txt'));
	});

	it('LIMITATION: an unrelated commit racing the preflight is merged in, because stock POST /contents has no head guard', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		fake.interceptors.push((rec) => {
			if (rec.method === 'POST') {
				fake.advance((files) => files.set('unrelated.txt', 'theirs'));
			}
			return undefined;
		});
		const result = await repository.commit({
			message: 'm',
			baseCommit: commit,
			changes: [{ type: 'update', path: 'README.md', content: new Uint8Array([1]), originalSha: fake.blobSha('hello\n') }],
		});
		const files = fake.headFiles();
		assert.equal(fake.branches.get('main'), result.sha);
		assert.ok(files.has('unrelated.txt'), 'their file survives');
		assert.deepEqual([...(files.get('README.md') as Uint8Array)], [1]);
	});

	it('maps an existing create target to AlreadyExistsError with the path', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		await assert.rejects(
			repository.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'README.md', content: new Uint8Array() }] }),
			(error: unknown) => error instanceof AlreadyExistsError && error.path === 'README.md',
		);
		const clash = await repository
			.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'update', path: 'empty.txt', previousPath: 'README.md', originalSha: fake.blobSha('hello\n') }] })
			.catch((error: unknown) => error);
		assert.ok(clash instanceof AlreadyExistsError && clash.path === 'empty.txt');
	});

	it('maps permission, archive and rejection statuses', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const create = { message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: new Uint8Array() } as RepositoryChange] };
		const status = async (code: number, expected: RepositoryErrorCode) => {
			fake.interceptors.length = 0;
			fake.interceptors.push((rec) => (rec.method === 'POST' ? json(code, { message: 'user cannot commit to repo [user: bob]' }) : undefined));
			await rejectsCode(repository.commit(create), expected);
		};
		await status(403, 'forbidden');
		await status(423, 'archived');
		await status(422, 'invalid-change');
		await status(404, 'not-found');
		await status(401, 'unauthenticated');
	});

	it('reports an unknown outcome for 5xx, network failures, aborts and malformed success bodies', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const create = { message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: new Uint8Array() } as RepositoryChange] };
		const cases: Array<() => Response | Promise<Response>> = [
			() => json(500, { message: 'push out of date' }),
			() => {
				throw new TypeError('fetch failed');
			},
			() => json(201, { files: [] }),
			() => json(201, { commit: { sha: 'zzz' } }),
		];
		for (const respond of cases) {
			fake.interceptors.length = 0;
			fake.interceptors.push((rec) => (rec.method === 'POST' ? respond() : undefined));
			await assert.rejects(repository.commit(create), CommitOutcomeUnknownError);
		}
		fake.interceptors.length = 0;
		const controller = new AbortController();
		fake.interceptors.push((rec) => {
			if (rec.method === 'POST') {
				controller.abort();
				throw new DOMException('aborted', 'AbortError');
			}
			return undefined;
		});
		await assert.rejects(repository.commit(create, { signal: controller.signal }), CommitOutcomeUnknownError);
	});

	it('validates changes before any request', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake, { maxFileSize: 200 });
		const sha = fake.blobSha('hello\n');
		const lfsPointer = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'b'.repeat(64) + '\nsize 5\n');
		const ok: RepositoryChange = { type: 'create', path: 'n.txt', content: new Uint8Array() };
		const before = fake.requests.length;
		const bad: Array<[Partial<{ message: string; baseCommit: string; changes: RepositoryChange[] }>, RepositoryErrorCode]> = [
			[{ message: '  ' }, 'invalid-change'],
			[{ baseCommit: commit.slice(0, 7) }, 'invalid-change'],
			[{ baseCommit: commit.toUpperCase() }, 'invalid-change'],
			[{ changes: [] }, 'invalid-change'],
			[{ changes: [{ type: 'update', path: 'a', content: new Uint8Array() }] }, 'invalid-change'],
			[{ changes: [{ type: 'delete', path: 'a' }] }, 'invalid-change'],
			[{ changes: [{ type: 'update', path: 'a', originalSha: sha }] }, 'invalid-change'],
			[{ changes: [{ type: 'create', path: 'a', content: new Uint8Array(), originalSha: sha }] }, 'invalid-change'],
			[{ changes: [{ type: 'create', path: 'a', content: new Uint8Array(), previousPath: 'b' }] }, 'invalid-change'],
			[{ changes: [{ type: 'delete', path: 'a', originalSha: sha, content: new Uint8Array() }] }, 'invalid-change'],
			[{ changes: [{ type: 'update', path: 'a', previousPath: 'a', originalSha: sha }] }, 'invalid-change'],
			[{ changes: [{ type: 'update', path: 'a', content: new Uint8Array(), originalSha: 'xyz' }] }, 'invalid-change'],
			[{ changes: [ok, ok] }, 'invalid-change'],
			[{ changes: [{ type: 'create', path: 'a', content: new Uint8Array() }, { type: 'update', path: 'b', previousPath: 'a', originalSha: sha }] }, 'invalid-change'],
			[{ changes: [{ type: 'bogus' as 'create', path: 'a', content: new Uint8Array() }] }, 'invalid-change'],
			[{ changes: [{ ...ok, path: '../etc/passwd' }] }, 'invalid-path'],
			[{ changes: [{ ...ok, path: '.git/hooks/x' }] }, 'invalid-path'],
			[{ changes: [{ ...ok, path: '' }] }, 'invalid-path'],
			[{ changes: [{ ...ok, path: 'p'.repeat(501) }] }, 'invalid-path'],
			[{ changes: [{ ...ok, content: new Uint8Array(201) }] }, 'file-too-large'],
			[{ changes: [{ ...ok, content: lfsPointer }] }, 'unsupported'],
		];
		for (const [override, code] of bad) {
			await rejectsCode(repository.commit({ message: 'm', baseCommit: commit, changes: [ok], ...override }), code);
		}
		assert.equal(fake.requests.length, before);
	});

	it('refuses to rename an LFS pointer and enforces maxCommitChanges', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake, { limits: { maxCommitChanges: 2 } });
		await rejectsCode(
			repository.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'update', path: 'moved.lfs', previousPath: 'big.lfs', originalSha: fake.blobSha(text(fake.headFiles().get('big.lfs') as Uint8Array)) }] }),
			'unsupported',
		);
		assert.equal(fake.posts().length, 0);
		const three: RepositoryChange[] = ['a', 'b', 'c'].map((path) => ({ type: 'create', path, content: new Uint8Array() }));
		await rejectsCode(repository.commit({ message: 'm', baseCommit: commit, changes: three }), 'invalid-change');
	});

	it('refuses writes for tags, commits, protected branches and archived repositories', async () => {
		const { fake, commit } = sample();
		fake.tags.set('v1', commit);
		const create = { message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: new Uint8Array() } as RepositoryChange] };
		for (const ref of ['v1', commit]) {
			const { repository } = await ready(fake, { ref });
			await rejectsCode(repository.commit(create), 'read-only');
		}
		fake.userCanPush = false;
		await rejectsCode((await ready(fake)).repository.commit(create), 'read-only');
		fake.userCanPush = true;
		fake.archived = true;
		await rejectsCode((await ready(fake)).repository.commit(create), 'read-only');
		assert.equal(fake.posts().length, 0);
	});

	describe('commit to a new branch', () => {
		const create = (commit: string) => ({ message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: bin } as RepositoryChange] });

		it('sends branch and new_branch, leaves the source branch alone and parents the commit on the base', async () => {
			const { fake, commit } = sample();
			const { repository } = await ready(fake);
			const result = await repository.commit({ ...create(commit), newBranch: 'topic/one' });
			assert.deepEqual(fake.posts().map((post) => (post.body as ContentsBody).branch), ['main']);
			assert.equal((fake.posts()[0].body as ContentsBody).new_branch, 'topic/one');
			assert.equal(fake.branches.get('main'), commit);
			assert.equal(fake.branches.get('topic/one'), result.sha);
			assert.equal(fake.commits.get(result.sha)?.parent, commit);
		});

		it('works on a protected branch, where a direct commit is refused', async () => {
			const { fake, commit } = sample();
			fake.userCanPush = false;
			const { repository, state } = await ready(fake);
			assert.deepEqual([state.canWrite, state.canBranch], [false, true]);
			await rejectsCode(repository.commit(create(commit)), 'read-only');
			assert.equal(fake.posts().length, 0);
			const result = await repository.commit({ ...create(commit), newBranch: 'fix' });
			assert.equal(fake.branches.get('fix'), result.sha);
			assert.equal(fake.branches.get('main'), commit);
		});

		it('reports an existing branch name as branch-exists and changes nothing', async () => {
			const { fake, commit } = sample();
			fake.branches.set('taken', commit);
			const { repository } = await ready(fake);
			await rejectsCode(repository.commit({ ...create(commit), newBranch: 'taken' }), 'branch-exists');
			assert.equal(fake.branches.get('taken'), commit);
		});

		it('rejects the source branch name, refs/ prefixes and invalid names before any request', async () => {
			const { fake, commit } = sample();
			const { repository } = await ready(fake);
			for (const newBranch of ['main', 'refs/heads/x', 'a..b', 'has space']) {
				await rejectsCode(repository.commit({ ...create(commit), newBranch }), 'invalid-argument');
			}
			assert.equal(fake.posts().length, 0);
		});

		for (const [name, mutate] of Object.entries<(fake: FakeGitea) => void>({
			archived: (fake) => { fake.archived = true; },
			mirror: (fake) => { fake.mirror = true; },
			'no push permission': (fake) => { fake.push = false; },
		})) {
			it(`is refused for ${name}: canBranch is false and nothing is posted`, async () => {
				const { fake, commit } = sample();
				mutate(fake);
				const { repository, state } = await ready(fake);
				assert.equal(state.canBranch, false);
				await rejectsCode(repository.commit({ ...create(commit), newBranch: 'x' }), 'read-only');
				assert.equal(fake.posts().length, 0);
			});
		}

		it('is refused from a tag', async () => {
			const { fake, commit } = sample();
			fake.tags.set('v1', commit);
			const { repository, state } = await ready(fake, { ref: 'v1' });
			assert.equal(state.canBranch, false);
			await rejectsCode(repository.commit({ ...create(commit), newBranch: 'x' }), 'read-only');
		});
	});

	it('rechecks push rights at commit time', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		fake.userCanPush = false;
		await rejectsCode(
			repository.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: new Uint8Array() }] }),
			'read-only',
		);
		assert.equal(fake.posts().length, 0);
	});

	it('can pin to the new commit after a successful commit', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake);
		const result = await repository.commit({ message: 'm', baseCommit: commit, changes: [{ type: 'create', path: 'n.txt', content: bin }] });
		await rejectsCode(repository.getEntry('n.txt'), 'not-found');
		await repository.refresh(result.sha);
		assert.deepEqual([...(await repository.readFile('n.txt')).content], [...bin]);
		const second = await repository.commit({ message: 'again', baseCommit: result.sha, changes: [{ type: 'delete', path: 'n.txt', originalSha: fake.blobSha(bin) }] });
		assert.notEqual(second.sha, result.sha);
	});

	it('F4: rejects a commit over maxCommitBytes before any request', async () => {
		const { fake, commit } = sample();
		const { repository } = await ready(fake, { limits: { maxCommitBytes: 2500 } });
		const before = fake.requests.length;
		const chunk = new Uint8Array(1000);
		await rejectsCode(
			repository.commit({ message: 'm', baseCommit: commit, changes: [1, 2, 3].map((n) => ({ type: 'create' as const, path: `n${n}`, content: chunk })) }),
			'invalid-change',
		);
		assert.equal(fake.requests.length, before);
		await repository.commit({ message: 'm', baseCommit: commit, changes: [1, 2].map((n) => ({ type: 'create' as const, path: `n${n}`, content: chunk })) });
		assert.equal(fake.posts().length, 1);
	});

	it('F4: counts rename sources toward maxCommitBytes and sends nothing', async () => {
		const fake = new FakeGitea();
		const files: Record<string, string> = {};
		for (let i = 0; i < 4; i++) {
			files[`old${i}`] = String(i).repeat(1000);
		}
		const commit = fake.seed(files);
		const { repository } = await ready(fake, { limits: { maxCommitBytes: 2500 } });
		const changes: RepositoryChange[] = [0, 1, 2, 3].map((i) => ({ type: 'update', path: `new${i}`, previousPath: `old${i}`, originalSha: fake.blobSha(files[`old${i}`]) }));
		await rejectsCode(repository.commit({ message: 'm', baseCommit: commit, changes }), 'invalid-change');
		assert.equal(fake.posts().length, 0);
	});

	it('F4: defaults maxCommitBytes to 100 MiB', () => {
		assert.equal(DEFAULT_LIMITS.maxCommitBytes, 100 * 1024 * 1024);
	});

	it('F15: downloads rename sources with bounded concurrency', async () => {
		const fake = new FakeGitea();
		const files: Record<string, string> = {};
		for (let i = 0; i < 12; i++) {
			files[`old${i}`] = `content ${i}`;
		}
		const commit = fake.seed(files);
		const { repository } = await ready(fake);
		let active = 0;
		let peak = 0;
		fake.interceptors.push((rec) => {
			if (!rec.rawPath.includes('/git/blobs/')) {
				return undefined;
			}
			active++;
			peak = Math.max(peak, active);
			return new Promise<Response>((resolve) => setTimeout(() => {
				active--;
				resolve(fake.route(rec));
			}, 15));
		});
		const changes: RepositoryChange[] = Array.from({ length: 12 }, (_, i) => ({ type: 'update', path: `new${i}`, previousPath: `old${i}`, originalSha: fake.blobSha(files[`old${i}`]) }));
		await repository.commit({ message: 'm', baseCommit: commit, changes });
		assert.ok(peak > 1, `downloads ran one at a time (peak ${peak})`);
		assert.ok(peak <= 6, `too many parallel downloads (peak ${peak})`);
		const sent = (fake.posts()[0].body as { files: Array<{ path: string; from_path: string }> }).files;
		assert.deepEqual(sent.map((file) => file.path), changes.map((change) => change.path), 'operations keep their order');
	});
});

describe('credentials stay out of requests, errors and logs', () => {
	const SECRET = 'ghp_SUPERSECRETTOKENVALUE123456';

	it('uses headers only, omits cookies and refuses redirects', async () => {
		const { fake } = sample();
		const { repository } = await ready(fake, { auth: new PersonalAccessTokenAuth(SECRET) });
		await repository.readFile('README.md');
		for (const rec of fake.requests) {
			assert.ok(!rec.url.href.includes(SECRET), 'no secret in URL');
			assert.ok(!JSON.stringify(rec.body ?? '').includes(SECRET), 'no secret in body');
			assert.equal(rec.headers.get('authorization'), `token ${SECRET}`);
			assert.equal(rec.init?.credentials, 'omit');
			assert.equal(rec.init?.redirect, 'error');
		}
	});

	it('does not leak secrets through errors', async () => {
		const { fake } = sample();
		const auth = new PersonalAccessTokenAuth(SECRET);
		const errors: unknown[] = [];
		for (const respond of [
			() => json(401, { message: `bad token ${'x'}` }),
			() => json(500, { message: 'boom\u0000\n'.repeat(200) }),
			() => {
				throw new TypeError(`fetch failed for ${SECRET}`);
			},
		]) {
			fake.interceptors.length = 0;
			fake.interceptors.push(respond);
			errors.push(await make(fake, { auth, limits: { maxRetries: 0 } }).initialize().catch((error: unknown) => error));
		}
		for (const error of errors) {
			assert.ok(error instanceof RepositoryError);
			const dump = `${error.message} ${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''} ${(error as { cause?: unknown }).cause ?? ''}`;
			assert.ok(!dump.includes(SECRET));
		}
		assert.ok(errors[1] instanceof RepositoryError && errors[1].message.length < 400, 'server messages are truncated');
		assert.ok(!/[\u0000-\u001f]/.test((errors[1] as RepositoryError).message), 'control characters stripped');
	});

	it('wraps provider failures without their message', async () => {
		const { fake } = sample();
		const auth: AuthProvider = {
			async headers() {
				throw new Error(`keychain locked, token ${SECRET}`);
			},
		};
		const error = await make(fake, { auth }).initialize().catch((caught: unknown) => caught);
		assert.ok(error instanceof RepositoryError && error.code === 'unauthenticated');
		assert.ok(!`${error.message} ${error.stack}`.includes(SECRET));
		assert.equal(fake.requests.length, 0);
	});

	it('rejects provider headers that could alter the request', async () => {
		const { fake } = sample();
		for (const header of ['Cookie', 'Host', 'Content-Type']) {
			const auth: AuthProvider = { headers: async () => ({ [header]: 'x' }) };
			await rejectsCode(make(fake, { auth }).initialize(), 'invalid-argument');
		}
		assert.equal(fake.requests.length, 0);
	});

	it('forwards the provider credentials mode and logout', async () => {
		const { fake } = sample();
		let loggedOut = false;
		const auth: AuthProvider = {
			credentials: 'same-origin',
			headers: async () => ({ 'X-Csrf-Token': 'csrf' }),
			logout: async () => {
				loggedOut = true;
			},
		};
		const { repository } = await ready(fake, { auth });
		assert.equal(fake.requests[0].init?.credentials, 'same-origin');
		await repository.logout();
		assert.ok(loggedOut);
		await rejectsCode(repository.getEntry(''), 'not-initialized');
	});
});
