import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileStagedStore, type StagedStore } from '../packages/gitea-vscode-web/src/staged.js';
import { MemoryStorageFiles } from './helpers/storage-files.js';

function contract(name: string, create: () => { store: StagedStore; reopen: () => StagedStore }) {
	describe(name, () => {
		it('returns nothing for an unknown identity', async () => {
			assert.deepEqual(await create().store.load('a'), []);
		});

		it('keeps a saved set per identity, across a new store instance on the same database', async () => {
			const { store, reopen } = create();
			await store.save('a', ['x.txt', 'y/z.txt']);
			await store.save('b', ['other.txt']);
			assert.deepEqual(await reopen().load('a'), ['x.txt', 'y/z.txt']);
			assert.deepEqual(await reopen().load('b'), ['other.txt']);
		});

		it('replaces the set on save and removes it when saved empty', async () => {
			const { store, reopen } = create();
			await store.save('a', ['x.txt', 'y.txt']);
			await store.save('a', ['y.txt']);
			assert.deepEqual(await reopen().load('a'), ['y.txt']);
			await store.save('a', []);
			assert.deepEqual(await reopen().load('a'), []);
		});
	});
}

contract('FileStagedStore', () => {
	const files = new MemoryStorageFiles();
	return { store: new FileStagedStore(files), reopen: () => new FileStagedStore(files) };
});
