import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemorySecretStore, RepositoryError, type SecretStore } from '../packages/gitea-repository/src/index.js';
import { AuthRegistry, type SilentAuthorize } from '../packages/gitea-vscode-web/src/auth.js';

// Behavior required by the silent sign-in task: OAuth tokens live in memory only, the Gitea
// session restores them through one silent authorization per load, and failures fall back
// to interactive sign-in without retrying.

const INSTANCE = 'https://git.example/gitea';
const CONFIG = { clientId: 'client-123', redirectUri: 'https://git.example/gitea/assets/gitea-dev/oauth-callback' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every write so tests can assert what reaches persistent storage. */
class RecordingStore extends MemorySecretStore {
	readonly writes: [string, string][] = [];

	override async set(key: string, value: string): Promise<void> {
		this.writes.push([key, value]);
		await super.set(key, value);
	}
}

/** Token endpoint: each authorization code gets a fresh access token; refreshes are rejected. */
function tokenServer(expiresIn: (issue: number) => number = () => 3600) {
	let issued = 0;
	const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, string>;
		if (body.grant_type === 'authorization_code') {
			issued++;
			return json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: 'bearer', expires_in: expiresIn(issued) });
		}
		return json(400, { error: 'invalid_grant' });
	}) as typeof fetch;
	return { fetch: fetchImpl, issued: () => issued };
}

function callbackFor(url: string): string {
	const request = new URL(url);
	const callback = new URL(request.searchParams.get('redirect_uri')!);
	callback.searchParams.set('code', 'code-1');
	callback.searchParams.set('state', request.searchParams.get('state')!);
	return callback.href;
}

/** Host command stub: records each URL; with `granted`, answers like Gitea with a session and a grant. */
function silent(granted: boolean | (() => boolean)) {
	const urls: string[] = [];
	const authorize: SilentAuthorize = async (url) => {
		urls.push(url);
		return (typeof granted === 'function' ? granted() : granted) ? callbackFor(url) : undefined;
	};
	return { urls, authorize };
}

function registry(options: { secrets?: SecretStore; silent?: SilentAuthorize; expiresIn?: (issue: number) => number } = {}) {
	const server = tokenServer(options.expiresIn);
	const secrets = options.secrets ?? new RecordingStore();
	return { auth: new AuthRegistry(secrets, server.fetch, options.silent), server, secrets };
}

describe('AuthRegistry OAuth storage', () => {
	it('keeps OAuth tokens out of the persistent secret store, while a PAT is persisted', async () => {
		const secrets = new RecordingStore();
		const { auth } = registry({ secrets });
		await auth.signInOAuth(INSTANCE, CONFIG, async (url) => callbackFor(url));
		assert.deepEqual(await auth.forInstance(INSTANCE).headers(), { Authorization: 'Bearer access-1' });
		assert.deepEqual(secrets.writes.filter(([key, value]) => key.includes('oauth') || value.includes('access-1') || value.includes('refresh-1')), []);
		await auth.signInPat(INSTANCE, 'pat-token-value');
		assert.ok(secrets.writes.some(([, value]) => value === 'pat-token-value'));
	});

	it('does not restore an OAuth sign-in from the secret store in a new load', async () => {
		const secrets = new RecordingStore();
		await registry({ secrets }).auth.signInOAuth(INSTANCE, CONFIG, async (url) => callbackFor(url));
		const reloaded = registry({ secrets }).auth;
		await reloaded.restore(INSTANCE, CONFIG);
		assert.equal(reloaded.kind(INSTANCE), undefined);
		assert.deepEqual(await reloaded.forInstance(INSTANCE).headers(), {});
	});
});

describe('AuthRegistry silent sign-in', () => {
	it('signs in silently on restore when OAuth is configured and nobody is signed in', async () => {
		const host = silent(true);
		const { auth } = registry({ silent: host.authorize });
		await auth.restore(INSTANCE, CONFIG);
		assert.equal(auth.kind(INSTANCE), 'oauth');
		assert.deepEqual(await auth.forInstance(INSTANCE).headers(), { Authorization: 'Bearer access-1' });
		assert.equal(host.urls.length, 1);
		const url = new URL(host.urls[0]);
		assert.equal(`${url.origin}${url.pathname}`, `${INSTANCE}/login/oauth/authorize`);
		assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(url.searchParams.get('client_id'), CONFIG.clientId);
	});

	it('stays signed out after a failed silent attempt and does not retry it in the same load', async () => {
		const host = silent(false);
		const { auth } = registry({ silent: host.authorize });
		await auth.restore(INSTANCE, CONFIG);
		await auth.restore(INSTANCE, CONFIG);
		assert.equal(auth.kind(INSTANCE), undefined);
		assert.deepEqual(await auth.forInstance(INSTANCE).headers(), {});
		assert.equal(host.urls.length, 1);
	});

	it('treats a throwing host command as a failed silent attempt', async () => {
		const urls: string[] = [];
		const { auth } = registry({ silent: async (url) => { urls.push(url); throw new Error('host unavailable'); } });
		await auth.restore(INSTANCE, CONFIG);
		assert.equal(urls.length, 1);
		assert.equal(auth.kind(INSTANCE), undefined);
	});

	it('shares one silent attempt between concurrent restores', async () => {
		const host = silent(true);
		const { auth, server } = registry({ silent: host.authorize });
		await Promise.all([auth.restore(INSTANCE, CONFIG), auth.restore(INSTANCE, CONFIG), auth.restore(INSTANCE, CONFIG)]);
		assert.equal(host.urls.length, 1);
		assert.equal(server.issued(), 1);
		assert.equal(auth.kind(INSTANCE), 'oauth');
	});

	it('makes no silent attempt without OAuth configuration or with a stored PAT', async () => {
		const host = silent(true);
		const { auth } = registry({ silent: host.authorize });
		await auth.restore(INSTANCE, undefined);
		assert.equal(host.urls.length, 0);
		const secrets = new RecordingStore();
		await registry({ secrets }).auth.signInPat(INSTANCE, 'pat-token-value');
		const withPat = registry({ secrets, silent: host.authorize }).auth;
		await withPat.restore(INSTANCE, CONFIG);
		assert.equal(withPat.kind(INSTANCE), 'pat');
		assert.equal(host.urls.length, 0);
	});

	it('honors an explicit sign-out across loads until the next interactive OAuth sign-in', async () => {
		const secrets = new RecordingStore();
		const first = registry({ secrets, silent: silent(true).authorize }).auth;
		await first.restore(INSTANCE, CONFIG);
		assert.equal(first.kind(INSTANCE), 'oauth');
		await first.signOut(INSTANCE);
		assert.equal(first.kind(INSTANCE), undefined);

		const afterSignOut = silent(true);
		const second = registry({ secrets, silent: afterSignOut.authorize }).auth;
		await second.restore(INSTANCE, CONFIG);
		assert.equal(second.kind(INSTANCE), undefined);
		assert.equal(afterSignOut.urls.length, 0);
		await second.signInOAuth(INSTANCE, CONFIG, async (url) => callbackFor(url));

		const afterSignIn = silent(true);
		const third = registry({ secrets, silent: afterSignIn.authorize }).auth;
		await third.restore(INSTANCE, CONFIG);
		assert.equal(third.kind(INSTANCE), 'oauth');
		assert.equal(afterSignIn.urls.length, 1);
	});
});

describe('AuthRegistry refresh failure', () => {
	// expires_in 1 s is inside the 30 s refresh skew, so the next headers() call refreshes and is rejected.
	it('re-authorizes silently once when the refresh token is rejected, for all concurrent callers', async () => {
		const host = silent(true);
		const { auth, server } = registry({ silent: host.authorize, expiresIn: (issue) => (issue === 1 ? 1 : 3600) });
		await auth.restore(INSTANCE, CONFIG);
		assert.equal(host.urls.length, 1);
		const provider = auth.forInstance(INSTANCE);
		const renewed = await Promise.all([provider.headers(), provider.headers()]);
		assert.equal(host.urls.length, 2);
		assert.equal(server.issued(), 2);
		assert.deepEqual(renewed, [{ Authorization: 'Bearer access-2' }, { Authorization: 'Bearer access-2' }]);
		assert.equal(auth.kind(INSTANCE), 'oauth');
	});

	it('falls back to signed out when silent re-authorization fails, without retrying', async () => {
		let granted = true;
		const host = silent(() => granted);
		const { auth } = registry({ silent: host.authorize, expiresIn: () => 1 });
		await auth.restore(INSTANCE, CONFIG);
		granted = false;
		const provider = auth.forInstance(INSTANCE);
		await assert.rejects(provider.headers(), (error: unknown) => error instanceof RepositoryError && error.code === 'unauthenticated');
		assert.equal(host.urls.length, 2);
		assert.deepEqual(await provider.headers(), {});
		assert.equal(host.urls.length, 2);
	});

	it('does not loop when the silently renewed token is rejected too', async () => {
		const host = silent(true);
		const { auth } = registry({ silent: host.authorize, expiresIn: () => 1 });
		await auth.restore(INSTANCE, CONFIG);
		await assert.rejects(auth.forInstance(INSTANCE).headers(), (error: unknown) => error instanceof RepositoryError && error.code === 'unauthenticated');
		assert.equal(host.urls.length, 2);
	});

	it('does not re-authorize after a transient refresh failure', async () => {
		const host = silent(true);
		const server = tokenServer(() => 1);
		let down = false;
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => (down ? json(503, {}) : server.fetch(input, init))) as typeof fetch;
		const auth = new AuthRegistry(new RecordingStore(), fetchImpl, host.authorize);
		await auth.restore(INSTANCE, CONFIG);
		down = true;
		await assert.rejects(auth.forInstance(INSTANCE).headers(), (error: unknown) => error instanceof RepositoryError && error.code === 'unavailable');
		assert.equal(host.urls.length, 1);
	});
});

describe('AuthRegistry sign-out during a silent sign-in', () => {
	it('stays signed out when a silent sign-in that was in flight completes afterwards', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let reached!: () => void;
		const asked = new Promise<void>((resolve) => (reached = resolve));
		const { auth } = registry({
			silent: async (url) => {
				reached();
				await gate;
				return callbackFor(url);
			},
		});
		const restoring = auth.restore(INSTANCE, CONFIG);
		await asked;
		await auth.signOut(INSTANCE);
		release();
		await restoring;
		assert.equal(auth.kind(INSTANCE), undefined);
		assert.deepEqual(await auth.forInstance(INSTANCE).headers(), {});
		await auth.restore(INSTANCE, CONFIG);
		assert.equal(auth.kind(INSTANCE), undefined, 'the late tokens were not kept for the next restore');
	});
});
