import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileOverlayStorage, type StoredRecord } from '../packages/gitea-vscode-web/src/storage.js';
import { MemoryStorageFiles } from './helpers/storage-files.js';

const deleted = (identity: string, path: string, baseCommit = 'c1'): StoredRecord => ({
	identity,
	baseCommit,
	path,
	record: { kind: 'deleted', originalSha: 'a'.repeat(40), ctime: 1, mtime: 1 },
});

const sorted = (rows: StoredRecord[]) => [...rows].sort((a, b) => (a.path < b.path ? -1 : 1));

describe('FileOverlayStorage', () => {
	it('round-trips every record kind, binary content included, across store instances', async () => {
		const files = new MemoryStorageFiles();
		const rows: StoredRecord[] = [
			{ identity: 'id', baseCommit: 'c1', path: 'a/bin', record: { kind: 'file', state: 'created', content: new Uint8Array([0, 255, 10, 13]), ctime: 1, mtime: 2 } },
			{ identity: 'id', baseCommit: 'c1', path: 'b.txt', record: { kind: 'file', state: 'modified', content: new Uint8Array(0), originalSha: 'b'.repeat(40), renamedFrom: 'old.txt', ctime: 3, mtime: 4 } },
			deleted('id', 'c.txt'),
			{ identity: 'id', baseCommit: 'c2', path: 'd', record: { kind: 'directory', ctime: 5, mtime: 6 } },
		];
		await new FileOverlayStorage(files).apply(rows, []);
		assert.deepEqual(sorted(await new FileOverlayStorage(files).loadIdentity('id')), sorted(rows));
	});

	it('keeps identities separate and loads nothing for an unknown one', async () => {
		const storage = new FileOverlayStorage(new MemoryStorageFiles());
		await storage.apply([deleted('one', 'x'), deleted('two', 'y')], []);
		assert.deepEqual((await storage.loadIdentity('one')).map((row) => row.path), ['x']);
		assert.deepEqual(await storage.loadIdentity('three'), []);
	});

	it('deletes by identity, base commit and path', async () => {
		const storage = new FileOverlayStorage(new MemoryStorageFiles());
		await storage.apply([deleted('id', 'x', 'c1'), deleted('id', 'x', 'c2'), deleted('id', 'y', 'c1')], []);
		await storage.apply([], [{ identity: 'id', baseCommit: 'c1', path: 'x' }]);
		assert.deepEqual(sorted(await storage.loadIdentity('id')).map((row) => [row.baseCommit, row.path]), [['c2', 'x'], ['c1', 'y']]);
	});

	it('keeps a key that is both put and deleted', async () => {
		const storage = new FileOverlayStorage(new MemoryStorageFiles());
		await storage.apply([deleted('id', 'x')], [{ identity: 'id', baseCommit: 'c1', path: 'x' }]);
		assert.deepEqual((await storage.loadIdentity('id')).map((row) => row.path), ['x']);
	});

	it('writes every put before the first delete, so a failed put loses nothing', async () => {
		const files = new MemoryStorageFiles();
		const storage = new FileOverlayStorage(files);
		await storage.apply([deleted('from', 'x')], []);
		const write = files.write.bind(files);
		files.write = async (path, data) => {
			if (path.startsWith('overlay/') && files.files.size > 1) throw new Error('disk full');
			return write(path, data);
		};
		await assert.rejects(storage.apply([deleted('to', 'x'), deleted('to', 'y')], [{ identity: 'from', baseCommit: 'c1', path: 'x' }]), /disk full/);
		assert.deepEqual((await storage.loadIdentity('from')).map((row) => row.path), ['x']);
	});

	it('skips a listed file that is gone by the time it is read', async () => {
		const files = new MemoryStorageFiles();
		const storage = new FileOverlayStorage(files);
		await storage.apply([deleted('id', 'x'), deleted('id', 'y')], []);
		const read = files.read.bind(files);
		let first = true;
		files.read = async (path) => (first ? ((first = false), undefined) : read(path));
		assert.equal((await storage.loadIdentity('id')).length, 1);
	});
});
