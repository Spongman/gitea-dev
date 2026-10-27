// Archive store expectations: the `complete` flag is written last, incomplete archives are purged,
// eviction is least-recently-used over complete archives only, and a cancelled write leaves nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { ArchiveStore, ArchiveStoreError, type ArchiveKey, type ArchiveLocks } from '../packages/gitea-vscode-web/src/archive-store.js';

const key = (commit: string, repository = 'r'): ArchiveKey => ({ instance: 'https://git.example/sub', owner: 'o', repository, commit });
const bytes = (text: string) => new TextEncoder().encode(text);

function makeStore(options: { factory?: IDBFactory; batchFiles?: number; batchBytes?: number; locks?: ArchiveLocks } = {}) {
	const clock = { now: 1_000 };
	const factory = options.factory ?? new IDBFactory();
	const store = new ArchiveStore(factory, { keyRange: IDBKeyRange, now: () => clock.now, batchFiles: options.batchFiles, batchBytes: options.batchBytes, locks: options.locks });
	return { store, clock, factory };
}

async function fill(store: ArchiveStore, k: ArchiveKey, files: Record<string, string>) {
	const writer = await store.begin(k);
	for (const [path, text] of Object.entries(files)) {
		await writer.put(path, `sha-${path}`, bytes(text));
	}
	return writer;
}

/** Wraps a factory so every put in a readwrite transaction is logged as "<store>:<flag or path>". */
function spyOnPuts(base: IDBFactory, log: string[]): IDBFactory {
	const wrapStore = (target: IDBObjectStore) =>
		new Proxy(target, {
			get(t, prop) {
				if (prop === 'put') {
					return (value: { path?: string; complete?: boolean }) => {
						log.push(t.name === 'files' ? `files:${value.path}` : `archives:complete=${String(value.complete)}`);
						return t.put(value as never);
					};
				}
				const member = Reflect.get(t, prop) as unknown;
				return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(t) : member;
			},
		});
	const wrapTx = (target: IDBTransaction) =>
		new Proxy(target, {
			get(t, prop) {
				if (prop === 'objectStore') {
					return (name: string) => wrapStore(t.objectStore(name));
				}
				const member = Reflect.get(t, prop) as unknown;
				return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(t) : member;
			},
			set(t, prop, value) {
				Reflect.set(t, prop, value);
				return true;
			},
		});
	const wrapDb = (target: IDBDatabase) =>
		new Proxy(target, {
			get(t, prop) {
				if (prop === 'transaction') {
					return (...args: [string | string[], IDBTransactionMode?]) => wrapTx(t.transaction(...args));
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
						return p === 'result' ? wrapDb(r.result) : Reflect.get(r, p);
					},
					set(r, p, value) {
						Reflect.set(r, p, value);
						return true;
					},
				});
			};
		},
	});
}

describe('archive store', () => {
	it('round-trips file bytes and metadata for a complete archive', async () => {
		const { store } = makeStore();
		const writer = await fill(store, key('c1'), { 'a.txt': 'hello', 'dir/b.bin': '\u0000\u0001', empty: '' });
		const record = await writer.complete();
		assert.equal(record.complete, true);
		assert.equal(record.files, 3);
		assert.equal(record.bytes, 5 + 2 + 0);
		const file = (await store.getFiles(key('c1'), ['a.txt']))[0];
		assert.ok(file);
		assert.ok(file.content instanceof Uint8Array);
		assert.equal(new TextDecoder().decode(file.content), 'hello');
		assert.equal(file.sha, 'sha-a.txt');
		assert.equal(file.size, 5);
		assert.equal((await store.getFiles(key('c1'), ['empty']))[0]?.content.length, 0);
		assert.equal((await store.getFiles(key('c1'), ['missing']))[0], undefined);
		assert.equal((await store.getArchive(key('c1')))?.complete, true);
	});

	it('writes the complete flag in a transaction after every file', async () => {
		const log: string[] = [];
		const { store } = makeStore({ factory: spyOnPuts(new IDBFactory(), log), batchFiles: 2 });
		const writer = await fill(store, key('c1'), { a: '1', b: '2', c: '3', d: '4', e: '5' });
		await writer.complete();
		const flag = log.indexOf('archives:complete=true');
		assert.ok(flag >= 0, log.join(' '));
		assert.equal(log.filter((entry) => entry === 'archives:complete=true').length, 1);
		for (const path of ['a', 'b', 'c', 'd', 'e']) {
			const written = log.indexOf(`files:${path}`);
			assert.ok(written >= 0 && written < flag, `${path} must be written before the flag: ${log.join(' ')}`);
		}
		assert.equal(log.lastIndexOf('archives:complete=true'), log.length - 1);
	});

	it('leaves an archive incomplete, with readable rows, until complete() runs', async () => {
		const { store } = makeStore({ batchFiles: 1 });
		await fill(store, key('c1'), { a: '1', b: '2' });
		const record = await store.getArchive(key('c1'));
		assert.equal(record?.complete, false);
		assert.equal(await store.countFiles(key('c1')), 2);
	});

	it('purges incomplete archives older than the stale age, with their files, and keeps the rest', async () => {
		const { store, clock, factory } = makeStore({ batchFiles: 1 });
		await (await fill(store, key('done'), { a: '1' })).complete();
		await fill(store, key('crashed'), { a: '1', b: '2' });
		clock.now += 60_000;
		await fill(store, key('live'), { a: '1' });
		clock.now += 1_000;

		// A new store over the same database, as after a restart.
		const restarted = new ArchiveStore(factory, { keyRange: IDBKeyRange, now: () => clock.now });
		assert.equal(await restarted.purgeIncomplete(30_000), 1);
		assert.equal(await restarted.getArchive(key('crashed')), undefined);
		assert.equal(await restarted.countFiles(key('crashed')), 0);
		assert.equal((await restarted.getArchive(key('live')))?.complete, false);
		assert.equal((await restarted.getArchive(key('done')))?.complete, true);
		assert.equal(await restarted.countFiles(key('done')), 1);

		assert.equal(await restarted.purgeIncomplete(0), 1);
		assert.equal(await restarted.getArchive(key('live')), undefined);
	});

	it('evicts least-recently-used complete archives until the budget fits', async () => {
		const { store, clock } = makeStore();
		for (const [commit, time] of [['a', 10], ['b', 20], ['c', 30]] as const) {
			clock.now = time;
			await (await fill(store, key(commit), { f: 'x'.repeat(100) })).complete();
		}
		clock.now = 100;
		await store.touch(key('a'));
		const removed = await store.evict(250);
		assert.deepEqual(removed.map((k) => k.commit), ['b']);
		assert.equal(await store.getArchive(key('b')), undefined);
		assert.equal(await store.countFiles(key('b')), 0);
		assert.equal(await store.countFiles(key('a')), 1);
		assert.equal(await store.countFiles(key('c')), 1);
		assert.deepEqual((await store.evict(100)).map((k) => k.commit), ['c']);
		assert.deepEqual((await store.listArchives()).map((r) => r.commit), ['a']);
	});

	it('never evicts incomplete archives or the archive to keep', async () => {
		const { store, clock } = makeStore({ batchFiles: 1 });
		clock.now = 1;
		await (await fill(store, key('old'), { f: 'x'.repeat(100) })).complete();
		clock.now = 2;
		await fill(store, key('partial'), { f: 'x'.repeat(100) });
		clock.now = 3;
		await (await fill(store, key('new'), { f: 'x'.repeat(100) })).complete();
		const removed = await store.evict(0, key('new'));
		assert.deepEqual(removed.map((k) => k.commit), ['old']);
		assert.equal((await store.getArchive(key('partial')))?.complete, false);
		assert.equal(await store.countFiles(key('partial')), 1);
		assert.equal((await store.getArchive(key('new')))?.complete, true);
	});

	it('removes everything written when the write is aborted, and refuses further use', async () => {
		const { store } = makeStore({ batchFiles: 2 });
		const writer = await fill(store, key('c1'), { a: '1', b: '2', c: '3' });
		await writer.abort();
		assert.equal(await store.getArchive(key('c1')), undefined);
		assert.equal(await store.countFiles(key('c1')), 0);
		await assert.rejects(writer.put('d', 'sha', bytes('4')), ArchiveStoreError);
		await assert.rejects(writer.complete(), ArchiveStoreError);
		await writer.abort();
	});

	it('does not abort a completed archive', async () => {
		const { store } = makeStore();
		const writer = await fill(store, key('c1'), { a: '1' });
		await writer.complete();
		await writer.abort();
		assert.equal((await store.getArchive(key('c1')))?.complete, true);
		assert.equal(await store.countFiles(key('c1')), 1);
	});

	it('keeps archives of other commits, repositories and instances apart', async () => {
		const { store } = makeStore();
		const keys = [key('ab'), key('abc'), key('ab', 'other'), { ...key('ab'), instance: 'https://other.example' }, { ...key('ab'), owner: 'p' }];
		for (const k of keys) {
			await (await fill(store, k, { 'dir/file.txt': k.commit + k.repository + k.instance + k.owner })).complete();
		}
		await store.delete(keys[0]);
		assert.equal((await store.getFiles(keys[0], ['dir/file.txt']))[0], undefined);
		for (const k of keys.slice(1)) {
			assert.equal(new TextDecoder().decode((await store.getFiles(k, ['dir/file.txt']))[0]?.content), k.commit + k.repository + k.instance + k.owner);
		}
		assert.equal((await store.listArchives()).length, 4);
	});

	it('keeps rows of a crashed writer when a second writer takes over, and the first can no longer write', async () => {
		const { store, clock } = makeStore({ batchFiles: 1 });
		const first = await fill(store, key('c1'), { a: '1', b: '2' });
		clock.now += 11 * 60_000;
		const second = await store.begin(key('c1'));
		await second.put('b', 'sha-b', bytes('2'));
		await second.put('c', 'sha-c', bytes('3'));
		await assert.rejects(first.put('d', 'sha-d', bytes('4')), ArchiveStoreError);
		await first.abort();
		await second.complete();
		assert.equal(await store.countFiles(key('c1')), 3);
		assert.equal((await store.getArchive(key('c1')))?.complete, true);
	});

	it('refuses a second writer while the first is live, so its abort cannot clobber the first', async () => {
		const { store } = makeStore({ batchFiles: 1 });
		const first = await fill(store, key('c1'), { a: '1', b: '2' });
		await assert.rejects(store.begin(key('c1')), ArchiveStoreError);
		assert.equal(await store.countFiles(key('c1')), 2);
		await first.complete();
		assert.equal((await store.getArchive(key('c1')))?.files, 2);
		await assert.rejects(store.begin(key('c1')), ArchiveStoreError, 'a complete archive is not reopened');
	});

	it('holds one lock per archive across tabs while a writer is open', async () => {
		const held = new Set<string>();
		const locks: ArchiveLocks = {
			request: async (name, _options, callback) => {
				if (held.has(name)) return callback(null);
				held.add(name);
				try {
					return await callback({ name });
				} finally {
					held.delete(name);
				}
			},
		};
		const { store } = makeStore({ locks });
		const first = await store.begin(key('c1'));
		await assert.rejects(store.begin(key('c1')), ArchiveStoreError);
		const other = await store.begin(key('c2'));
		await other.abort();
		await first.abort();
		const second = await store.begin(key('c1'));
		await second.put('a', 'sha-a', bytes('1'));
		await second.complete();
		assert.equal(await store.countFiles(key('c1')), 1);
	});

	it('does not complete an archive whose rows were removed', async () => {
		const { store, factory } = makeStore({ batchFiles: 1 });
		const writer = await fill(store, key('c1'), { a: '1', b: '2' });
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open('gitea-dev-archive', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const tx = db.transaction('files', 'readwrite');
		tx.objectStore('files').delete(IDBKeyRange.bound(['https://git.example/sub', 'o', 'r', 'c1'], ['https://git.example/sub', 'o', 'r', 'c1', []]));
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
		});
		db.close();
		await assert.rejects(writer.complete(), ArchiveStoreError);
		assert.equal((await store.getArchive(key('c1')))?.complete, false);
		await writer.abort();
		assert.equal(await store.getArchive(key('c1')), undefined);
	});

	it('flushes by size as well as by count', async () => {
		const { store } = makeStore({ batchFiles: 1000, batchBytes: 10 });
		const writer = await store.begin(key('c1'));
		await writer.put('big', 'sha', bytes('x'.repeat(50)));
		assert.equal(await store.countFiles(key('c1')), 1);
		await writer.abort();
	});

	it('touch updates only the last-used time', async () => {
		const { store, clock } = makeStore();
		await (await fill(store, key('c1'), { a: '1' })).complete();
		clock.now = 5_000;
		await store.touch(key('c1'));
		const record = await store.getArchive(key('c1'));
		assert.equal(record?.lastUsed, 5_000);
		assert.equal(record?.complete, true);
		await store.touch(key('absent'));
		assert.equal(await store.getArchive(key('absent')), undefined);
	});
});
