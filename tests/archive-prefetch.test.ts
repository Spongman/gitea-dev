// Archive prefetch: size gate before any download, verified reads, fallback while incomplete,
// session-owned cancellation, and reuse of a stored archive on reload.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { RepositoryError } from '../packages/gitea-repository/src/errors.js';
import type { RepositoryEntry } from '../packages/gitea-repository/src/types.js';
import {
	ArchivePrefetcher,
	DEFAULT_ARCHIVE_SETTINGS,
	archiveSearchNotice,
	readArchiveSettings,
	type ArchiveBackend,
	type ArchiveSettings,
	type ArchiveState,
} from '../packages/gitea-vscode-web/src/archive-prefetch.js';
import { ArchiveStore, type ArchiveKey } from '../packages/gitea-vscode-web/src/archive-store.js';
import { chunked, concat, directory, file, gzip, pax, streamOf, symlink, tar } from './helpers/tar.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const COMMIT = 'a'.repeat(40);
const COMMIT2 = 'b'.repeat(40);

const sha1 = (data: Uint8Array | string) => createHash('sha1').update(data).digest('hex');
const blobSha = (data: Uint8Array) => sha1(concat(enc.encode(`blob ${data.length}\0`), data));

interface Built {
	entries: RepositoryEntry[];
	tar: Uint8Array;
}

/** A repository listing plus the tar Gitea would produce for it (global pax header, `repo/` prefix). */
function build(files: Record<string, string>, extra: { symlinks?: Record<string, string>; skipInTar?: string[] } = {}): Built {
	const dirs = new Set<string>();
	for (const path of Object.keys(files)) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			dirs.add(parts.slice(0, i).join('/'));
		}
	}
	const entries: RepositoryEntry[] = [];
	for (const dir of [...dirs].sort()) {
		entries.push({ path: dir, name: dir.split('/').pop() as string, type: 'directory', sha: sha1(`tree ${dir}`), size: 0 });
	}
	for (const [path, text] of Object.entries(files)) {
		const data = enc.encode(text);
		entries.push({ path, name: path.split('/').pop() as string, type: 'file', sha: blobSha(data), size: data.length });
	}
	const parts: Uint8Array[] = [pax({ comment: COMMIT }, 'g', 'pax_global_header'), directory('repo/')];
	for (const dir of [...dirs].sort()) {
		parts.push(directory(`repo/${dir}/`));
	}
	for (const [path, text] of Object.entries(files)) {
		if (!extra.skipInTar?.includes(path)) {
			parts.push(file(`repo/${path}`, text));
		}
	}
	for (const [path, target] of Object.entries(extra.symlinks ?? {})) {
		parts.push(symlink(`repo/${path}`, target));
	}
	return { entries, tar: tar(...parts) };
}

class FakeBackend implements ArchiveBackend {
	listCalls = 0;
	opens: Array<{ commit: string; signal: AbortSignal; maxBytes: number }> = [];
	body: (commit: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>;

	constructor(
		public entries: RepositoryEntry[],
		archive: Uint8Array | Promise<Uint8Array>,
	) {
		this.body = async () => streamOf(chunked(await archive, 1500));
	}

	async listTree(): Promise<RepositoryEntry[]> {
		this.listCalls++;
		return this.entries;
	}

	async openArchive(commit: string, options: { signal: AbortSignal; maxBytes: number }): Promise<ReadableStream<Uint8Array>> {
		this.opens.push({ commit, signal: options.signal, maxBytes: options.maxBytes });
		return this.body(commit, options.signal);
	}
}

/** Wraps a factory so every transaction is logged as "<mode>:<stores>". */
function countTransactions(base: IDBFactory, log: string[]): IDBFactory {
	const wrapDb = (target: IDBDatabase) =>
		new Proxy(target, {
			get(t, prop) {
				if (prop === 'transaction') {
					return (names: string | string[], mode: IDBTransactionMode = 'readonly') => {
						log.push(`${mode}:${[names].flat().join(',')}`);
						return t.transaction(names, mode);
					};
				}
				const member = Reflect.get(t, prop) as unknown;
				return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(t) : member;
			},
		});
	return new Proxy(base, {
		get(t, prop) {
			if (prop !== 'open') {
				const member = Reflect.get(t, prop) as unknown;
				return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(t) : member;
			}
			return (name: string, version?: number) => {
				const request = t.open(name, version);
				return new Proxy(request, {
					get(r, p) {
						if (p === 'result') return wrapDb(r.result);
						const member = Reflect.get(r, p) as unknown;
						return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(r) : member;
					},
					set(r, p, value) {
						Reflect.set(r, p, value);
						return true;
					},
				});
			};
		},
	}) as IDBFactory;
}

const kindOf = (prefetcher: ArchivePrefetcher): string => prefetcher.state.kind;

const key = (commit: string): ArchiveKey => ({ instance: 'https://git.example', owner: 'o', repository: 'repo', commit });

function setup(options: { settings?: Partial<ArchiveSettings>; factory?: IDBFactory; backend: FakeBackend; clock?: { now: number } }) {
	const clock = options.clock ?? { now: 1_000 };
	const factory = options.factory ?? new IDBFactory();
	const store = new ArchiveStore(factory, { keyRange: IDBKeyRange, now: () => clock.now });
	const settings: ArchiveSettings = { ...DEFAULT_ARCHIVE_SETTINGS, prefetch: 'onOpen', ...options.settings };
	const logs: string[] = [];
	const states: ArchiveState[] = [];
	const prefetcher = new ArchivePrefetcher({
		instance: 'https://git.example',
		owner: 'o',
		repository: 'repo',
		store,
		backend: options.backend,
		settings: () => settings,
		log: (message) => logs.push(message),
		now: () => clock.now,
	});
	prefetcher.onDidChange((state) => states.push(state));
	return { prefetcher, store, factory, settings, logs, states, clock };
}

const FILES = { 'README.md': 'readme text', 'src/main.ts': 'export {};\n', 'src/deep/util.ts': 'util', 'empty.txt': '' };

async function archiveOf(built: Built): Promise<Uint8Array> {
	return gzip(built.tar);
}

describe('archive prefetch: download', () => {
	it('stores the files named by the tree, then serves verified bytes', async () => {
		const built = build(FILES, { symlinks: { link: 'README.md' } });
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher, store, states } = setup({ backend });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();

		assert.equal(kindOf(prefetcher), 'ready');
		assert.deepEqual(backend.opens.map((o) => o.commit), [COMMIT]);
		assert.equal(backend.listCalls, 1);
		const record = await store.getArchive(key(COMMIT));
		assert.equal(record?.complete, true);
		assert.equal(record?.files, 4);
		assert.equal(await store.countFiles(key(COMMIT)), 4);
		for (const [path, text] of Object.entries(FILES)) {
			const entry = built.entries.find((e) => e.path === path) as RepositoryEntry;
			assert.equal(dec.decode(await prefetcher.lookup(path, entry)), text, path);
		}
		const kinds = states.map((s) => s.kind);
		assert.deepEqual(kinds.filter((k, i) => k !== kinds[i - 1]), ['idle', 'checking', 'downloading', 'ready']);
	});

	it('returns a copy so callers cannot alter the stored bytes', async () => {
		const built = build(FILES);
		const { prefetcher } = setup({ backend: new FakeBackend(built.entries, archiveOf(built)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		const entry = built.entries.find((e) => e.path === 'README.md') as RepositoryEntry;
		const first = (await prefetcher.lookup('README.md', entry)) as Uint8Array;
		first.fill(0);
		assert.equal(dec.decode(await prefetcher.lookup('README.md', entry)), FILES['README.md']);
	});

	it('leaves files missing from the archive (export-ignore) to blob reads', async () => {
		const built = build(FILES, { skipInTar: ['src/main.ts'] });
		const { prefetcher, store } = setup({ backend: new FakeBackend(built.entries, archiveOf(built)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
		assert.equal(await store.countFiles(key(COMMIT)), 3);
		const entry = built.entries.find((e) => e.path === 'src/main.ts') as RepositoryEntry;
		assert.equal(await prefetcher.lookup('src/main.ts', entry), undefined);
	});

	it('refuses bytes whose blob hash differs from the tree sha, even at the stored size', async () => {
		const built = build({ 'a.txt': 'right!' });
		const wrong = build({ 'a.txt': 'WRONG!' });
		const { prefetcher, logs } = setup({ backend: new FakeBackend(built.entries, archiveOf(wrong)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
		assert.equal(await prefetcher.lookup('a.txt', built.entries[0]), undefined);
		assert.equal(await prefetcher.lookup('a.txt', built.entries[0]), undefined);
		assert.equal(logs.filter((line) => line.includes('do not match the tree sha')).length, 1, 'logged once');
	});

	it('hashes a row again after another writer rewrote it', async () => {
		const built = build({ 'a.txt': 'right!' });
		const { prefetcher, store } = setup({ backend: new FakeBackend(built.entries, archiveOf(built)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(dec.decode(await prefetcher.lookup('a.txt', built.entries[0])), 'right!');
		await store.delete(key(COMMIT));
		const writer = await store.begin(key(COMMIT));
		await writer.put('a.txt', built.entries[0].sha, enc.encode('WRONG!'));
		await writer.complete();
		assert.equal(await prefetcher.lookup('a.txt', built.entries[0]), undefined);
	});

	it('reads lookups made in one tick in a single transaction, and nothing for a file over maxFileBytes', async () => {
		const built = build(FILES);
		const transactions: string[] = [];
		const { prefetcher } = setup({ factory: countTransactions(new IDBFactory(), transactions), settings: { maxFileBytes: 20 }, backend: new FakeBackend(built.entries, archiveOf(built)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		const entries = built.entries.filter((e) => e.type === 'file');
		transactions.length = 0;
		const rows = await Promise.all(entries.map((entry) => prefetcher.lookup(entry.path, entry)));
		assert.deepEqual(rows.map((row) => row !== undefined), entries.map(() => true));
		assert.deepEqual(transactions, ['readonly:files']);
		transactions.length = 0;
		assert.equal(await prefetcher.lookup('big.bin', { path: 'big.bin', name: 'big.bin', type: 'file', sha: 'f'.repeat(40), size: 21 }), undefined);
		assert.deepEqual(transactions, []);
	});

	it('does not serve an entry whose sha or size differs from the stored row', async () => {
		const built = build(FILES);
		const { prefetcher } = setup({ backend: new FakeBackend(built.entries, archiveOf(built)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		const entry = built.entries.find((e) => e.path === 'README.md') as RepositoryEntry;
		assert.equal(await prefetcher.lookup('README.md', { ...entry, sha: 'f'.repeat(40) }), undefined);
		assert.equal(await prefetcher.lookup('README.md', { ...entry, size: entry.size + 1 }), undefined);
		assert.equal(await prefetcher.lookup('README.md', { ...entry, type: 'symlink' }), undefined);
		assert.equal(await prefetcher.lookup('nope', entry), undefined);
	});

	it('skips files over maxFileBytes and entries the tree does not list', async () => {
		const built = build({ ...FILES, 'big.bin': 'x'.repeat(5000) });
		const stray = concat(built.tar.slice(0, built.tar.length - 1024), file('repo/stray.txt', 'not in tree'), new Uint8Array(1024));
		const { prefetcher, store } = setup({ settings: { maxFileBytes: 1000 }, backend: new FakeBackend(built.entries, gzip(stray)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
		assert.equal((await store.getFiles(key(COMMIT), ['big.bin']))[0], undefined);
		assert.equal((await store.getFiles(key(COMMIT), ['stray.txt']))[0], undefined);
		assert.equal(await store.countFiles(key(COMMIT)), 4);
	});
});

describe('archive prefetch: gate and failures', () => {
	it('does not request the archive when the tree sum is over the limit', async () => {
		const built = build({ 'a.txt': 'x'.repeat(3000), 'b.txt': 'y'.repeat(3000) });
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher, store } = setup({ settings: { maxRepositoryBytes: 5000 }, backend });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'unsupported');
		assert.match((prefetcher.state as { reason: string }).reason, /over the .* MiB limit/);
		assert.equal(backend.opens.length, 0);
		assert.equal(await store.getArchive(key(COMMIT)), undefined);
	});

	it('applies the smaller of the repository limit and the cache budget', async () => {
		const built = build({ 'a.txt': 'x'.repeat(3000) });
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ settings: { cacheBytes: 1000 }, backend });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'unsupported');
		assert.equal(backend.opens.length, 0);
	});

	it('does not request the archive when the repository has too many files', async () => {
		const built = build({ a: '1', b: '2', c: '3' });
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ settings: { maxEntries: 2 }, backend });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'unsupported');
		assert.match((prefetcher.state as { reason: string }).reason, /3 files/);
		assert.equal(backend.opens.length, 0);
	});

	it('makes no request when the browser cannot gunzip a stream', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ backend });
		const original = globalThis.DecompressionStream;
		// @ts-expect-error simulate a browser without DecompressionStream
		delete globalThis.DecompressionStream;
		try {
			prefetcher.setCommit(COMMIT);
			await prefetcher.attach();
			await prefetcher.settled();
		} finally {
			globalThis.DecompressionStream = original;
		}
		assert.equal(kindOf(prefetcher), 'unsupported');
		assert.match((prefetcher.state as { reason: string }).reason, /DecompressionStream/);
		assert.equal(backend.opens.length, 0);
	});

	it('fails a truncated download without marking anything complete, and removes the partial rows', async () => {
		const built = build(FILES);
		const compressed = await gzip(built.tar);
		const backend = new FakeBackend(built.entries, compressed.slice(0, compressed.length - 40));
		const { prefetcher, store } = setup({ backend });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'failed');
		assert.equal(await store.getArchive(key(COMMIT)), undefined);
		assert.equal(await store.countFiles(key(COMMIT)), 0);
		const entry = built.entries.find((e) => e.path === 'README.md') as RepositoryEntry;
		assert.equal(await prefetcher.lookup('README.md', entry), undefined);
	});

	it('fails a tar with a corrupt header', async () => {
		const built = build(FILES);
		const bad = built.tar.slice();
		bad[1024 + 3] ^= 1;
		const { prefetcher, store } = setup({ backend: new FakeBackend(built.entries, gzip(bad)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'failed');
		assert.match((prefetcher.state as { reason: string }).reason, /checksum/i);
		assert.equal(await store.getArchive(key(COMMIT)), undefined);
	});

	it('fails a tar that expands beyond the tree total (bomb)', async () => {
		const built = build({ 'a.txt': 'tiny' });
		const bomb = tar(directory('repo/'), file('repo/a.txt', 'tiny'), file('repo/huge.bin', 'z'.repeat(3 * 1024 * 1024)));
		const { prefetcher, store } = setup({ backend: new FakeBackend(built.entries, gzip(bomb)) });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'failed');
		assert.equal(await store.getArchive(key(COMMIT)), undefined);
	});

	it('maps a server error to a failed state that names the status, and retries only after the cooldown', async () => {
		const built = build(FILES);
		const clock = { now: 1_000 };
		const backend = new FakeBackend(built.entries, archiveOf(built));
		let fail = true;
		const good = backend.body;
		backend.body = (commit, signal) => {
			if (fail) {
				throw new RepositoryError('not-found', 'Not found', { status: 404 });
			}
			return good(commit, signal);
		};
		const { prefetcher } = setup({ backend, clock, settings: { prefetch: 'onSearch' } });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		assert.equal(kindOf(prefetcher), 'idle');
		prefetcher.ensure();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'failed');
		assert.match((prefetcher.state as { reason: string }).reason, /404/);

		fail = false;
		clock.now += 1_000;
		prefetcher.ensure();
		await prefetcher.settled();
		assert.equal(backend.opens.length, 1, 'no retry inside the cooldown');
		clock.now += 60_000;
		prefetcher.ensure();
		await prefetcher.settled();
		assert.equal(backend.opens.length, 2);
		assert.equal(kindOf(prefetcher), 'ready');
	});
});

describe('archive prefetch: start policy', () => {
	it('downloads only on demand in onSearch mode', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ backend, settings: { prefetch: 'onSearch' } });
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'idle');
		assert.equal(backend.opens.length, 0);
		prefetcher.ensure();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
		assert.equal(backend.opens.length, 1);
	});

	it('honors a request made while the stored archive is still being looked up', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ backend, settings: { prefetch: 'onSearch' } });
		prefetcher.setCommit(COMMIT);
		const attaching = prefetcher.attach();
		prefetcher.ensure();
		await attaching;
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
	});

	it('does nothing in off mode, not even using a stored archive', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const first = setup({ backend });
		first.prefetcher.setCommit(COMMIT);
		await first.prefetcher.attach();
		await first.prefetcher.settled();
		const second = setup({ backend, factory: first.factory, settings: { prefetch: 'off' } });
		second.prefetcher.setCommit(COMMIT);
		await second.prefetcher.attach();
		second.prefetcher.ensure();
		await second.prefetcher.settled();
		assert.equal(kindOf(second.prefetcher), 'disabled');
		const entry = built.entries.find((e) => e.path === 'README.md') as RepositoryEntry;
		assert.equal(await second.prefetcher.lookup('README.md', entry), undefined);
		assert.equal(backend.opens.length, 1);
	});

	it('stays inert until attached, so probe repositories make no requests', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ backend });
		prefetcher.setCommit(COMMIT);
		prefetcher.ensure();
		prefetcher.setCommit(COMMIT2);
		await prefetcher.settled();
		assert.equal(backend.listCalls, 0);
		assert.equal(backend.opens.length, 0);
	});

	it('uses a complete stored archive on reload with no list or archive request', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const first = setup({ backend });
		first.prefetcher.setCommit(COMMIT);
		await first.prefetcher.attach();
		await first.prefetcher.settled();
		assert.equal(backend.opens.length, 1);

		const reloaded = new FakeBackend(built.entries, archiveOf(built));
		const second = setup({ backend: reloaded, factory: first.factory, settings: { prefetch: 'onSearch' } });
		second.prefetcher.setCommit(COMMIT);
		await second.prefetcher.attach();
		second.prefetcher.ensure();
		await second.prefetcher.settled();
		assert.deepEqual(second.prefetcher.state, { kind: 'ready', files: 4, bytes: 11 + 11 + 4 + 0, source: 'cache' });
		assert.equal(reloaded.listCalls, 0);
		assert.equal(reloaded.opens.length, 0);
		const entry = built.entries.find((e) => e.path === 'src/main.ts') as RepositoryEntry;
		assert.equal(dec.decode(await second.prefetcher.lookup('src/main.ts', entry)), FILES['src/main.ts']);
	});

	it('does not reuse an archive that was never completed', async () => {
		const built = build(FILES);
		const first = setup({ backend: new FakeBackend(built.entries, archiveOf(built)) });
		const writer = await first.store.begin(key(COMMIT));
		await writer.put('README.md', 'sha', enc.encode('readme text'));
		const backend = new FakeBackend(built.entries, archiveOf(built));
		// The writer never finished and has been silent past the stale age: a crashed tab.
		const second = setup({ backend, factory: first.factory, clock: { now: 1_000 + 11 * 60_000 } });
		second.prefetcher.setCommit(COMMIT);
		await second.prefetcher.attach();
		await second.prefetcher.settled();
		assert.equal(backend.opens.length, 1);
		assert.equal(kindOf(second.prefetcher), 'ready');
	});
});

describe('archive prefetch: cancellation is owned by the session', () => {
	function stalling(built: Built) {
		const backend = new FakeBackend(built.entries, archiveOf(built));
		let release: (() => void) | undefined;
		backend.body = async (_commit, signal) => {
			const compressed = await archiveOf(built);
			const head = compressed.slice(0, 200);
			let sent = false;
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (!sent) {
						sent = true;
						controller.enqueue(head);
						return;
					}
					await new Promise<void>((resolve) => {
						release = resolve;
						signal.addEventListener('abort', () => resolve(), { once: true });
					});
					if (signal.aborted) {
						controller.error(new RepositoryError('aborted', 'The request was aborted'));
					}
				},
			}, { highWaterMark: 0 });
		};
		return { backend, release: () => release?.() };
	}

	it('aborts the download and removes partial rows when the base commit changes', async () => {
		const built = build(FILES);
		const { backend } = stalling(built);
		const { prefetcher, store, states } = setup({ backend });
		prefetcher.setCommit(COMMIT);
		void prefetcher.attach();
		while (backend.opens.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		backend.body = new FakeBackend(built.entries, archiveOf(built)).body;
		prefetcher.setCommit(COMMIT2);
		assert.equal(backend.opens[0].signal.aborted, true);
		await prefetcher.settled();
		assert.equal(await store.getArchive(key(COMMIT)), undefined);
		assert.equal(await store.countFiles(key(COMMIT)), 0);
		assert.ok(!states.some((s) => s.kind === 'failed'), 'an abort is not a failure');
		// The new commit downloads normally.
		await prefetcher.settled();
		assert.equal(prefetcher.commit, COMMIT2);
		assert.equal(backend.opens.at(-1)?.commit, COMMIT2);
		assert.equal((await store.getArchive(key(COMMIT2)))?.complete, true);
		assert.equal(kindOf(prefetcher), 'ready');
	});

	it('aborts the download on dispose', async () => {
		const built = build(FILES);
		const { backend } = stalling(built);
		const { prefetcher, store } = setup({ backend });
		prefetcher.setCommit(COMMIT);
		void prefetcher.attach();
		while (backend.opens.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		prefetcher.dispose();
		assert.equal(backend.opens[0].signal.aborted, true);
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'disabled');
		assert.equal(await store.getArchive(key(COMMIT)), undefined);
		prefetcher.ensure();
		assert.equal(backend.opens.length, 1);
	});

	it('keeps downloading when the same commit is set again', async () => {
		const built = build(FILES);
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher } = setup({ backend });
		prefetcher.setCommit(COMMIT);
		const attaching = prefetcher.attach();
		prefetcher.setCommit(COMMIT);
		await attaching;
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
		assert.equal(backend.opens.length, 1);
	});

	it('stops serving the old archive once the commit changes', async () => {
		const built = build(FILES);
		const { prefetcher } = setup({ backend: new FakeBackend(built.entries, archiveOf(built)), settings: { prefetch: 'onSearch' } });
		prefetcher.setCommit(COMMIT);
		prefetcher.ensure();
		await prefetcher.attach();
		prefetcher.ensure();
		await prefetcher.settled();
		const entry = built.entries.find((e) => e.path === 'README.md') as RepositoryEntry;
		assert.ok(await prefetcher.lookup('README.md', entry));
		prefetcher.setCommit(COMMIT2);
		assert.equal(kindOf(prefetcher), 'idle');
		assert.equal(await prefetcher.lookup('README.md', entry), undefined);
	});
});

describe('archive prefetch: search notices and settings', () => {
	it('warns only while results cannot come from the archive', () => {
		assert.equal(archiveSearchNotice({ kind: 'ready', files: 1, bytes: 1, source: 'download' }), undefined);
		assert.equal(archiveSearchNotice({ kind: 'disabled' }), undefined);
		for (const state of [{ kind: 'idle' }, { kind: 'checking' }, { kind: 'downloading', bytes: 1, total: 2 }] as ArchiveState[]) {
			assert.match(archiveSearchNotice(state) as string, /still downloading/);
		}
		assert.match(archiveSearchNotice({ kind: 'unsupported', reason: 'the repository is 300 MiB, over the 128 MiB limit' }) as string, /unavailable \(the repository is 300 MiB/);
		assert.match(archiveSearchNotice({ kind: 'failed', reason: 'Not found (HTTP 404)' }) as string, /unavailable \(Not found \(HTTP 404\)\)/);
	});

	it('reads settings in user units and falls back to defaults for invalid values', () => {
		const values: Record<string, unknown> = {
			prefetch: 'onOpen',
			maxRepositoryMiB: 10,
			maxFiles: 7,
			maxFileMiB: 2,
			maxDownloadMiB: 3,
			idleTimeoutSeconds: 4,
			startTimeoutSeconds: 5,
			cacheMiB: 6,
		};
		const read = (v: Record<string, unknown>) => readArchiveSettings({ get: <T>(k: string) => v[k] as T | undefined });
		assert.deepEqual(read(values), {
			prefetch: 'onOpen',
			maxRepositoryBytes: 10 * 1048576,
			maxEntries: 7,
			maxFileBytes: 2 * 1048576,
			maxDownloadBytes: 3 * 1048576,
			idleTimeoutMs: 4000,
			startTimeoutMs: 5000,
			cacheBytes: 6 * 1048576,
		});
		assert.deepEqual(read({ prefetch: 'sometimes', maxFiles: -1, cacheMiB: 'big', maxFileMiB: Number.NaN }), DEFAULT_ARCHIVE_SETTINGS);
	});
});

describe('archive prefetch: stored archive integrity', () => {
	it('downloads again when a stored complete archive lost rows', async () => {
		const built = build(FILES);
		const first = setup({ backend: new FakeBackend(built.entries, archiveOf(built)) });
		first.prefetcher.setCommit(COMMIT);
		await first.prefetcher.attach();
		await first.prefetcher.settled();
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = first.factory.open('gitea-dev-archive', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const tx = db.transaction('files', 'readwrite');
		tx.objectStore('files').delete(['https://git.example', 'o', 'repo', COMMIT, 'README.md']);
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
		});
		db.close();
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const second = setup({ backend, factory: first.factory });
		second.prefetcher.setCommit(COMMIT);
		await second.prefetcher.attach();
		await second.prefetcher.settled();
		assert.equal(backend.opens.length, 1);
		assert.equal(kindOf(second.prefetcher), 'ready');
		assert.equal(await second.store.countFiles(key(COMMIT)), 4);
	});
});

describe('archive prefetch: cache budget', () => {
	it('evicts older archives before downloading, so both never sit in the store together', async () => {
		const built = build({ 'a.txt': 'x'.repeat(30) });
		const backend = new FakeBackend(built.entries, archiveOf(built));
		const { prefetcher, store } = setup({ settings: { cacheBytes: 1000 }, backend });
		const old = await store.begin(key(COMMIT2));
		await old.put('big', 'sha', new Uint8Array(990));
		await old.complete();
		let oldDuringDownload: unknown = 'unset';
		const body = backend.body;
		backend.body = async (commit, signal) => {
			oldDuringDownload = await store.getArchive(key(COMMIT2));
			return body(commit, signal);
		};
		prefetcher.setCommit(COMMIT);
		await prefetcher.attach();
		await prefetcher.settled();
		assert.equal(kindOf(prefetcher), 'ready');
		assert.equal(oldDuringDownload, undefined);
	});
});
