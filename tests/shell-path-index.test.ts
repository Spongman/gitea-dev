import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VfsFileSystem } from '../packages/gitea-vscode-web/src/shell/fs.js';
import { indexPaths, type PathIndexSource } from '../packages/gitea-vscode-web/src/shell/path-index.js';
import { FakeWorkspaceFs, fakeUri } from './helpers/workspace-fs.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

type Change = { type: string; path: string };
interface FakeSession extends PathIndexSource {
	pending: { path: string; status: string; previousPath?: string }[];
}

function source(trees: Record<string, string[]>) {
	let listener: ((event: { changes: Change[] }) => void) | undefined;
	const session: FakeSession = {
		baseCommit: 'c1',
		pending: [],
		repository: { readTree: async () => (trees[session.baseCommit] ?? []).map((path) => ({ path })) },
		overlay: {
			list: () => session.pending,
			onDidChange: (l) => {
				listener = l;
				return () => undefined;
			},
		},
	};
	return { session, fire: (changes: Change[] = []) => listener?.({ changes }) };
}

describe('indexPaths', () => {
	it('seeds from the tree and applies pending overlay changes', async () => {
		const { session } = source({ c1: ['a.txt', 'src/b.ts'] });
		session.pending = [{ path: 'new.txt', status: 'added' }, { path: 'a.txt', status: 'deleted' }];
		const fs = new VfsFileSystem(new FakeWorkspaceFs(), fakeUri);
		indexPaths(session, fs);
		await settle();
		assert.deepEqual(fs.getAllPaths(), ['/', '/new.txt', '/src', '/src/b.ts']);
	});

	it('reindexes when the base commit changes', async () => {
		const { session, fire } = source({ c1: ['a.txt'], c2: ['b.txt'] });
		const fs = new VfsFileSystem(new FakeWorkspaceFs(), fakeUri);
		indexPaths(session, fs);
		await settle();
		assert.deepEqual(fs.getAllPaths(), ['/', '/a.txt']);
		session.baseCommit = 'c2';
		session.pending = [{ path: 'mine.txt', status: 'added' }];
		fire([{ type: 'changed', path: 'b.txt' }]);
		await settle();
		assert.deepEqual(fs.getAllPaths(), ['/', '/b.txt', '/mine.txt']);
	});
});
