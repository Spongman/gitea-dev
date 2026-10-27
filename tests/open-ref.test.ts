import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LaunchError, validateLaunch } from '../packages/editor-host/src/launch.js';
import { openRefUrl } from '../packages/editor-host/src/open-ref.js';

const current = { instance: 'https://git.example.com/gitea', owner: 'alice', repository: 'demo', ref: 'main', refKind: 'branch' as const };
const page = { origin: 'https://git.example.com', pathname: '/gitea/assets/gitea-dev/index.html' };

describe('openRefUrl', () => {
	it('builds a launch URL for another branch on the same page path', () => {
		const url = openRefUrl(current, { ref: 'feature/x-y', refKind: 'branch' }, page);
		assert.equal(url.pathname, page.pathname);
		assert.deepEqual(Object.fromEntries(url.searchParams), {
			owner: 'alice',
			repository: 'demo',
			ref: 'feature/x-y',
			refKind: 'branch',
		});
		assert.equal(validateLaunch(url, current.instance).ref, 'feature/x-y');
	});

	it('opens tags and commits, and another repository for a fork', () => {
		assert.equal(openRefUrl(current, { ref: 'v1.0', refKind: 'tag' }, page).searchParams.get('refKind'), 'tag');
		const sha = 'a'.repeat(40);
		assert.equal(openRefUrl(current, { ref: sha, refKind: 'commit' }, page).searchParams.get('ref'), sha);
		const fork = openRefUrl(current, { ref: 'fix', refKind: 'branch', owner: 'bob', repository: 'demo-fork' }, page);
		assert.deepEqual([fork.searchParams.get('owner'), fork.searchParams.get('repository')], ['bob', 'demo-fork']);
	});

	it('rejects refs the launch validator rejects', () => {
		for (const ref of ['a..b', '-x', 'has space', 'x.lock', '']) {
			assert.throws(() => openRefUrl(current, { ref, refKind: 'branch' }, page), LaunchError, ref);
		}
		assert.throws(() => openRefUrl(current, { ref: 'zzz', refKind: 'commit' }, page), LaunchError);
	});

	it('rejects a page on another origin or outside the instance sub-path', () => {
		assert.throws(() => openRefUrl(current, { ref: 'x', refKind: 'branch' }, { ...page, origin: 'https://evil.example' }), LaunchError);
		assert.throws(() => openRefUrl(current, { ref: 'x', refKind: 'branch' }, { ...page, pathname: '/other/index.html' }), LaunchError);
	});
});
