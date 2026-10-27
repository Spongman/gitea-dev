import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RepositoryError } from '../packages/gitea-repository/src/index.js';
import {
	compareUrl,
	pullRequestFailure,
	pullRequestText,
	refKindOf,
	refLabel,
	shortRef,
	suggestBranchName,
} from '../packages/gitea-vscode-web/src/branches.js';
import type { Descriptor } from '../packages/gitea-vscode-web/src/descriptor.js';

const base: Descriptor = { instance: 'https://git.example.com/sub', owner: 'o', repository: 'r', ref: 'main' };

describe('ref labels', () => {
	it('labels branches, tags and commits', () => {
		assert.equal(refLabel({ ...base, refKind: 'branch' }), '$(git-branch) main');
		assert.equal(refLabel({ ...base, ref: 'v1.0', refKind: 'tag' }), '$(tag) v1.0');
		assert.equal(refLabel({ ...base, ref: 'a'.repeat(40), refKind: 'commit' }), `$(git-commit) ${'a'.repeat(8)}`);
	});

	it('infers the kind from refs/ prefixes and hex ids when no kind is given', () => {
		assert.equal(refKindOf({ ...base, ref: 'refs/tags/v1' }), 'tag');
		assert.equal(refKindOf({ ...base, ref: 'refs/heads/main' }), 'branch');
		assert.equal(refKindOf({ ...base, ref: 'abcdef1' }), 'commit');
		assert.equal(refKindOf(base), 'branch');
		assert.equal(shortRef({ ...base, ref: 'refs/heads/feature/x' }), 'feature/x');
	});
});

describe('suggestBranchName', () => {
	it('numbers past taken names', () => {
		assert.equal(suggestBranchName('main'), 'main-patch-1');
		assert.equal(suggestBranchName('main', new Set(['main-patch-1', 'main-patch-2'])), 'main-patch-3');
		assert.equal(suggestBranchName('refs/heads/rel/1.0'), 'rel/1.0-patch-1');
	});
});

describe('pull request helpers', () => {
	it('splits the commit message into title and body', () => {
		assert.deepEqual(pullRequestText('  Fix it  '), { title: 'Fix it', body: '' });
		assert.deepEqual(pullRequestText('Fix it\n\nWhy.\nMore.\n'), { title: 'Fix it', body: 'Why.\nMore.' });
	});

	it('links the web compare page with per-segment encoding', () => {
		assert.equal(
			compareUrl('https://git.example.com/sub', 'o w', 'r', 'main', 'feature/x y'),
			'https://git.example.com/sub/o%20w/r/compare/main...feature/x%20y?expand=1',
		);
	});

	it('explains a duplicate, an empty diff and missing permission', () => {
		const err = (status: number) => new RepositoryError('conflict', 'raw', { status });
		assert.match(pullRequestFailure(err(409)), /already open/);
		assert.match(pullRequestFailure(err(422)), /same|no differences/);
		assert.match(pullRequestFailure(err(403)), /not available/);
		assert.equal(pullRequestFailure(err(500)), 'raw');
		assert.equal(pullRequestFailure(new Error('boom')), 'boom');
	});
});
