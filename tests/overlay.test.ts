import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ReadFileOptions, RepositoryChange, RepositoryEntry, RepositoryFile } from '../packages/gitea-repository/src/types.js';
import { AuthRegistry } from '../packages/gitea-vscode-web/src/auth.js';
import { parseDescriptor } from '../packages/gitea-vscode-web/src/descriptor.js';
import {
	ChangeOverlay,
	OverlayError,
	normalizePath,
	overlayIdentity,
	type BaseReader,
	type OverlayChannel,
	type OverlayEvent,
	type OverlayKey,
} from '../packages/gitea-vscode-web/src/overlay.js';
import { SessionRegistry } from '../packages/gitea-vscode-web/src/sessions.js';
import {
	FileOverlayStorage,
	MemoryOverlayStorage,
	type OverlayStorage,
	type StoredKey,
	type StoredRecord,
} from '../packages/gitea-vscode-web/src/storage.js';
import { MemoryStorageFiles } from './helpers/storage-files.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (text: string) => enc.encode(text);

/** Git blob id, computed independently of the code under test. */
function blobSha(content: Uint8Array): string {
	return createHash('sha1')
		.update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
		.digest('hex');
}

class NotFoundError extends Error {
	readonly code = 'not-found';
}

type Kind = 'file' | 'symlink' | 'submodule';

class NotADirectoryError extends Error {
	readonly code = 'not-a-directory';
}

const LFS_OID = 'ab'.repeat(32);

/** In-memory stand-in for the repository module at one commit. */
class FakeRemote implements BaseReader {
	readonly files = new Map<string, { kind: Kind; content: Uint8Array; lfsObject?: Uint8Array }>();
	/** Every path asked of the base, to prove nothing outside the repository is requested. */
	readonly requested: string[] = [];
	/** LFS objects handed out, like media downloads. */
	lfsDownloads = 0;

	/** `lfsObject` makes the file a Git LFS pointer (`content`) to that object. */
	put(path: string, content: string | Uint8Array, kind: Kind = 'file', lfsObject?: string): this {
		this.files.set(path, {
			kind,
			content: typeof content === 'string' ? bytes(content) : content,
			...(lfsObject === undefined ? {} : { lfsObject: bytes(lfsObject) }),
		});
		return this;
	}

	remove(path: string): this {
		this.files.delete(path);
		return this;
	}

	clone(): FakeRemote {
		const copy = new FakeRemote();
		for (const [path, file] of this.files) copy.files.set(path, { ...file });
		return this;
	}

	#isDirectory(path: string): boolean {
		const prefix = path === '' ? '' : `${path}/`;
		return [...this.files.keys()].some((p) => p.startsWith(prefix) && p !== path);
	}

	#entry(path: string): RepositoryEntry {
		this.requested.push(path);
		const name = path.slice(path.lastIndexOf('/') + 1);
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			if (this.files.has(parts.slice(0, i).join('/'))) throw new NotADirectoryError(`not a directory: ${parts.slice(0, i).join('/')}`);
		}
		const file = this.files.get(path);
		if (file) {
			const sha = file.kind === 'submodule' ? 'f'.repeat(40) : blobSha(file.content);
			return { path, name, type: file.kind, sha, size: file.content.length };
		}
		if (path === '' || this.#isDirectory(path)) return { path, name, type: 'directory', sha: 'd'.repeat(40), size: 0 };
		throw new NotFoundError(`not found: ${path}`);
	}

	async getEntry(path: string): Promise<RepositoryEntry> {
		return this.#entry(path);
	}

	async readDirectory(path: string): Promise<RepositoryEntry[]> {
		if (this.#entry(path).type !== 'directory') throw new Error('not a directory');
		const prefix = path === '' ? '' : `${path}/`;
		const names = new Set<string>();
		for (const p of this.files.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
		return [...names].sort().map((name) => this.#entry(`${prefix}${name}`));
	}

	async readFile(path: string, options: ReadFileOptions = {}): Promise<RepositoryFile> {
		const entry = this.#entry(path);
		const file = this.files.get(path);
		if (!file) throw new Error('is a directory');
		if (file.lfsObject === undefined) return { entry, content: file.content.slice() };
		const resolved = options.lfs !== 'pointer';
		if (resolved) this.lfsDownloads++;
		return {
			entry,
			content: (resolved ? file.lfsObject : file.content).slice(),
			lfs: { oid: LFS_OID, size: file.lfsObject.length, resolved },
		};
	}
}

const LFS_BODY = 'the real large content';
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID}\nsize ${LFS_BODY.length}\n`;

function baseRemote(): FakeRemote {
	return new FakeRemote()
		.put('a.txt', 'alpha')
		.put('b.txt', 'bravo')
		.put('src/main.ts', 'main')
		.put('src/lib/util.ts', 'util')
		.put('docs/readme.md', 'readme')
		.put('bin/data.bin', new Uint8Array([0, 255, 1, 128, 0, 7]))
		.put('link', 'a.txt', 'symlink')
		.put('vendor/sub', '', 'submodule')
		.put('big.dat', LFS_POINTER, 'file', LFS_BODY);
}

const KEY: OverlayKey = {
	instance: 'https://git.example/gitea',
	owner: 'alice',
	repository: 'proj',
	ref: 'main',
	baseCommit: 'c1',
};

function open(remote: BaseReader, storage: OverlayStorage = new MemoryOverlayStorage(), key: Partial<OverlayKey> = {}) {
	return ChangeOverlay.open({ key: { ...KEY, ...key }, storage, base: remote });
}

const WRITE = { create: true, overwrite: true };

async function names(overlay: ChangeOverlay, path: string): Promise<string[]> {
	return (await overlay.readDirectory(path)).map((item) => item.name);
}

async function rejectsWith(promise: Promise<unknown>, code: OverlayError['code']): Promise<OverlayError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof OverlayError, `expected OverlayError, got ${String(error)}`);
		assert.equal(error.code, code);
		return error;
	}
	assert.fail(`expected ${code}`);
}

function changesOf(prepared: { changes: RepositoryChange[] }): Record<string, unknown>[] {
	return prepared.changes.map((c) => ({
		type: c.type,
		path: c.path,
		...(c.previousPath ? { previousPath: c.previousPath } : {}),
		...(c.originalSha ? { originalSha: c.originalSha } : {}),
		...(c.content ? { content: dec.decode(c.content) } : {}),
	}));
}

describe('path normalization', () => {
	it('accepts repository-relative paths and the root', () => {
		assert.equal(normalizePath('/'), '');
		assert.equal(normalizePath('/src/a b/\u00fc.ts'), 'src/a b/\u00fc.ts');
	});

	it('rejects traversal, dot segments, .git and control characters', () => {
		for (const bad of ['/../x', 'a/./b', 'a//b'.replace('//', '/./'), '.git/config', 'a/.GIT', 'a\\b', 'a\u0000b']) {
			assert.throws(() => normalizePath(bad), OverlayError, bad);
		}
	});
});

describe('directory projections', () => {
	it('merges created files into base directories and creates implicit parents', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('/src/new.ts', bytes('n'), WRITE);
		await overlay.writeFile('/fresh/deep/x.txt', bytes('x'), WRITE);
		assert.deepEqual(await names(overlay, 'src'), ['lib', 'main.ts', 'new.ts']);
		assert.deepEqual(await names(overlay, ''), [
			'a.txt', 'b.txt', 'big.dat', 'bin', 'docs', 'fresh', 'link', 'src', 'vendor',
		]);
		assert.deepEqual(await names(overlay, 'fresh'), ['deep']);
		assert.equal((await overlay.stat('fresh/deep')).type, 'directory');
	});

	it('removes a base directory once every file under it is deleted', async () => {
		const overlay = await open(baseRemote());
		await overlay.delete('docs/readme.md', { recursive: false });
		assert.ok(!(await names(overlay, '')).includes('docs'));
		await rejectsWith(overlay.stat('docs'), 'NotFound');
		await overlay.writeFile('docs/again.md', bytes('a'), WRITE);
		assert.deepEqual(await names(overlay, 'docs'), ['again.md']);
	});

	it('does not persist empty directories: they are local only and never committed', async () => {
		const overlay = await open(baseRemote());
		await overlay.createDirectory('scratch');
		assert.equal((await overlay.stat('scratch')).type, 'directory');
		assert.deepEqual(await overlay.readDirectory('scratch'), []);
		assert.deepEqual(overlay.list(), []);
		const prepared = await overlay.prepareCommit(baseRemote());
		assert.deepEqual(prepared.changes, []);
		await rejectsWith(overlay.createDirectory('scratch'), 'Exists');
	});

	it('recursive delete removes every file below, base and local', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('src/local.ts', bytes('l'), WRITE);
		await rejectsWith(overlay.delete('src', { recursive: false }), 'NotEmpty');
		await overlay.delete('src', { recursive: true });
		await rejectsWith(overlay.stat('src'), 'NotFound');
		await rejectsWith(overlay.readFile('src/lib/util.ts'), 'NotFound');
		const { changes } = await overlay.prepareCommit(baseRemote());
		assert.deepEqual(
			changes.map((c) => [c.type, c.path]).sort(),
			[['delete', 'src/lib/util.ts'], ['delete', 'src/main.ts']],
		);
		assert.ok(changes.every((c) => c.originalSha === blobSha(bytes(c.path.endsWith('main.ts') ? 'main' : 'util'))));
	});

	it('lets a file replace a directory and refuses files below a file', async () => {
		const overlay = await open(baseRemote());
		await rejectsWith(overlay.writeFile('a.txt/child', bytes('x'), WRITE), 'NotDirectory');
		await rejectsWith(overlay.writeFile('src', bytes('x'), WRITE), 'IsDirectory');
		await overlay.delete('a.txt', { recursive: false });
		await overlay.writeFile('a.txt/child', bytes('x'), WRITE);
		assert.equal((await overlay.stat('a.txt')).type, 'directory');
		assert.equal(dec.decode(await overlay.readFile('a.txt/child')), 'x');
	});

	it('honors create and overwrite flags', async () => {
		const overlay = await open(baseRemote());
		await rejectsWith(overlay.writeFile('nope.txt', bytes('x'), { create: false, overwrite: true }), 'NotFound');
		await rejectsWith(overlay.writeFile('a.txt', bytes('x'), { create: true, overwrite: false }), 'Exists');
	});
});

describe('modifications', () => {
	it('tracks the immutable original sha across repeated edits', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('one'), WRITE);
		await overlay.writeFile('a.txt', bytes('two'), WRITE);
		assert.deepEqual(overlay.list(), [{ path: 'a.txt', status: 'modified', size: 3 }]);
		const prepared = await overlay.prepareCommit(baseRemote());
		assert.deepEqual(changesOf(prepared), [
			{ type: 'update', path: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'two' },
		]);
	});

	it('drops a modification that restores the original content', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('changed'), WRITE);
		await overlay.writeFile('a.txt', bytes('alpha'), WRITE);
		assert.deepEqual(overlay.list(), []);
	});

	it('keeps binary content byte for byte', async () => {
		const overlay = await open(baseRemote());
		const data = new Uint8Array([255, 0, 254, 1, 128, 0]);
		await overlay.writeFile('bin/data.bin', data, WRITE);
		data[0] = 9; // caller mutation must not leak in
		assert.deepEqual([...(await overlay.readFile('bin/data.bin'))], [255, 0, 254, 1, 128, 0]);
		const out = await overlay.readFile('bin/data.bin');
		out[1] = 99; // reader mutation must not leak in
		assert.deepEqual([...(await overlay.readFile('bin/data.bin'))], [255, 0, 254, 1, 128, 0]);
	});

	it('deleting a modified file commits a delete against the original sha', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('changed'), WRITE);
		await overlay.delete('a.txt', { recursive: false });
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'delete', path: 'a.txt', originalSha: blobSha(bytes('alpha')) },
		]);
	});

	it('deleting a created file leaves nothing pending', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await overlay.delete('new.txt', { recursive: false });
		assert.deepEqual(overlay.list(), []);
	});

	it('recreating a deleted base file with new content is a modification', async () => {
		const overlay = await open(baseRemote());
		await overlay.delete('a.txt', { recursive: false });
		await overlay.writeFile('a.txt', bytes('again'), WRITE);
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'update', path: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'again' },
		]);
	});
});

describe('renames', () => {
	it('commits one rename with previousPath and no separate delete', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'renamed.txt', { overwrite: false });
		assert.deepEqual(overlay.list(), [
			{ path: 'renamed.txt', status: 'renamed', previousPath: 'a.txt', size: 5 },
		]);
		await rejectsWith(overlay.stat('a.txt'), 'NotFound');
		assert.equal(dec.decode(await overlay.readFile('renamed.txt')), 'alpha');
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'update', path: 'renamed.txt', previousPath: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'alpha' },
		]);
	});

	it('follows chained renames back to the base path', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'x.txt', { overwrite: false });
		await overlay.rename('x.txt', 'y.txt', { overwrite: false });
		assert.deepEqual(overlay.list().map((c) => [c.status, c.path, c.previousPath]), [['renamed', 'y.txt', 'a.txt']]);
		await overlay.rename('y.txt', 'a.txt', { overwrite: false });
		assert.deepEqual(overlay.list(), []);
		assert.equal(dec.decode(await overlay.readFile('a.txt')), 'alpha');
	});

	it('keeps the rename when the renamed file is edited', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'r.txt', { overwrite: false });
		await overlay.writeFile('r.txt', bytes('edited'), WRITE);
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'update', path: 'r.txt', previousPath: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'edited' },
		]);
	});

	it('renames a modified file as a rename of the original', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('edited'), WRITE);
		await overlay.rename('a.txt', 'r.txt', { overwrite: false });
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'update', path: 'r.txt', previousPath: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'edited' },
		]);
	});

	it('renames a created file as a plain creation', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('n1.txt', bytes('n'), WRITE);
		await overlay.rename('n1.txt', 'n2.txt', { overwrite: false });
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'create', path: 'n2.txt', content: 'n' },
		]);
	});

	it('renames a directory file by file, including local-only files and empty directories', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('src/local.ts', bytes('l'), WRITE);
		await overlay.createDirectory('src/empty');
		await overlay.rename('src', 'lib2', { overwrite: false });
		await rejectsWith(overlay.stat('src'), 'NotFound');
		assert.deepEqual(await names(overlay, 'lib2'), ['empty', 'lib', 'local.ts', 'main.ts']);
		assert.equal(dec.decode(await overlay.readFile('lib2/lib/util.ts')), 'util');
		const { changes } = await overlay.prepareCommit(baseRemote());
		assert.deepEqual(
			changesOf({ changes }).sort((a, b) => String(a.path).localeCompare(String(b.path))),
			[
				{ type: 'create', path: 'lib2/local.ts', content: 'l' },
				{ type: 'update', path: 'lib2/lib/util.ts', previousPath: 'src/lib/util.ts', originalSha: blobSha(bytes('util')), content: 'util' },
				{ type: 'update', path: 'lib2/main.ts', previousPath: 'src/main.ts', originalSha: blobSha(bytes('main')), content: 'main' },
			].sort((a, b) => a.path.localeCompare(b.path)),
		);
	});

	it('refuses to overwrite unless asked, then replaces the target and deletes the source', async () => {
		const overlay = await open(baseRemote());
		await rejectsWith(overlay.rename('a.txt', 'b.txt', { overwrite: false }), 'Exists');
		assert.deepEqual(overlay.list(), []);
		await overlay.rename('a.txt', 'b.txt', { overwrite: true });
		assert.equal(dec.decode(await overlay.readFile('b.txt')), 'alpha');
		const changes = changesOf(await overlay.prepareCommit(baseRemote()));
		assert.deepEqual(
			changes.sort((a, b) => String(a.path).localeCompare(String(b.path))),
			[
				{ type: 'delete', path: 'a.txt', originalSha: blobSha(bytes('alpha')) },
				{ type: 'update', path: 'b.txt', originalSha: blobSha(bytes('bravo')), content: 'alpha' },
			],
		);
	});

	it('overwriting a directory replaces its whole subtree', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('docs', 'src', { overwrite: true });
		assert.deepEqual(await names(overlay, 'src'), ['readme.md']);
		await rejectsWith(overlay.readFile('src/main.ts'), 'NotFound');
	});

	it('rejects moving a directory into itself or over its own parent', async () => {
		const overlay = await open(baseRemote());
		await rejectsWith(overlay.rename('src', 'src/inner', { overwrite: false }), 'Invalid');
		await rejectsWith(overlay.rename('src/lib', 'src', { overwrite: true }), 'Invalid');
		await rejectsWith(overlay.rename('missing', 'x', { overwrite: false }), 'NotFound');
	});

	it('discarding a renamed file restores the original path', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'r.txt', { overwrite: false });
		await overlay.discard('r.txt');
		assert.deepEqual(overlay.list(), []);
		assert.equal(dec.decode(await overlay.readFile('a.txt')), 'alpha');
		await rejectsWith(overlay.stat('r.txt'), 'NotFound');
	});

	it('degrades a rename to a plain creation when the source is recreated', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'r.txt', { overwrite: false });
		await overlay.writeFile('a.txt', bytes('fresh'), WRITE);
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'update', path: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'fresh' },
			{ type: 'create', path: 'r.txt', content: 'alpha' },
		]);
	});
});

describe('submodules', () => {
	it('stat as a read-only entry, read with an error naming the commit, and never change', async () => {
		const overlay = await open(baseRemote());
		const stat = await overlay.stat('vendor/sub');
		assert.deepEqual([stat.type, stat.readonly, stat.size, stat.target], ['submodule', true, 0, undefined]);
		assert.deepEqual((await overlay.readDirectory('vendor')).map((item) => [item.name, item.type]), [['sub', 'submodule']]);
		const error = await rejectsWith(overlay.readFile('vendor/sub'), 'Unsupported');
		assert.match(error.message, new RegExp('f'.repeat(40)));
		await rejectsWith(overlay.readDirectory('vendor/sub'), 'NotDirectory');
		await rejectsWith(overlay.writeFile('vendor/sub', bytes('x'), WRITE), 'ReadOnly');
		await rejectsWith(overlay.delete('vendor', { recursive: true }), 'ReadOnly');
		await rejectsWith(overlay.rename('vendor/sub', 'vendor/s2', { overwrite: false }), 'ReadOnly');
		assert.deepEqual(overlay.list(), []);
	});
});

describe('submodule commit lookup', () => {
	it('gives the target commit of a submodule and nothing else, from the tree alone', async () => {
		const remote = baseRemote();
		const overlay = await open(remote);
		assert.equal(await overlay.submoduleCommit('vendor/sub'), 'f'.repeat(40));
		for (const path of ['a.txt', 'vendor', 'link', 'big.dat', 'missing', 'a.txt/child']) {
			assert.equal(await overlay.submoduleCommit(path), undefined, path);
		}
		assert.equal(remote.lfsDownloads, 0);
	});
});

describe('symlinks', () => {
	function linked(): FakeRemote {
		return baseRemote()
			.put('dir/inner.txt', 'inner text')
			.put('dir/up', '../a.txt', 'symlink')
			.put('link-file', 'dir/inner.txt', 'symlink')
			.put('link-dir', 'dir', 'symlink')
			.put('link-chain', 'link-file', 'symlink')
			.put('link-dangling', 'nowhere/missing', 'symlink')
			.put('link-escape', '../../etc/passwd', 'symlink')
			.put('link-deep-escape', 'dir/../../x', 'symlink')
			.put('link-abs', '/etc/passwd', 'symlink')
			.put('link-git', '.git/config', 'symlink')
			.put('loop-a', 'loop-b', 'symlink')
			.put('loop-b', 'loop-a', 'symlink')
			.put('link-sub', 'vendor/sub', 'symlink');
	}

	it('stat a link as its target type with SymbolicLink, read-only', async () => {
		const overlay = await open(linked());
		const file = await overlay.stat('link-file');
		assert.deepEqual([file.type, file.target, file.size, file.readonly], ['symlink', 'file', 'inner text'.length, true]);
		const dir = await overlay.stat('link-dir');
		assert.deepEqual([dir.type, dir.target, dir.size, dir.readonly], ['symlink', 'directory', 0, true]);
		assert.equal((await overlay.stat('link-chain')).target, 'file');
		assert.equal((await overlay.stat('dir/up')).target, 'file', 'a relative link climbs inside the repository');
	});

	it('lists link entries with their target types', async () => {
		const overlay = await open(linked());
		const items = new Map((await overlay.readDirectory('')).map((item) => [item.name, item]));
		assert.equal(items.get('link-file')?.target, 'file');
		assert.equal(items.get('link-dir')?.target, 'directory');
		assert.equal(items.get('link-dangling')?.type, 'symlink');
		assert.equal(items.get('link-dangling')?.target, undefined);
		assert.equal(items.get('link-sub')?.target, undefined, 'a link to a submodule has no openable target');
		assert.equal(items.get('a.txt')?.target, undefined);
	});

	it('follows links when reading files and listing directories', async () => {
		const overlay = await open(linked());
		assert.equal(dec.decode(await overlay.readFile('link-file')), 'inner text');
		assert.equal(dec.decode(await overlay.readFile('link-chain')), 'inner text');
		assert.equal(dec.decode(await overlay.readFile('dir/up')), 'alpha');
		assert.deepEqual((await overlay.readDirectory('link-dir')).map((item) => item.name), ['inner.txt', 'up']);
		assert.equal(dec.decode(await overlay.readFile('link-dir/inner.txt')), 'inner text');
		const through = await overlay.stat('link-dir/inner.txt');
		assert.deepEqual([through.type, through.readonly], ['file', true]);
		await rejectsWith(overlay.readFile('link-dir'), 'IsDirectory');
		await rejectsWith(overlay.readFile('link-dir/missing.txt'), 'NotFound');
	});

	it('reads a link target with its pending edits', async () => {
		const overlay = await open(linked());
		await overlay.writeFile('dir/inner.txt', bytes('edited'), WRITE);
		assert.equal(dec.decode(await overlay.readFile('link-file')), 'edited');
	});

	it('never changes a link or anything below one, so a commit cannot turn a link into a file', async () => {
		const overlay = await open(linked());
		await rejectsWith(overlay.writeFile('link-file', bytes('x'), WRITE), 'ReadOnly');
		await rejectsWith(overlay.writeFile('link-dir/new.txt', bytes('x'), WRITE), 'ReadOnly');
		await rejectsWith(overlay.writeFile('link-dir/inner.txt', bytes('x'), WRITE), 'ReadOnly');
		await rejectsWith(overlay.createDirectory('link-dir/sub'), 'ReadOnly');
		await rejectsWith(overlay.delete('link-file', { recursive: false }), 'ReadOnly');
		await rejectsWith(overlay.rename('link-file', 'moved', { overwrite: false }), 'ReadOnly');
		await rejectsWith(overlay.rename('a.txt', 'link-file', { overwrite: true }), 'ReadOnly');
		assert.deepEqual(overlay.list(), []);
	});

	it('does not commit over a path that became a link on the remote', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('edited'), WRITE);
		await overlay.writeFile('fresh.txt', bytes('new'), WRITE);
		const head = baseRemote().put('a.txt', 'b.txt', 'symlink').put('fresh.txt', 'b.txt', 'symlink');
		const prepared = await overlay.prepareCommit(head);
		assert.deepEqual(prepared.changes, []);
		assert.deepEqual(prepared.conflicts.map((c) => [c.path, c.kind]), [['a.txt', 'type'], ['fresh.txt', 'created']]);
	});

	it('reports a link that cannot be followed as an unknown-type link and fails to read it', async () => {
		const overlay = await open(linked());
		for (const [path, reason] of [
			['link-dangling', 'missing target'],
			['link-escape', 'outside the repository'],
			['link-deep-escape', 'outside the repository'],
			['link-abs', 'outside the repository'],
			['link-git', 'invalid path'],
			['loop-a', 'too many levels of links'],
		] as const) {
			const stat = await overlay.stat(path);
			assert.deepEqual([stat.type, stat.target, stat.readonly], ['symlink', undefined, true], path);
			const error = await rejectsWith(overlay.readFile(path), 'BrokenLink');
			assert.match(error.message, new RegExp(reason), path);
			await rejectsWith(overlay.readDirectory(path), 'BrokenLink');
		}
		const error = await rejectsWith(overlay.readFile('link-escape'), 'BrokenLink');
		assert.match(error.message, /link-escape -> \.\.\/\.\.\/etc\/passwd/);
		await rejectsWith(overlay.readFile('link-dangling/child'), 'BrokenLink');
	});

	it('never asks the base for a path outside the repository', async () => {
		const remote = linked();
		const overlay = await open(remote);
		for (const path of ['link-escape', 'link-deep-escape', 'link-abs', 'link-git', 'loop-a', 'link-dangling']) {
			await overlay.readFile(path).catch(() => undefined);
			await overlay.stat(path).catch(() => undefined);
		}
		assert.ok(remote.requested.length > 0);
		for (const path of remote.requested) {
			assert.doesNotMatch(path, /(^|\/)\.\.?(\/|$)|^\/|(^|\/)\.git(\/|$)|etc/, path);
		}
	});
});

describe('Git LFS files', () => {
	it('read as the LFS object, or as the stored pointer on request', async () => {
		const remote = baseRemote();
		const overlay = await open(remote);
		assert.equal(dec.decode(await overlay.readFile('big.dat')), LFS_BODY);
		assert.equal(dec.decode(await overlay.readFile('big.dat', { lfs: 'pointer' })), LFS_POINTER);
		assert.equal(remote.lfsDownloads, 1);
	});

	it('stat as read-only without downloading the object, and small ordinary files are not', async () => {
		const remote = baseRemote();
		const overlay = await open(remote);
		const stat = await overlay.stat('big.dat');
		assert.deepEqual([stat.type, stat.readonly, stat.size], ['file', true, LFS_POINTER.length]);
		assert.equal((await overlay.stat('a.txt')).readonly, false);
		assert.equal(remote.lfsDownloads, 0);
	});

	it('refuse edits and renames with a message naming Git LFS, without downloading', async () => {
		const remote = baseRemote();
		const overlay = await open(remote);
		const edit = await rejectsWith(overlay.writeFile('big.dat', bytes('x'), WRITE), 'ReadOnly');
		assert.match(edit.message, /Git LFS/);
		const move = await rejectsWith(overlay.rename('big.dat', 'big2.dat', { overwrite: false }), 'ReadOnly');
		assert.match(move.message, /Git LFS/);
		assert.equal(remote.lfsDownloads, 0);
		assert.deepEqual(overlay.list(), []);
	});

	it('can be deleted, which commits as a delete of the pointer blob', async () => {
		const overlay = await open(baseRemote());
		await overlay.delete('big.dat', { recursive: false });
		const prepared = await overlay.prepareCommit(baseRemote());
		assert.deepEqual(changesOf(prepared), [{ type: 'delete', path: 'big.dat', originalSha: blobSha(bytes(LFS_POINTER)) }]);
	});
});

describe('conflicts', () => {
	it('flags a file changed on the remote and keeps local edits', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		const head = baseRemote().put('a.txt', 'theirs');
		let submitted = 0;
		const error = await rejectsWith(
			overlay.commit({ head, headCommit: 'c2', submit: async () => (submitted++, { sha: 'c3' }) }),
			'Conflict',
		);
		assert.equal(submitted, 0);
		assert.deepEqual(error.conflicts.map((c) => [c.path, c.kind]), [['a.txt', 'modified']]);
		assert.deepEqual(overlay.conflicts.map((c) => c.path), ['a.txt']);
		assert.equal(dec.decode(await overlay.readFile('a.txt')), 'mine');
		assert.equal(overlay.baseCommit, 'c1');
	});

	it('flags a modified file deleted on the remote, and a deletion of a changed file', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.delete('b.txt', { recursive: false });
		const head = baseRemote().remove('a.txt').put('b.txt', 'changed upstream');
		const { conflicts, changes } = await overlay.prepareCommit(head);
		assert.deepEqual(conflicts.map((c) => [c.path, c.kind]).sort(), [['a.txt', 'deleted'], ['b.txt', 'modified']]);
		assert.deepEqual(changes, []);
	});

	it('treats deleting an already-deleted file as nothing to do', async () => {
		const overlay = await open(baseRemote());
		await overlay.delete('a.txt', { recursive: false });
		const prepared = await overlay.prepareCommit(baseRemote().remove('a.txt'));
		assert.deepEqual(prepared, { changes: [], conflicts: [] });
	});

	it('flags a created file that now exists remotely with other content, but not identical content', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('new.txt', bytes('mine'), WRITE);
		const different = await overlay.prepareCommit(baseRemote().put('new.txt', 'theirs'));
		assert.deepEqual(different.conflicts.map((c) => [c.path, c.kind]), [['new.txt', 'created']]);
		const same = await overlay.prepareCommit(baseRemote().put('new.txt', 'mine'));
		assert.deepEqual(same, { changes: [], conflicts: [] });
	});

	it('flags a created file whose parent became a file remotely', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('src/extra/x.ts', bytes('x'), WRITE);
		const head = baseRemote().remove('src/main.ts').remove('src/lib/util.ts').put('src', 'now a file');
		const { conflicts } = await overlay.prepareCommit(head);
		assert.deepEqual(conflicts.map((c) => [c.path, c.kind]), [['src/extra/x.ts', 'type']]);
	});

	it('flags rename sources that changed remotely and rename targets that appeared', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'r1.txt', { overwrite: false });
		await overlay.rename('b.txt', 'r2.txt', { overwrite: false });
		const head = baseRemote().put('a.txt', 'changed upstream').put('r2.txt', 'squatter');
		const { conflicts, changes } = await overlay.prepareCommit(head);
		assert.deepEqual(conflicts.map((c) => [c.path, c.kind]).sort(), [['a.txt', 'modified'], ['r2.txt', 'created']]);
		assert.deepEqual(changes, []);
	});

	it('commits non-overlapping local changes on top of a newer head', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		const head = baseRemote().put('docs/readme.md', 'rewritten upstream');
		const requests: { baseCommit: string; changes: RepositoryChange[] }[] = [];
		const result = await overlay.commit({
			head,
			headCommit: 'c2',
			submit: async (request) => (requests.push(request), { sha: 'c3' }),
		});
		assert.equal(requests.length, 1);
		assert.equal(requests[0].baseCommit, 'c2');
		assert.equal(result.sha, 'c3');
	});
});

describe('commit', () => {
	it('sends every change in one request, then clears pending state and moves the base', async () => {
		const storage = new MemoryOverlayStorage();
		const overlay = await open(baseRemote(), storage);
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await overlay.delete('b.txt', { recursive: false });
		await overlay.rename('docs/readme.md', 'docs/README.md', { overwrite: false });
		const requests: { baseCommit: string; changes: RepositoryChange[] }[] = [];
		const events: OverlayEvent[] = [];
		overlay.onDidChange((event) => events.push(event));
		const result = await overlay.commit({
			head: baseRemote(),
			headCommit: 'c1',
			submit: async (request) => (requests.push(request), { sha: 'c2' }),
		});
		assert.equal(requests.length, 1);
		assert.equal(requests[0].baseCommit, 'c1');
		assert.equal(requests[0].changes.length, 4);
		assert.equal(result.changes, 4);
		assert.deepEqual(overlay.list(), []);
		assert.equal(overlay.baseCommit, 'c2');
		assert.deepEqual(await storage.loadIdentity(overlayIdentity(KEY)), []);
		assert.deepEqual(events.map((e) => e.reason), ['commit']);
	});

	it('keeps all local changes when the submit fails', async () => {
		const storage = new MemoryOverlayStorage();
		const overlay = await open(baseRemote(), storage);
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await assert.rejects(
			overlay.commit({ head: baseRemote(), headCommit: 'c1', submit: async () => { throw new Error('network'); } }),
			/network/,
		);
		assert.equal(overlay.list().length, 1);
		assert.equal(overlay.baseCommit, 'c1');
		assert.equal((await storage.loadIdentity(overlayIdentity(KEY))).length, 1);
	});

	it('refuses an empty commit', async () => {
		const overlay = await open(baseRemote());
		await rejectsWith(
			overlay.commit({ head: baseRemote(), headCommit: 'c1', submit: async () => ({ sha: 'x' }) }),
			'NoChanges',
		);
	});

	it('saves never commit: writing changes nothing remote', async () => {
		let reads = 0;
		const remote = baseRemote();
		const spy: BaseReader = {
			getEntry: (p) => remote.getEntry(p),
			readDirectory: (p) => remote.readDirectory(p),
			readFile: (p) => (reads++, remote.readFile(p)),
		};
		const overlay = await open(spy);
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		assert.equal(overlay.list().length, 1);
		assert.equal(overlay.baseCommit, 'c1');
	});

	it('blocks edits while a commit is in flight so none is lost or half-committed', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('first'), WRITE);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let captured: RepositoryChange[] = [];
		const committing = overlay.commit({
			head: baseRemote(),
			headCommit: 'c1',
			submit: async (request) => {
				captured = request.changes;
				await gate;
				return { sha: 'c2' };
			},
		});
		const late = overlay.writeFile('late.txt', bytes('late'), WRITE);
		release();
		await committing;
		await late;
		assert.deepEqual(captured.map((c) => c.path), ['a.txt']);
		assert.deepEqual(overlay.list().map((c) => c.path), ['late.txt']);
		assert.equal(overlay.baseCommit, 'c2');
	});
});

describe('selective commit', () => {
	const submitTo = (requests: RepositoryChange[][], sha = 'c2', base?: string) => async (request: { changes: RepositoryChange[] }) => {
		requests.push(request.changes);
		return { sha, base };
	};

	it('commits only the selected changes and keeps the rest pending on the new base', async () => {
		const storage = new MemoryOverlayStorage();
		const overlay = await open(baseRemote(), storage);
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await overlay.delete('b.txt', { recursive: false });
		const requests: RepositoryChange[][] = [];
		const result = await overlay.commit({ head: baseRemote(), headCommit: 'c1', paths: ['a.txt'], submit: submitTo(requests) });
		assert.deepEqual(requests.map((r) => r.map((c) => c.path)), [['a.txt']]);
		assert.equal(result.changes, 1);
		assert.deepEqual(overlay.list().map((c) => [c.path, c.status]), [['b.txt', 'deleted'], ['new.txt', 'added']]);
		assert.equal(overlay.baseCommit, 'c2');
		const stored = await storage.loadIdentity(overlayIdentity(KEY));
		assert.deepEqual(stored.map((r) => [r.baseCommit, r.path]).sort(), [['c2', 'b.txt'], ['c2', 'new.txt']]);
	});

	it('ignores conflicts in changes that are not selected', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('b.txt', bytes('also mine'), WRITE);
		const head = baseRemote().put('b.txt', 'changed upstream');
		const requests: RepositoryChange[][] = [];
		await overlay.commit({ head, headCommit: 'c2', paths: ['a.txt'], submit: submitTo(requests) });
		assert.deepEqual(requests[0].map((c) => c.path), ['a.txt']);
		assert.deepEqual(overlay.list().map((c) => c.path), ['b.txt']);
	});

	it('still reports a conflict in a selected change and commits nothing', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('b.txt', bytes('also mine'), WRITE);
		const head = baseRemote().put('b.txt', 'changed upstream');
		const error = await rejectsWith(
			overlay.commit({ head, headCommit: 'c2', paths: ['b.txt'], submit: async () => ({ sha: 'x' }) }),
			'Conflict',
		);
		assert.deepEqual(error.conflicts.map((c) => c.path), ['b.txt']);
		assert.equal(overlay.list().length, 2);
	});

	it('commits a rename as one unit when its new path is selected', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'r.txt', { overwrite: false });
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		const requests: RepositoryChange[][] = [];
		await overlay.commit({ head: baseRemote(), headCommit: 'c1', paths: ['r.txt'], submit: submitTo(requests) });
		assert.deepEqual(requests[0].map((c) => [c.type, c.path, c.previousPath]), [['update', 'r.txt', 'a.txt']]);
		assert.deepEqual(overlay.list().map((c) => c.path), ['new.txt']);
	});

	it('keeps a rename whole when only another change is selected', async () => {
		const overlay = await open(baseRemote());
		await overlay.rename('a.txt', 'r.txt', { overwrite: false });
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		const requests: RepositoryChange[][] = [];
		await overlay.commit({ head: baseRemote(), headCommit: 'c1', paths: ['new.txt'], submit: submitTo(requests) });
		assert.deepEqual(requests[0].map((c) => c.path), ['new.txt']);
		assert.deepEqual(overlay.list().map((c) => [c.status, c.path, c.previousPath]), [['renamed', 'r.txt', 'a.txt']]);
	});

	it('refuses an empty selection and a selection with no pending change', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		for (const paths of [[], ['b.txt']]) {
			await rejectsWith(overlay.commit({ head: baseRemote(), headCommit: 'c1', paths, submit: async () => ({ sha: 'x' }) }), 'NoChanges');
		}
		assert.equal(overlay.list().length, 1);
	});

	it('moves the base to the submitted base, for a commit that went to another branch', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await overlay.commit({ head: baseRemote(), headCommit: 'c1', paths: ['a.txt'], submit: submitTo([], 'other-branch-commit', 'c1') });
		assert.equal(overlay.baseCommit, 'c1');
		assert.deepEqual(overlay.list().map((c) => c.path), ['new.txt']);
	});

	it('keeps an empty local directory on a partial commit', async () => {
		const overlay = await open(baseRemote());
		await overlay.createDirectory('emptydir');
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.commit({ head: baseRemote(), headCommit: 'c1', paths: ['a.txt'], submit: submitTo([]) });
		assert.equal((await overlay.stat('emptydir')).type, 'directory');
	});
});

describe('transferTo', () => {
	it('moves pending changes to another ref at the same base and empties this overlay', async () => {
		const storage = new MemoryOverlayStorage();
		const overlay = await open(baseRemote(), storage);
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.delete('b.txt', { recursive: false });
		await overlay.transferTo('refs/heads/topic');
		assert.deepEqual(overlay.list(), []);
		assert.deepEqual(await storage.loadIdentity(overlayIdentity(KEY)), []);
		const moved = await open(baseRemote(), storage, { ref: 'refs/heads/topic' });
		assert.deepEqual(moved.list().map((c) => [c.path, c.status]), [['a.txt', 'modified'], ['b.txt', 'deleted']]);
		assert.equal(dec.decode(await moved.readFile('a.txt')), 'mine');
	});
});

describe('mutation ordering and events', () => {
	it('serializes concurrent mutations in call order', async () => {
		const overlay = await open(baseRemote());
		await Promise.all([
			overlay.writeFile('x.txt', bytes('1'), WRITE),
			overlay.rename('x.txt', 'y.txt', { overwrite: false }),
			overlay.writeFile('x.txt', bytes('2'), WRITE),
		]);
		assert.equal(dec.decode(await overlay.readFile('y.txt')), '1');
		assert.equal(dec.decode(await overlay.readFile('x.txt')), '2');
		await Promise.all(Array.from({ length: 25 }, (_, i) => overlay.writeFile(`many/${i}.txt`, bytes(String(i)), WRITE)));
		assert.equal((await overlay.readDirectory('many')).length, 25);
	});

	it('does not apply a failed mutation partway', async () => {
		const overlay = await open(baseRemote());
		await rejectsWith(overlay.rename('src', 'link', { overwrite: true }), 'ReadOnly');
		assert.deepEqual(overlay.list(), []);
		assert.equal((await overlay.stat('link')).type, 'symlink');
		assert.deepEqual(await names(overlay, 'src'), ['lib', 'main.ts']);
	});

	it('reports created, changed and deleted from the point of view of the projection', async () => {
		const overlay = await open(baseRemote());
		const seen: string[] = [];
		overlay.onDidChange((event) => seen.push(...event.changes.map((c) => `${event.reason}:${c.type}:${c.path}`)));
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await overlay.writeFile('a.txt', bytes('m'), WRITE);
		await overlay.delete('b.txt', { recursive: false });
		await overlay.discard('new.txt');
		await overlay.discard('b.txt');
		await overlay.discard('a.txt');
		assert.deepEqual(seen, [
			'edit:created:new.txt',
			'edit:changed:a.txt',
			'edit:deleted:b.txt',
			'discard:deleted:new.txt',
			'discard:created:b.txt',
			'discard:changed:a.txt',
		]);
	});

	it('reports directory events for recursive deletes and directory renames', async () => {
		const overlay = await open(baseRemote());
		const seen: string[] = [];
		overlay.onDidChange((event) => seen.push(...event.changes.map((c) => `${c.type}:${c.path}`)));
		await overlay.rename('src', 'moved', { overwrite: false });
		assert.ok(seen.includes('deleted:src'));
		assert.ok(seen.includes('created:moved'));
		assert.ok(seen.includes('created:moved/main.ts'));
		assert.ok(seen.includes('deleted:src/main.ts'));
	});

	it('discard removes a subtree or everything', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('src/new.ts', bytes('n'), WRITE);
		await overlay.delete('src/main.ts', { recursive: false });
		await overlay.writeFile('other.txt', bytes('o'), WRITE);
		await overlay.discard('src');
		assert.deepEqual(overlay.list().map((c) => c.path), ['other.txt']);
		await overlay.discardAll();
		assert.deepEqual(overlay.list(), []);
	});
});

describe('persistence', () => {
	function files(): { storage: () => FileOverlayStorage } {
		const shared = new MemoryStorageFiles();
		return { storage: () => new FileOverlayStorage(shared) };
	}

	it('restores creations, modifications, deletes, renames and binary content after reload', async () => {
		const { storage } = files();
		const first = await open(baseRemote(), storage());
		const binary = new Uint8Array([0, 255, 128, 1, 0, 2]);
		await first.writeFile('new.bin', binary, WRITE);
		await first.writeFile('a.txt', bytes('edited'), WRITE);
		await first.delete('b.txt', { recursive: false });
		await first.rename('docs/readme.md', 'docs/README.md', { overwrite: false });
		await first.createDirectory('scratch');
		const before = first.list();

		const reloaded = await open(baseRemote(), storage());
		assert.deepEqual(reloaded.list(), before);
		assert.deepEqual([...(await reloaded.readFile('new.bin'))], [...binary]);
		assert.equal(dec.decode(await reloaded.readFile('a.txt')), 'edited');
		await rejectsWith(reloaded.stat('b.txt'), 'NotFound');
		assert.equal((await reloaded.stat('scratch')).type, 'directory');
		assert.deepEqual(changesOf(await reloaded.prepareCommit(baseRemote())), changesOf(await first.prepareCommit(baseRemote())));
	});

	it('keeps repositories, refs and instances separate', async () => {
		const { storage } = files();
		const main = await open(baseRemote(), storage());
		await main.writeFile('only-main.txt', bytes('x'), WRITE);
		for (const other of [{ ref: 'dev' }, { repository: 'other' }, { owner: 'bob' }, { instance: 'https://other.example' }]) {
			assert.deepEqual((await open(baseRemote(), storage(), other)).list(), [], JSON.stringify(other));
		}
	});

	it('adopts changes saved against an older base and surfaces remote changes as conflicts', async () => {
		const { storage } = files();
		const old = await open(baseRemote(), storage());
		await old.writeFile('a.txt', bytes('mine'), WRITE);
		await old.writeFile('mine.txt', bytes('new'), WRITE);
		await old.delete('b.txt', { recursive: false });

		const head = baseRemote().put('a.txt', 'theirs');
		const next = await open(head, storage(), { baseCommit: 'c2' });
		assert.deepEqual(next.list().map((c) => [c.path, c.status]), [
			['a.txt', 'modified'],
			['b.txt', 'deleted'],
			['mine.txt', 'added'],
		]);
		assert.equal(dec.decode(await next.readFile('a.txt')), 'mine');
		const { conflicts, changes } = await next.prepareCommit(head);
		assert.deepEqual(conflicts.map((c) => [c.path, c.kind]), [['a.txt', 'modified']]);
		assert.deepEqual(changes.map((c) => c.path).sort(), ['b.txt', 'mine.txt']);

		const rows = await storage().loadIdentity(overlayIdentity(KEY));
		assert.ok(rows.length === 3 && rows.every((row) => row.baseCommit === 'c2'), 'old base rows were moved, not duplicated');
	});

	it('rebase keeps pending changes and original shas under the new base', async () => {
		const { storage } = files();
		const overlay = await open(baseRemote(), storage());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.rebase('c9');
		assert.equal(overlay.baseCommit, 'c9');
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'update', path: 'a.txt', originalSha: blobSha(bytes('alpha')), content: 'mine' },
		]);
		const reloaded = await open(baseRemote(), storage(), { baseCommit: 'c9' });
		assert.equal(reloaded.list().length, 1);
		assert.deepEqual((await storage().loadIdentity(overlayIdentity(KEY))).map((r) => r.baseCommit), ['c9']);
	});

	it('persists before it notifies', async () => {
		const log: string[] = [];
		const inner = new MemoryOverlayStorage();
		const storage: OverlayStorage = {
			loadIdentity: (identity) => inner.loadIdentity(identity),
			apply: async (puts, deletes) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				await inner.apply(puts, deletes);
				log.push('persisted');
			},
		};
		const overlay = await open(baseRemote(), storage);
		log.length = 0;
		let rowsAtEvent = -1;
		overlay.onDidChange(() => {
			log.push('event');
			void inner.loadIdentity(overlayIdentity(KEY)).then((rows) => (rowsAtEvent = rows.length));
		});
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await inner.loadIdentity(overlayIdentity(KEY));
		assert.deepEqual(log, ['persisted', 'event']);
		assert.equal(rowsAtEvent, 1);
	});

	it('leaves state and listeners untouched when persistence fails', async () => {
		const inner = new MemoryOverlayStorage();
		let fail = false;
		const storage: OverlayStorage = {
			loadIdentity: (identity) => inner.loadIdentity(identity),
			apply: (puts: StoredRecord[], deletes: StoredKey[]) =>
				fail ? Promise.reject(new Error('quota exceeded')) : inner.apply(puts, deletes),
		};
		const overlay = await open(baseRemote(), storage);
		await overlay.writeFile('kept.txt', bytes('k'), WRITE);
		let events = 0;
		overlay.onDidChange(() => events++);
		fail = true;
		await assert.rejects(overlay.writeFile('lost.txt', bytes('l'), WRITE), /quota/);
		await assert.rejects(overlay.rename('a.txt', 'z.txt', { overwrite: false }), /quota/);
		await assert.rejects(overlay.delete('b.txt', { recursive: false }), /quota/);
		assert.equal(events, 0);
		assert.deepEqual(overlay.list().map((c) => c.path), ['kept.txt']);
		await rejectsWith(overlay.stat('lost.txt'), 'NotFound');
		fail = false;
		await overlay.writeFile('after.txt', bytes('a'), WRITE);
		assert.deepEqual(overlay.list().map((c) => c.path), ['after.txt', 'kept.txt']);
	});

	it('fails closed when storage cannot load: open rejects instead of starting empty', async () => {
		const storage: OverlayStorage = {
			loadIdentity: () => Promise.reject(new Error('IndexedDB blocked')),
			apply: () => Promise.resolve(),
		};
		await assert.rejects(open(baseRemote(), storage), /IndexedDB blocked/);
	});

	it('discard clears persisted rows too', async () => {
		const { storage } = files();
		const overlay = await open(baseRemote(), storage());
		await overlay.writeFile('new.txt', bytes('n'), WRITE);
		await overlay.discardAll();
		assert.deepEqual(await storage().loadIdentity(overlayIdentity(KEY)), []);
		assert.deepEqual((await open(baseRemote(), storage())).list(), []);
	});
});

describe('default wiring', () => {
	it('SessionRegistry without an injected factory builds the real HTTP repository', async () => {
		const requested: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(String(input instanceof Request ? input.url : input));
			return new Response('{"message":"not found"}', {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;
		try {
			const registry = new SessionRegistry({
				storage: new MemoryOverlayStorage(),
				auth: new AuthRegistry({
					get: async () => undefined,
					set: async () => undefined,
					delete: async () => undefined,
				}),
			});
			const query = JSON.stringify({
				instance: 'https://git.example/gitea',
				owner: 'alice',
				repository: 'proj',
				ref: 'main',
			});
			await assert.rejects(registry.resolve(query), (error: unknown) => {
				assert.ok(!(error instanceof TypeError), `default repository factory missing: ${String(error)}`);
				return true;
			});
			assert.ok(requested.length > 0, 'the default HttpGiteaRepository did not reach fetch');
			assert.ok(requested.every((url) => url.startsWith('https://git.example/gitea/api/')), requested.join('\n'));
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe('launch descriptor', () => {
	const query = (value: object) => JSON.stringify(value);
	const base = { instance: 'https://git.example/gitea/', owner: 'alice', repository: 'proj', ref: 'feature/x y' };

	it('accepts the host query, normalizes the instance and keeps optional hints', () => {
		assert.deepEqual(parseDescriptor(query({ ...base, refKind: 'branch', mode: 'readonly', extra: 1 })), {
			instance: 'https://git.example/gitea',
			owner: 'alice',
			repository: 'proj',
			ref: 'feature/x y',
			refKind: 'branch',
			mode: 'readonly',
		});
		assert.equal(parseDescriptor(encodeURIComponent(query(base))).ref, 'feature/x y');
	});

	it('rejects credentials in any form', () => {
		assert.throws(() => parseDescriptor(query({ ...base, token: 'abc' })), /credentials/);
		assert.throws(() => parseDescriptor(query({ ...base, accessToken: 'abc' })), /credentials/);
		assert.throws(() => parseDescriptor(query({ ...base, instance: 'https://u:p@git.example' })), /credentials/);
	});

	it('rejects bad instances, names and kinds', () => {
		assert.throws(() => parseDescriptor(query({ ...base, instance: 'http://git.example' })), /https/);
		assert.doesNotThrow(() => parseDescriptor(query({ ...base, instance: 'http://127.0.0.1:3000' })));
		assert.throws(() => parseDescriptor(query({ ...base, owner: 'a/b' })), /"\/"/);
		assert.throws(() => parseDescriptor(query({ ...base, refKind: 'weird' })), /refKind/);
		assert.throws(() => parseDescriptor('not json'), /JSON/);
	});
});

describe('base moves under open files', () => {
	async function clocked(remote: FakeRemote) {
		const clock = { now: 1_000 };
		const overlay = await ChangeOverlay.open({ key: KEY, storage: new MemoryOverlayStorage(), base: remote, now: () => clock.now });
		const seen: string[] = [];
		overlay.onDidChange((event) => seen.push(...event.changes.map((c) => `${event.reason}:${c.type}:${c.path}`)));
		return { overlay, clock, seen };
	}

	it('signals a read file that changed under a rebase with an event and a newer mtime', async () => {
		const remote = baseRemote();
		const { overlay, clock, seen } = await clocked(remote);
		await overlay.readFile('a.txt');
		await overlay.readFile('b.txt');
		const before = (await overlay.stat('a.txt')).mtime;
		remote.put('a.txt', 'changed upstream');
		clock.now = 2_000;
		await overlay.rebase('c2');
		assert.deepEqual(seen, ['rebase:changed:a.txt']);
		assert.ok((await overlay.stat('a.txt')).mtime > before, 'a save from a stale buffer must look older than the file');
		assert.equal((await overlay.stat('b.txt')).mtime, before, 'unchanged files keep their mtime');
	});

	it('signals read files changed upstream when a commit moves the base', async () => {
		const remote = baseRemote();
		const { overlay, clock, seen } = await clocked(remote);
		await overlay.readFile('b.txt');
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		seen.length = 0;
		clock.now = 2_000;
		await overlay.commit({
			head: remote,
			headCommit: 'c1',
			submit: async () => {
				remote.put('a.txt', 'mine').put('b.txt', 'changed upstream');
				return { sha: 'c2' };
			},
		});
		assert.deepEqual(seen.sort(), ['commit:changed:a.txt', 'commit:changed:b.txt']);
	});
});

describe('directory records after a partial commit', () => {
	it('lists committed files inside a local directory', async () => {
		const remote = baseRemote();
		const overlay = await open(remote);
		await overlay.createDirectory('newdir');
		await overlay.writeFile('newdir/x.txt', bytes('x'), WRITE);
		await overlay.writeFile('b.txt', bytes('later'), WRITE);
		await overlay.commit({
			head: remote,
			headCommit: 'c1',
			paths: ['newdir/x.txt'],
			submit: async () => {
				remote.put('newdir/x.txt', 'x');
				return { sha: 'c2' };
			},
		});
		assert.deepEqual(await names(overlay, 'newdir'), ['x.txt']);
		assert.deepEqual(overlay.list().map((c) => c.path), ['b.txt']);
	});
});

describe('conflict list upkeep', () => {
	it('drops conflicts of changes that were discarded or deleted', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('new.txt', bytes('mine'), WRITE);
		await overlay.detectConflicts(baseRemote().put('a.txt', 'theirs').put('new.txt', 'theirs'));
		assert.deepEqual(overlay.conflicts.map((c) => c.path), ['a.txt', 'new.txt']);
		await overlay.discard('a.txt');
		await overlay.delete('new.txt', { recursive: false });
		assert.deepEqual(overlay.conflicts, []);
	});

	it('keeps conflicts of changes left pending by a partial commit', async () => {
		const overlay = await open(baseRemote());
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.writeFile('b.txt', bytes('also mine'), WRITE);
		const head = baseRemote().put('b.txt', 'changed upstream');
		await overlay.detectConflicts(head);
		await overlay.commit({ head, headCommit: 'c2', paths: ['a.txt'], submit: async () => ({ sha: 'c3' }) });
		assert.deepEqual(overlay.conflicts.map((c) => c.path), ['b.txt']);
	});
});

describe('commit retry after a lost response', () => {
	it('clears changes the remote head already has and moves to that head', async () => {
		const remote = baseRemote();
		const overlay = await open(remote);
		await overlay.writeFile('a.txt', bytes('mine'), WRITE);
		await overlay.delete('b.txt', { recursive: false });
		await assert.rejects(
			overlay.commit({
				head: remote,
				headCommit: 'c1',
				submit: async () => {
					remote.put('a.txt', 'mine').remove('b.txt');
					throw new Error('response lost');
				},
			}),
			/response lost/,
		);
		const result = await overlay.commit({ head: remote, headCommit: 'c2', submit: async () => assert.fail('nothing is left to send') });
		assert.deepEqual(result, { sha: 'c2', changes: 0 });
		assert.deepEqual(overlay.list(), []);
		assert.equal(overlay.baseCommit, 'c2');
	});
});

describe('directory over a deleted base file', () => {
	it('keeps the deletion when an empty directory replaces the file', async () => {
		const storage = new MemoryOverlayStorage();
		const overlay = await open(baseRemote(), storage);
		await overlay.delete('a.txt', { recursive: false });
		await overlay.createDirectory('a.txt');
		assert.equal((await overlay.stat('a.txt')).type, 'directory');
		assert.deepEqual(await overlay.readDirectory('a.txt'), []);
		assert.deepEqual(overlay.list().map((c) => [c.path, c.status]), [['a.txt', 'deleted']]);
		assert.deepEqual(changesOf(await overlay.prepareCommit(baseRemote())), [
			{ type: 'delete', path: 'a.txt', originalSha: blobSha(bytes('alpha')) },
		]);
		const reloaded = await open(baseRemote(), storage);
		assert.deepEqual(reloaded.list().map((c) => [c.path, c.status]), [['a.txt', 'deleted']]);
		await overlay.discard('a.txt');
		assert.equal(dec.decode(await overlay.readFile('a.txt')), 'alpha');
	});
});

describe('record indexing', () => {
	it('looks up and lists without touching every pending record', async () => {
		let touched = 0;
		const rows: StoredRecord[] = [];
		for (let i = 0; i < 500; i++) {
			const record = { state: 'created', content: bytes('g'), ctime: 1, mtime: 1 } as unknown as StoredRecord['record'];
			Object.defineProperty(record, 'kind', { enumerable: true, get: () => (touched++, 'file') });
			rows.push({ identity: overlayIdentity(KEY), baseCommit: KEY.baseCommit, path: `gen/${i}.txt`, record });
		}
		const storage: OverlayStorage = { loadIdentity: async () => rows, apply: async () => undefined };
		const overlay = await open(baseRemote(), storage);
		touched = 0;
		await overlay.stat('a.txt');
		await overlay.stat('src/main.ts');
		await overlay.readDirectory('src');
		await overlay.readDirectory('');
		assert.ok(touched < 50, `${touched} record reads for four lookups`);
	});
});

describe('commit preparation', () => {
	it('looks up remote entries in parallel', async () => {
		const overlay = await open(baseRemote());
		for (const path of ['a.txt', 'b.txt', 'src/main.ts', 'docs/readme.md']) await overlay.writeFile(path, bytes(`mine ${path}`), WRITE);
		const remote = baseRemote();
		let active = 0;
		let peak = 0;
		const head: BaseReader = {
			getEntry: async (path) => {
				peak = Math.max(peak, ++active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return remote.getEntry(path);
			},
			readDirectory: (path) => remote.readDirectory(path),
			readFile: (path) => remote.readFile(path),
		};
		const { changes } = await overlay.prepareCommit(head);
		assert.deepEqual(changes.map((c) => c.path), ['a.txt', 'b.txt', 'docs/readme.md', 'src/main.ts']);
		assert.ok(peak > 1, `peak concurrency ${peak}`);
	});
});

describe('tabs sharing an overlay', () => {
	/** BroadcastChannel stand-in: delivers to every other channel of the same name, asynchronously. */
	function bus(): OverlayChannel {
		const channels = new Set<{ name: string; receive: (data: unknown) => void }>();
		return (name, receive) => {
			const self = { name, receive };
			channels.add(self);
			return {
				post(data) {
					for (const other of channels) {
						if (other !== self && other.name === name) setTimeout(() => other.receive(structuredClone(data)));
					}
				},
				close() {
					channels.delete(self);
				},
			};
		};
	}

	const next = (overlay: ChangeOverlay) =>
		Promise.race([
			new Promise<OverlayEvent>((resolve) => {
				const off = overlay.onDidChange((event) => (off(), resolve(event)));
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the other tab never reloaded')), 500)),
		]);

	it('reloads changes saved by another tab, and follows its base when it commits', async () => {
		const storage = new MemoryOverlayStorage();
		const channel = bus();
		const remote = baseRemote();
		const a = await ChangeOverlay.open({ key: KEY, storage, base: remote, channel });
		const b = await ChangeOverlay.open({ key: KEY, storage, base: remote, channel });
		let reloaded = next(b);
		await a.writeFile('a.txt', bytes('from tab a'), WRITE);
		assert.deepEqual((await reloaded).changes, [{ path: 'a.txt', type: 'changed' }]);
		assert.equal(dec.decode(await b.readFile('a.txt')), 'from tab a');
		assert.deepEqual(b.list().map((c) => c.path), ['a.txt']);

		reloaded = next(b);
		await a.commit({ head: remote, headCommit: 'c1', submit: async () => (remote.put('a.txt', 'from tab a'), { sha: 'c2' }) });
		await reloaded;
		assert.equal(b.baseCommit, 'c2');
		assert.deepEqual(b.list(), []);
		await b.writeFile('b.txt', bytes('from tab b'), WRITE);
		assert.deepEqual((await storage.loadIdentity(overlayIdentity(KEY))).map((r) => [r.baseCommit, r.path]), [['c2', 'b.txt']]);
	});
});
