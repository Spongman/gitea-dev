import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';

// The shell as the extension bundles it: browser platform, node:zlib stubbed as in scripts/build.mjs.
const entry = `
export { GiteaShell } from './packages/gitea-vscode-web/src/shell/shell.ts';
export { VfsFileSystem } from './packages/gitea-vscode-web/src/shell/fs.ts';
`;

async function bundle(dir: string, alias: Record<string, string>) {
	const outfile = join(dir, 'shell.mjs');
	await build({
		stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
		bundle: true, platform: 'browser', target: 'es2022', format: 'esm', outfile, logLevel: 'silent', alias,
	});
	return outfile;
}

const stub = { 'node:zlib': './packages/gitea-vscode-web/src/shell/zlib-stub.ts' };

describe('bundled shell', () => {
	it('does not bundle without the node:zlib stub', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'shell-bundle-'));
		try {
			await assert.rejects(bundle(dir, {}), /node:zlib/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('bundles into one file with no wasm, worker, script or module loading, and runs', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'shell-bundle-'));
		try {
			const file = await bundle(dir, stub);
			const source = await readFile(file, 'utf8');
			assert.doesNotMatch(source, /\.wasm|importScripts|new Worker|XMLHttpRequest|WebSocket/);
			assert.equal(/import\(\s*["'`]/.test(source), false, 'no dynamic import of a module path');
			assert.doesNotMatch(source, /from\s*["']node:/);
			const { GiteaShell, VfsFileSystem } = await import(pathToFileURL(file).href);
			const content = new Map([['/a.txt', new TextEncoder().encode('hello\n')]]);
			const fs = new VfsFileSystem({
				stat: async (uri: string) => (uri === '/' ? { type: 2, size: 0, mtime: 0 } : { type: 1, size: 6, mtime: 0 }),
				readDirectory: async () => [['a.txt', 1]],
				readFile: async (uri: string) => content.get(uri)!,
				writeFile: async () => undefined, createDirectory: async () => undefined, delete: async () => undefined, rename: async () => undefined,
			}, (path: string) => `/${path}`);
			const shell = new GiteaShell({ fs, label: 'o/r@m', pending: () => [] });
			assert.equal((await shell.run('cat a.txt | wc -c')).stdout.trim(), '6');
			const gz = await shell.run('echo x | gzip');
			assert.notEqual(gz.exitCode, 0);
			assert.match(gz.stderr, /gzip is not available in the browser shell/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
