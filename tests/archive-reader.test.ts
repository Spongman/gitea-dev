// Archive-backed repository: serves reads from the archive store once complete (zero blob reads),
// falls back to blobs while incomplete or on any mismatch, and follows the session's base commit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { parseLfsPointer } from '../packages/gitea-repository/src/bytes.js';
import { RepositoryError } from '../packages/gitea-repository/src/errors.js';
import type {
	CommitResult,
	InitializableGiteaRepository,
	ReadFileOptions,
	RepositoryEntry,
	RepositoryFile,
	RepositoryState,
} from '../packages/gitea-repository/src/types.js';
import { ArchiveBackedRepository } from '../packages/gitea-vscode-web/src/archive-reader.js';
import { DEFAULT_ARCHIVE_SETTINGS, type ArchiveSettings } from '../packages/gitea-vscode-web/src/archive-prefetch.js';
import { ArchiveStore } from '../packages/gitea-vscode-web/src/archive-store.js';
import { ChangeOverlay } from '../packages/gitea-vscode-web/src/overlay.js';
import { searchText } from '../packages/gitea-vscode-web/src/search-engine.js';
import { MemoryOverlayStorage } from '../packages/gitea-vscode-web/src/storage.js';
import { concat, directory, file, gzip, streamOf, tar } from './helpers/tar.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const COMMIT = 'a'.repeat(40);
const COMMIT2 = 'b'.repeat(40);
const LFS_OBJECT = 'the large object body\n';
const LFS = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + `\nsize ${LFS_OBJECT.length}\n`;

const blobSha = (data: Uint8Array) => createHash('sha1').update(concat(enc.encode(`blob ${data.length}\0`), data)).digest('hex');

const FILES: Record<string, string> = {
	'README.md': 'read me needle',
	'src/main.ts': 'const needle = 1;\n',
	'src/lib/util.ts': 'export const util = 2;\n',
	'docs/lfs.bin': LFS,
};
/** Files whose archived bytes are their content; LFS pointers are resolved by the inner repository. */
const PLAIN = Object.entries(FILES).filter(([path]) => path !== 'docs/lfs.bin');

function listing(files: Record<string, string>): RepositoryEntry[] {
	const dirs = new Set<string>();
	for (const path of Object.keys(files)) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			dirs.add(parts.slice(0, i).join('/'));
		}
	}
	const entry = (path: string, type: 'file' | 'directory', data?: Uint8Array): RepositoryEntry => ({
		path,
		name: path.split('/').pop() as string,
		type,
		sha: data === undefined ? createHash('sha1').update(`tree ${path}`).digest('hex') : blobSha(data),
		size: data?.length ?? 0,
	});
	return [...[...dirs].sort().map((d) => entry(d, 'directory')), ...Object.entries(files).map(([p, t]) => entry(p, 'file', enc.encode(t)))];
}

class FakeInner implements InitializableGiteaRepository {
	blobReads: string[] = [];
	entries: RepositoryEntry[];
	head = COMMIT;

	constructor(public files: Record<string, string>) {
		this.entries = listing(files);
	}

	async initialize(): Promise<RepositoryState> {
		return { commit: this.head, branch: 'main', canWrite: true, canBranch: true };
	}

	async refresh(commit?: string): Promise<void> {
		this.head = commit ?? this.head;
	}

	async getEntry(path: string): Promise<RepositoryEntry> {
		const found = path === '' ? { path: '', name: '', type: 'directory' as const, sha: 'r'.repeat(40), size: 0 } : this.entries.find((e) => e.path === path);
		if (found === undefined) {
			throw new RepositoryError('not-found', `Not found: ${path}`);
		}
		return { ...found };
	}

	async readDirectory(path: string): Promise<RepositoryEntry[]> {
		const prefix = path === '' ? '' : `${path}/`;
		return this.entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/')).map((e) => ({ ...e }));
	}

	async readTree(): Promise<RepositoryEntry[]> {
		return this.entries.map((e) => ({ ...e }));
	}

	async readFile(path: string, options?: ReadFileOptions): Promise<RepositoryFile> {
		const entry = await this.getEntry(path);
		if (entry.type === 'directory') {
			throw new RepositoryError('is-a-directory', `Is a directory: ${path}`);
		}
		this.blobReads.push(path);
		const content = enc.encode(this.files[path]);
		const pointer = parseLfsPointer(content);
		if (pointer === undefined) {
			return { entry, content };
		}
		const resolve = options?.lfs !== 'pointer';
		return { entry, content: resolve ? enc.encode(LFS_OBJECT) : content, lfs: { ...pointer, resolved: resolve } };
	}

	async commit(): Promise<CommitResult> {
		throw new Error('unused');
	}
}

interface Call {
	url: string;
	init: RequestInit;
}

function archiveOf(files: Record<string, string>): Promise<Uint8Array> {
	const dirs = [...new Set(Object.keys(files).flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort();
	return gzip(tar(directory('repo/'), ...dirs.map((d) => directory(`repo/${d}/`)), ...Object.entries(files).map(([p, t]) => file(`repo/${p}`, t))));
}

function setup(options: { files?: Record<string, string>; archive?: Record<string, string>; settings?: Partial<ArchiveSettings>; factory?: IDBFactory; stall?: boolean; maxFileSize?: number } = {}) {
	const files = options.files ?? FILES;
	const inner = new FakeInner(files);
	const calls: Call[] = [];
	const factory = options.factory ?? new IDBFactory();
	const store = new ArchiveStore(factory, { keyRange: IDBKeyRange });
	const settings: ArchiveSettings = { ...DEFAULT_ARCHIVE_SETTINGS, prefetch: 'onOpen', ...options.settings };
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init: init as RequestInit });
		if (options.stall === true) {
			const signal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull: () =>
						new Promise<void>((_, reject) => {
							signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
						}),
				}, { highWaterMark: 0 }),
			);
		}
		const commit = /archive\/([0-9a-f]+)\.tar\.gz/.exec(String(input))?.[1];
		assert.ok(commit, `unexpected request ${String(input)}`);
		return new Response(streamOf([await archiveOf(options.archive ?? files)]));
	}) as typeof fetch;
	const repo = new ArchiveBackedRepository(
		{ instance: 'https://git.example/sub', owner: 'o', repository: 'repo', ref: 'main', maxFileSize: options.maxFileSize, fetch: fetchImpl, auth: { headers: async () => ({ Authorization: 'token t0k' }) } },
		{ store, settings: () => settings, createInner: () => inner },
	);
	return { repo, inner, calls, store, factory, settings };
}

const kindOf = (repo: ArchiveBackedRepository): string => repo.archive.state.kind;

async function ready(repo: ArchiveBackedRepository): Promise<void> {
	await repo.initialize();
	await repo.archive.attach();
	await repo.archive.settled();
	assert.equal(kindOf(repo), 'ready');
}

describe('archive-backed repository', () => {
	it('is inert until attached: initialize and reads make no archive request', async () => {
		const { repo, inner, calls, store } = setup();
		await repo.initialize();
		assert.equal(dec.decode((await repo.readFile('README.md')).content), FILES['README.md']);
		repo.archive.ensure();
		await repo.archive.settled();
		assert.deepEqual(inner.blobReads, ['README.md']);
		assert.equal(calls.length, 0);
		assert.deepEqual(await store.listArchives(), []);
	});

	it('requests the tar.gz of the pinned commit with auth, then reads every file without blob reads', async () => {
		const { repo, inner, calls } = setup();
		await ready(repo);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `https://git.example/sub/api/v1/repos/o/repo/archive/${COMMIT}.tar.gz`);
		assert.deepEqual(calls[0].init.headers, { Authorization: 'token t0k', Accept: '*/*' });
		assert.equal(calls[0].init.redirect, 'error');
		for (const [path, text] of PLAIN) {
			const read = await repo.readFile(path);
			assert.equal(dec.decode(read.content), text, path);
			assert.equal(read.entry.path, path);
			assert.equal(read.entry.type, 'file');
		}
		assert.deepEqual(inner.blobReads, []);
		assert.equal(calls.length, 1);
	});

	it('resolves Git LFS pointers from the archive to the LFS object, like the blob path', async () => {
		const { repo, inner, calls } = setup();
		await ready(repo);
		const read = await repo.readFile('docs/lfs.bin');
		assert.equal(dec.decode(read.content), LFS_OBJECT);
		assert.deepEqual(read.lfs, { oid: 'ab'.repeat(32), size: LFS_OBJECT.length, resolved: true });
		assert.deepEqual(inner.blobReads, ['docs/lfs.bin']);
		assert.equal(calls.length, 1);
		assert.equal((await repo.readFile('README.md')).lfs, undefined);
	});

	it('serves an archived Git LFS pointer as stored, without the inner repository, when asked', async () => {
		const { repo, inner } = setup();
		await ready(repo);
		const read = await repo.readFile('docs/lfs.bin', { lfs: 'pointer' });
		assert.equal(dec.decode(read.content), LFS);
		assert.deepEqual(read.lfs, { oid: 'ab'.repeat(32), size: LFS_OBJECT.length, resolved: false });
		assert.deepEqual(inner.blobReads, []);
	});

	it('returns bytes the caller may modify without changing the stored copy', async () => {
		const { repo } = setup();
		await ready(repo);
		(await repo.readFile('README.md')).content.fill(0);
		assert.equal(dec.decode((await repo.readFile('README.md')).content), FILES['README.md']);
	});

	it('reads blobs while the archive is incomplete, and archive bytes after', async () => {
		const { repo, inner } = setup({ settings: { prefetch: 'onSearch' } });
		await repo.initialize();
		await repo.archive.attach();
		await repo.readFile('src/main.ts');
		assert.deepEqual(inner.blobReads, ['src/main.ts']);
		repo.archive.ensure();
		await repo.archive.settled();
		await repo.readFile('src/main.ts');
		assert.deepEqual(inner.blobReads, ['src/main.ts']);
	});

	it('falls back to the blob when archive bytes do not hash to the tree sha', async () => {
		const tampered = { ...FILES, 'src/main.ts': 'const NEEDLE = 1;\n' };
		const { repo, inner } = setup({ archive: tampered });
		await ready(repo);
		const read = await repo.readFile('src/main.ts');
		assert.equal(dec.decode(read.content), FILES['src/main.ts']);
		assert.deepEqual(inner.blobReads, ['src/main.ts']);
	});

	it('falls back for a file the archive omitted', async () => {
		const { repo, inner } = setup({ archive: { 'README.md': FILES['README.md'] } });
		await ready(repo);
		assert.equal(dec.decode((await repo.readFile('src/main.ts')).content), FILES['src/main.ts']);
		assert.deepEqual(inner.blobReads, ['src/main.ts']);
	});

	it('leaves errors and directories to the wrapped repository', async () => {
		const { repo } = setup();
		await ready(repo);
		await assert.rejects(repo.readFile('missing.txt'), (e: unknown) => e instanceof RepositoryError && e.code === 'not-found');
		await assert.rejects(repo.readFile('src'), (e: unknown) => e instanceof RepositoryError && e.code === 'is-a-directory');
	});

	it('delegates files above the repository max file size even when the archive holds them', async () => {
		const { repo, inner } = setup({ maxFileSize: 16 });
		await ready(repo);
		await repo.readFile('src/main.ts');
		assert.deepEqual(inner.blobReads, ['src/main.ts'], '18 bytes is over the 16 byte limit');
		inner.blobReads.length = 0;
		assert.equal(dec.decode((await repo.readFile('README.md')).content), FILES['README.md']);
		assert.deepEqual(inner.blobReads, [], '14 bytes is within the limit');
	});

	it('moves with the base commit: the old archive stops serving and the new commit downloads on demand', async () => {
		const { repo, inner, calls } = setup({ settings: { prefetch: 'onSearch' } });
		await repo.initialize();
		await repo.archive.attach();
		repo.archive.ensure();
		await repo.archive.settled();
		assert.equal(kindOf(repo), 'ready');
		await repo.refresh(COMMIT2);
		assert.equal(kindOf(repo), 'idle');
		assert.equal(repo.archive.commit, COMMIT2);
		await repo.readFile('README.md');
		assert.deepEqual(inner.blobReads, ['README.md']);
		repo.archive.ensure();
		await repo.archive.settled();
		assert.equal(calls.length, 2);
		assert.ok(calls[1].url.endsWith(`/archive/${COMMIT2}.tar.gz`));
		assert.equal(kindOf(repo), 'ready');
	});

	it('follows the re-resolved commit when refreshed without one', async () => {
		const { repo, inner } = setup({ settings: { prefetch: 'onSearch' } });
		await repo.initialize();
		await repo.archive.attach();
		repo.archive.ensure();
		await repo.archive.settled();
		assert.equal(kindOf(repo), 'ready');
		inner.head = COMMIT2;
		await repo.refresh();
		assert.equal(repo.archive.commit, COMMIT2);
		assert.equal(kindOf(repo), 'idle');
	});

	it('does not move the archive when the wrapped refresh fails', async () => {
		const { repo, inner } = setup();
		await ready(repo);
		inner.refresh = async () => {
			throw new RepositoryError('network', 'down');
		};
		await assert.rejects(repo.refresh(COMMIT2));
		assert.equal(repo.archive.commit, COMMIT);
		assert.equal(kindOf(repo), 'ready');
	});

	it('reuses the stored archive after a reload with no archive request and no blob reads', async () => {
		const first = setup();
		await ready(first.repo);
		const second = setup({ factory: first.factory });
		await second.repo.initialize();
		await second.repo.archive.attach();
		await second.repo.archive.settled();
		assert.deepEqual(second.repo.archive.state, { kind: 'ready', files: 4, bytes: Object.values(FILES).reduce((n, t) => n + t.length, 0), source: 'cache' });
		for (const [path] of PLAIN) {
			await second.repo.readFile(path);
		}
		assert.equal(second.calls.length, 0);
		assert.deepEqual(second.inner.blobReads, []);
	});

	it('aborts the in-flight download on dispose', async () => {
		const { repo, calls, store } = setup({ stall: true });
		await repo.initialize();
		void repo.archive.attach();
		while (calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		repo.dispose();
		assert.equal(calls[0].init.signal?.aborted, true);
		await repo.archive.settled();
		assert.deepEqual(await store.listArchives(), []);
	});

	it('does a search with zero blob reads once the archive is complete, and with per-blob reads before', async () => {
		const { repo, inner } = setup({ settings: { prefetch: 'onSearch' } });
		const state = await repo.initialize();
		const overlay = await ChangeOverlay.open({
			key: { instance: 'https://git.example/sub', owner: 'o', repository: 'repo', ref: 'main', baseCommit: state.commit },
			storage: new MemoryOverlayStorage(),
			base: repo,
		});
		await repo.archive.attach();
		const run = () => {
			const paths: string[] = [];
			return searchText(overlay, {
				query: { pattern: 'needle' },
				root: '',
				maxResults: 100,
				isCancelled: () => false,
				onResult: (result) => {
					paths.push(result.path);
				},
			}).then((summary) => ({ summary, paths }));
		};
		const before = await run();
		assert.deepEqual(before.paths, ['README.md', 'src/main.ts']);
		assert.equal(inner.blobReads.length, 4, 'every file is a blob read while the archive is incomplete');

		repo.archive.ensure();
		await repo.archive.settled();
		inner.blobReads.length = 0;
		const after = await run();
		assert.deepEqual(after.paths, before.paths);
		assert.equal(after.summary.filesScanned, before.summary.filesScanned);
		assert.deepEqual(inner.blobReads, []);
	});

	it('serves unchanged files from the archive even when other files carry local edits', async () => {
		const { repo, inner } = setup();
		const state = await repo.initialize();
		const overlay = await ChangeOverlay.open({
			key: { instance: 'https://git.example/sub', owner: 'o', repository: 'repo', ref: 'main', baseCommit: state.commit },
			storage: new MemoryOverlayStorage(),
			base: repo,
		});
		await repo.archive.attach();
		await repo.archive.settled();
		await overlay.writeFile('README.md', enc.encode('edited'), { create: false, overwrite: true });
		assert.equal(dec.decode(await overlay.readFile('src/main.ts')), FILES['src/main.ts']);
		const pending = overlay.list();
		assert.equal(pending.length, 1);
		assert.deepEqual(inner.blobReads, []);
	});
});
