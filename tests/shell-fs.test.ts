import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShellFsError, toShellError, VfsFileSystem } from '../packages/gitea-vscode-web/src/shell/fs.js';
import { formatStatus, GiteaShell } from '../packages/gitea-vscode-web/src/shell/shell.js';
import type { PendingChange } from '../packages/gitea-vscode-web/src/overlay.js';
import { FakeFileSystemError, FakeWorkspaceFs, fakeUri } from './helpers/workspace-fs.js';

const tree = () => ({
	'hello.txt': 'Hello Gitea\n',
	'notes.md': 'alpha\nbeta\ngamma\n',
	'src/a.ts': 'export const a = 1;\n',
	'src/deep/b.ts': 'export const b = 2;\n',
	'src/deep/c.txt': 'needle in a haystack\n',
});

function setup(files: Record<string, string | { link: 'file' | 'directory' | undefined }> = tree(), pending: () => PendingChange[] = () => []) {
	const ws = new FakeWorkspaceFs(files);
	const fs = new VfsFileSystem(ws, fakeUri);
	const shell = new GiteaShell({ fs, label: 'owner/repo@main', pending });
	return { ws, fs, shell };
}

const rejectsWith = async (promise: Promise<unknown>, code: string) =>
	assert.rejects(promise, (error: unknown) => error instanceof ShellFsError && error.code === code && error.message.startsWith(`${code}:`));

describe('VfsFileSystem', () => {
	it('stats files, directories and the root, with mtime and size', async () => {
		const { fs } = setup();
		assert.deepEqual(await fs.stat('/hello.txt'), { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: 12, mtime: new Date(1_700_000_000_000) });
		const dir = await fs.stat('/src');
		assert.equal(dir.isDirectory, true);
		assert.equal((await fs.stat('/')).isDirectory, true);
		assert.equal(await fs.exists('/src/a.ts'), true);
		assert.equal(await fs.exists('/nope'), false);
	});

	it('reports read-only entries with read-only modes', async () => {
		const { fs, ws } = setup();
		ws.readonly.add('/hello.txt');
		assert.equal((await fs.stat('/hello.txt')).mode, 0o444);
	});

	it('lists directories with entry types, sorted, and reads text, bytes and encodings', async () => {
		const { fs } = setup({ ...tree(), 'ln': { link: 'file' } });
		assert.deepEqual(await fs.readdir('/'), ['hello.txt', 'ln', 'notes.md', 'src']);
		const types = Object.fromEntries((await fs.readdirWithFileTypes('/')).map((e) => [e.name, [e.isFile, e.isDirectory, e.isSymbolicLink]]));
		assert.deepEqual(types, { 'hello.txt': [true, false, false], ln: [false, false, true], 'notes.md': [true, false, false], src: [false, true, false] });
		assert.equal(await fs.readFile('/hello.txt'), 'Hello Gitea\n');
		assert.equal(await fs.readFile('/hello.txt', 'base64'), btoa('Hello Gitea\n'));
		assert.deepEqual([...(await fs.readFileBuffer('/hello.txt')).slice(0, 5)], [72, 101, 108, 108, 111]);
	});

	it('writes and appends through workspace.fs.writeFile', async () => {
		const { fs, ws } = setup();
		await fs.writeFile('/new.txt', 'one\n');
		await fs.appendFile('/new.txt', 'two\n');
		await fs.appendFile('/created-by-append.txt', 'x');
		assert.equal(ws.text('new.txt'), 'one\ntwo\n');
		assert.equal(ws.text('created-by-append.txt'), 'x');
		assert.deepEqual(ws.calls.filter((call) => call.startsWith('writeFile')), ['writeFile /new.txt', 'writeFile /new.txt', 'writeFile /created-by-append.txt']);
	});

	it('maps errors to errno codes', async () => {
		const { fs } = setup();
		await rejectsWith(fs.readFile('/nope'), 'ENOENT');
		await rejectsWith(fs.readFile('/src'), 'EISDIR');
		await rejectsWith(fs.writeFile('/src', 'x'), 'EISDIR');
		await rejectsWith(fs.writeFile('/missing/dir/x', 'x'), 'ENOENT');
		await rejectsWith(fs.readdir('/hello.txt'), 'ENOTDIR');
		await rejectsWith(fs.stat('/hello.txt/x'), 'ENOENT');
	});

	it('maps FileSystemError codes, keeping the provider message only for permission errors', () => {
		const denied = toShellError(new FakeFileSystemError('NoPermissions', '/x'), 'open', '/x');
		assert.equal(denied.code, 'EACCES');
		assert.match(denied.message, /^EACCES: permission denied, open '\/x': NoPermissions: \/x$/);
		assert.equal(toShellError(new FakeFileSystemError('Unavailable', '/x'), 'open', '/x').code, 'EIO');
		assert.equal(toShellError(new Error('boom'), 'open', '/x').code, 'EIO');
	});

	it('mkdir: plain, recursive, existing and missing parents', async () => {
		const { fs, ws } = setup();
		await fs.mkdir('/out');
		await fs.mkdir('/a/b/c', { recursive: true });
		await fs.mkdir('/src', { recursive: true });
		assert.deepEqual(ws.calls.filter((c) => c.startsWith('createDirectory')), ['createDirectory /out', 'createDirectory /a', 'createDirectory /a/b', 'createDirectory /a/b/c']);
		await rejectsWith(fs.mkdir('/src'), 'EEXIST');
		await rejectsWith(fs.mkdir('/hello.txt'), 'EEXIST');
		await rejectsWith(fs.mkdir('/x/y'), 'ENOENT');
		await rejectsWith(fs.mkdir('/hello.txt/y', { recursive: true }), 'ENOTDIR');
	});

	it('rm: files, directories, force, and non-empty directories', async () => {
		const { fs, ws } = setup();
		await fs.rm('/hello.txt');
		assert.equal(ws.nodes.has('/hello.txt'), false);
		await rejectsWith(fs.rm('/hello.txt'), 'ENOENT');
		await fs.rm('/hello.txt', { force: true });
		await rejectsWith(fs.rm('/src'), 'ENOTEMPTY');
		await fs.rm('/src', { recursive: true });
		assert.deepEqual([...ws.nodes.keys()].filter((p) => p.startsWith('/src')), []);
	});

	it('cp copies files and, with recursive, directories', async () => {
		const { fs, ws } = setup();
		await fs.cp('/hello.txt', '/copy.txt');
		assert.equal(ws.text('copy.txt'), 'Hello Gitea\n');
		await rejectsWith(fs.cp('/src', '/src2'), 'EISDIR');
		await fs.cp('/src', '/src2', { recursive: true });
		assert.equal(ws.text('src2/deep/b.ts'), 'export const b = 2;\n');
		await assert.rejects(fs.cp('/src', '/src/inner', { recursive: true }), /EINVAL/);
	});

	it('mv renames files and directories through workspace.fs.rename', async () => {
		const { fs, ws } = setup();
		await fs.mv('/hello.txt', '/renamed.txt');
		assert.equal(ws.text('renamed.txt'), 'Hello Gitea\n');
		assert.equal(ws.nodes.has('/hello.txt'), false);
		await fs.mv('/src', '/lib');
		assert.equal(ws.text('lib/deep/b.ts'), 'export const b = 2;\n');
		await rejectsWith(fs.mv('/nope', '/x'), 'ENOENT');
		await assert.rejects(fs.mv('/lib', '/lib/inside'), /EINVAL/);
		await rejectsWith(fs.mv('/renamed.txt', '/lib'), 'EISDIR');
		assert.ok(ws.calls.some((call) => call === 'rename /hello.txt /renamed.txt'));
	});

	it('refuses what the overlay cannot represent, naming the reason', async () => {
		const { fs, ws } = setup({ ...tree(), 'ln': { link: 'file' } });
		await assert.rejects(fs.symlink('hello.txt', '/l2'), (e: unknown) => e instanceof ShellFsError && e.code === 'ENOTSUP' && /symbolic links cannot be created/.test(e.message));
		await assert.rejects(fs.link('/hello.txt', '/h2'), (e: unknown) => e instanceof ShellFsError && e.code === 'ENOTSUP' && /hard links cannot be created/.test(e.message));
		await assert.rejects(fs.chmod('/hello.txt', 0o755), (e: unknown) => e instanceof ShellFsError && e.code === 'EPERM' && /does not track file modes/.test(e.message));
		await assert.rejects(fs.utimes('/hello.txt', new Date(), new Date()), (e: unknown) => e instanceof ShellFsError && e.code === 'EPERM' && /modification times/.test(e.message));
		await rejectsWith(fs.chmod('/nope', 0o755), 'ENOENT');
		await assert.rejects(fs.readlink('/ln'), (e: unknown) => e instanceof ShellFsError && e.code === 'ENOTSUP');
		await rejectsWith(fs.readlink('/hello.txt'), 'EINVAL');
		assert.equal(ws.calls.some((c) => /^(writeFile|createDirectory|delete|rename)/.test(c)), false);
	});

	it('follows a link in stat and reports it in lstat; a dangling link does not stat', async () => {
		const { fs } = setup({ ...tree(), file: { link: 'file' }, dir: { link: 'directory' }, dangling: { link: undefined } });
		assert.deepEqual([(await fs.stat('/file')).isFile, (await fs.stat('/file')).isSymbolicLink], [true, false]);
		assert.equal((await fs.stat('/dir')).isDirectory, true);
		const link = await fs.lstat('/file');
		assert.deepEqual([link.isSymbolicLink, link.isFile, link.isDirectory], [true, false, false]);
		await rejectsWith(fs.stat('/dangling'), 'ENOENT');
		assert.equal((await fs.lstat('/dangling')).isSymbolicLink, true);
	});

	it('resolves paths and realpath', async () => {
		const { fs } = setup();
		assert.equal(fs.resolvePath('/src', '../hello.txt'), '/hello.txt');
		assert.equal(fs.resolvePath('/src', '/x/./y//z'), '/x/y/z');
		assert.equal(await fs.realpath('/src/../src/a.ts'), '/src/a.ts');
		await rejectsWith(fs.realpath('/nope'), 'ENOENT');
	});

	it('getAllPaths returns what was learned or listed, and drops removed paths', async () => {
		const { fs } = setup();
		assert.deepEqual(fs.getAllPaths(), ['/']);
		fs.learn(['src/deep/b.ts', 'hello.txt']);
		assert.deepEqual(fs.getAllPaths(), ['/', '/hello.txt', '/src', '/src/deep', '/src/deep/b.ts']);
		await fs.readdir('/src/deep');
		assert.ok(fs.getAllPaths().includes('/src/deep/c.txt'));
		await fs.rm('/src', { recursive: true });
		assert.deepEqual(fs.getAllPaths(), ['/', '/hello.txt']);
		await fs.writeFile('/w.txt', 'x');
		await fs.mkdir('/d/e', { recursive: true });
		await fs.mv('/d', '/d2');
		assert.deepEqual(fs.getAllPaths(), ['/', '/d2', '/d2/e', '/hello.txt', '/w.txt']);
	});
});

describe('GiteaShell over VfsFileSystem', () => {
	it('lists, reads, greps and pipes the repository', async () => {
		const { shell } = setup();
		assert.equal((await shell.run('ls')).stdout, 'hello.txt\nnotes.md\nsrc\n');
		assert.equal((await shell.run('cat hello.txt')).stdout, 'Hello Gitea\n');
		assert.equal((await shell.run('grep -rn needle src')).stdout, 'src/deep/c.txt:1:needle in a haystack\n');
		assert.equal((await shell.run('cat notes.md | grep -c a')).stdout, '3\n');
		assert.equal((await shell.run('find . -name "*.ts" | sort')).stdout, './src/a.ts\n./src/deep/b.ts\n');
		assert.equal((await shell.run('ls src/*.ts')).stdout, 'src/a.ts\n');
	});

	it('writes land in workspace.fs: redirects, append, mkdir, mv, cp, rm', async () => {
		const { shell, ws } = setup();
		assert.equal((await shell.run('echo x > t.txt')).exitCode, 0);
		await shell.run('echo y >> t.txt');
		assert.equal(ws.text('t.txt'), 'x\ny\n');
		await shell.run('mkdir -p out/a && mv t.txt out/a/t.txt && cp -r out out2');
		assert.equal(ws.text('out/a/t.txt'), 'x\ny\n');
		assert.equal(ws.text('out2/a/t.txt'), 'x\ny\n');
		assert.equal(ws.nodes.has('/t.txt'), false);
		assert.equal((await shell.run('rm -r out out2 hello.txt')).exitCode, 0);
		assert.deepEqual([...ws.nodes.keys()].sort(), ['/', '/notes.md', '/src', '/src/a.ts', '/src/deep', '/src/deep/b.ts', '/src/deep/c.txt']);
	});

	it('prints bash-style errors and exit codes', async () => {
		const { shell } = setup();
		assert.deepEqual(await shell.run('cat nope'), { stdout: '', stderr: 'cat: nope: No such file or directory\n', exitCode: 1 });
		assert.equal((await shell.run('rm nope')).stderr, "rm: cannot remove 'nope': No such file or directory\n");
		assert.equal((await shell.run('rm src')).stderr, "rm: cannot remove 'src': Is a directory\n");
		assert.equal((await shell.run('grep needle src')).stderr, 'grep: src: Is a directory\n');
		assert.equal((await shell.run('mkdir src')).stderr, "mkdir: cannot create directory 'src': File exists\n");
		assert.equal((await shell.run('nonesuch')).exitCode, 127);
	});

	it('says why links, chmod and touch on an existing file are refused, and leaves the tree alone', async () => {
		const { shell, ws } = setup();
		const before = JSON.stringify([...ws.nodes.keys()]);
		for (const line of ['ln -s hello.txt l', 'ln hello.txt h', 'chmod +x hello.txt', 'touch hello.txt']) {
			const result = await shell.run(line);
			assert.notEqual(result.exitCode, 0, line);
			assert.match(result.stderr, /overlay/i, line);
		}
		assert.equal(JSON.stringify([...ws.nodes.keys()]), before);
		assert.equal((await shell.run('touch brand-new.txt')).exitCode, 0);
		assert.equal(ws.text('brand-new.txt'), '');
	});

	it('keeps the working directory and variables between lines; the prompt follows', async () => {
		const { shell } = setup();
		assert.equal(shell.prompt(), 'owner/repo@main:~$ ');
		await shell.run('cd src/deep');
		assert.equal(shell.cwd, '/workspace/src/deep');
		assert.equal(shell.prompt(), 'owner/repo@main:~/src/deep$ ');
		assert.equal((await shell.run('pwd')).stdout, '/workspace/src/deep\n');
		assert.equal((await shell.run('cat c.txt')).stdout, 'needle in a haystack\n');
		await shell.run('name=world');
		assert.equal((await shell.run('echo hello $name')).stdout, 'hello world\n');
		await shell.run('cd');
		assert.equal(shell.cwd, '/workspace');
		await shell.run('cd /tmp');
		assert.equal(shell.prompt(), 'owner/repo@main:/tmp$ ');
		assert.equal((await shell.run('cd /nonexistent')).exitCode, 1);
		assert.equal(shell.cwd, '/tmp');
	});

	it('status lists pending changes as A/M/D/R and works in a pipe', async () => {
		const changes: PendingChange[] = [
			{ path: 'new.txt', status: 'added', size: 1 },
			{ path: 'hello.txt', status: 'modified', size: 2 },
			{ path: 'gone.txt', status: 'deleted', size: 0 },
			{ path: 'b.txt', status: 'renamed', previousPath: 'a.txt', size: 3 },
		];
		const { shell } = setup(tree(), () => changes);
		assert.equal((await shell.run('status')).stdout, 'A  new.txt\nM  hello.txt\nD  gone.txt\nR  a.txt -> b.txt\n4 pending change(s); commit them from Source Control.\n');
		assert.equal((await shell.run('status | grep -c "^[AMDR]  "')).stdout, '4\n');
		assert.equal(formatStatus([]), 'No pending changes.\n');
	});

	it('help describes the shell; network, python, node and git are absent', async () => {
		const { shell } = setup();
		const help = (await shell.run('help')).stdout;
		assert.match(help, /status/);
		assert.match(help, /no process|starts no process/);
		for (const line of ['curl http://example.com', 'python3 -c 1', 'js-exec -c 1', 'sqlite3 :memory: "select 1"', 'git status', 'node -e 1', 'wget x']) {
			assert.equal((await shell.run(line)).exitCode, 127, line);
		}
	});

	it('never calls getAllPaths for globs, find, grep -r, ls -R, tree, du, cp -r or rm -r', async () => {
		const ws = new FakeWorkspaceFs(tree());
		const fs = new VfsFileSystem(ws, fakeUri);
		let calls = 0;
		const original = fs.getAllPaths.bind(fs);
		fs.getAllPaths = () => {
			calls++;
			return original();
		};
		const shell = new GiteaShell({ fs, label: 'o/r@m', pending: () => [] });
		const lines = [
			'ls *.txt src/*/*.ts', 'shopt -s globstar; echo **/*.ts', 'find . -type f', 'grep -r needle .', 'rg needle', 'ls -R', 'tree', 'du -a .',
			'cp -r src copy', 'diff -r src copy', 'rm -r copy', 'echo [a-h]*.txt', 'ls src/d*',
		];
		for (const line of lines) await shell.run(line);
		assert.equal(calls, 0);
	});

	it('shell glob and ** reach files that were never listed before', async () => {
		const { shell } = setup();
		assert.equal((await shell.run('shopt -s globstar; echo **/*.ts')).stdout, 'src/a.ts src/deep/b.ts\n');
	});
});

describe('VfsFileSystem path index at scale', () => {
	it('forgets and moves many paths without scanning the whole index each time', () => {
		const { fs } = setup({});
		const paths: string[] = [];
		for (let d = 0; d < 400; d++) for (let f = 0; f < 250; f++) paths.push(`dir${d}/file${f}.txt`);
		fs.learn(paths);
		const started = performance.now();
		for (let d = 0; d < 400; d += 2) fs.forget(`dir${d}`);
		for (let d = 1; d < 400; d += 2) fs.forget(`dir${d}/file7.txt`);
		const elapsed = performance.now() - started;
		assert.equal(fs.getAllPaths().length, 1 + 200 + 200 * 249);
		assert.ok(elapsed < 150, `${elapsed.toFixed(0)} ms for 400 forgets over 100k paths`);
	});

	it('moves a subtree of the index with mv and keeps the rest', async () => {
		const { fs } = setup();
		fs.learn(['src/a.ts', 'src/deep/b.ts', 'srcx/c.ts']);
		await fs.mv('/src', '/moved');
		assert.deepEqual(fs.getAllPaths().filter((p) => p.startsWith('/src') || p.startsWith('/moved')), ['/moved', '/moved/a.ts', '/moved/deep', '/moved/deep/b.ts', '/srcx', '/srcx/c.ts']);
		fs.reset();
		assert.deepEqual(fs.getAllPaths(), ['/']);
		fs.learn(['x/y']);
		assert.deepEqual(fs.getAllPaths(), ['/', '/x', '/x/y']);
	});
});

describe('VfsFileSystem encodings', () => {
	it('rejects invalid base64 with EINVAL instead of a raw DOMException', async () => {
		const { fs } = setup();
		await rejectsWith(fs.writeFile('/b.bin', '***not base64***', 'base64'), 'EINVAL');
		await rejectsWith(fs.appendFile('/hello.txt', '***not base64***', 'base64'), 'EINVAL');
	});

	it('round trips every byte value through binary, hex and base64, also across slice boundaries', async () => {
		const { fs } = setup();
		const bytes = Uint8Array.from({ length: 20_000 }, (_, i) => i % 256);
		await fs.writeFile('/all.bin', bytes);
		const binary = await fs.readFile('/all.bin', 'binary');
		assert.equal(binary.length, 20_000);
		assert.equal(binary.charCodeAt(255), 255);
		const hex = await fs.readFile('/all.bin', 'hex');
		assert.equal(hex.slice(0, 8), '00010203');
		assert.equal(hex.length, 40_000);
		await fs.writeFile('/copy1.bin', binary, 'binary');
		await fs.writeFile('/copy2.bin', hex, 'hex');
		await fs.writeFile('/copy3.bin', await fs.readFile('/all.bin', 'base64'), 'base64');
		for (const name of ['copy1', 'copy2', 'copy3']) assert.deepEqual(await fs.readFileBuffer(`/${name}.bin`), bytes, name);
	});
});
