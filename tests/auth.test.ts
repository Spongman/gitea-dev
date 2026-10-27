import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import {
	GiteaSessionBridgeAuth,
	HttpGiteaRepository,
	MemorySecretStore,
	OAuthError,
	OAuthPkceAuth,
	PersonalAccessTokenAuth,
	RepositoryError,
	SessionBridgeUnavailableError,
	type RepositoryErrorCode,
	type SecretStore,
} from '../packages/gitea-repository/src/index.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function rejectsCode(promise: Promise<unknown>, code: RepositoryErrorCode) {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
		assert.equal(error.code, code, error.message);
		return true;
	});
}

function allOutput(value: unknown): string {
	const error = value as Error;
	return [JSON.stringify(value), String(value), inspect(value, { depth: 5 }), error?.message ?? '', error?.stack ?? ''].join('\n');
}

describe('PersonalAccessTokenAuth', () => {
	const TOKEN = 'abcdef0123456789abcdef0123456789abcdef01';

	it('sends the token as an Authorization header', async () => {
		assert.deepEqual(await new PersonalAccessTokenAuth(TOKEN).headers(), { Authorization: `token ${TOKEN}` });
	});

	it('is anonymous until a token is set and after logout', async () => {
		const auth = new PersonalAccessTokenAuth();
		assert.deepEqual(await auth.headers(), {});
		auth.setToken(TOKEN);
		assert.deepEqual(await auth.headers(), { Authorization: `token ${TOKEN}` });
		await auth.logout();
		assert.deepEqual(await auth.headers(), {});
	});

	it('replaces the token', async () => {
		const auth = new PersonalAccessTokenAuth(TOKEN);
		auth.setToken('another-valid-token-9999');
		assert.deepEqual(await auth.headers(), { Authorization: 'token another-valid-token-9999' });
	});

	it('rejects malformed tokens without echoing them', () => {
		for (const bad of ['', 'short', 'has space in token', 'line\nbreak-token-value', 'x'.repeat(5000), 'tok\u0000en-with-nul']) {
			assert.throws(
				() => new PersonalAccessTokenAuth(bad),
				(error: unknown) => error instanceof RepositoryError && error.code === 'invalid-argument' && !error.message.includes(bad.slice(0, 20) || '\u0001'),
			);
		}
	});

	it('keeps the token out of JSON, strings, inspection and own properties', () => {
		const auth = new PersonalAccessTokenAuth(TOKEN);
		assert.ok(!allOutput(auth).includes(TOKEN));
		assert.ok(!Object.values(auth).some((value) => String(value).includes(TOKEN)));
		assert.ok(!Object.getOwnPropertyNames(auth).some((name) => String((auth as unknown as Record<string, unknown>)[name]).includes(TOKEN)));
		assert.ok(!inspect({ nested: auth, list: [auth] }, { depth: 5 }).includes(TOKEN));
	});

	it('never touches a store or a URL when used by the repository', async () => {
		const urls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			urls.push(String(input));
			return json(404, { message: 'nope' });
		};
		const repository = new HttpGiteaRepository({ instance: 'https://g.example', owner: 'a', repository: 'b', ref: 'main', fetch: fetchImpl, auth: new PersonalAccessTokenAuth(TOKEN) });
		await repository.initialize().catch(() => undefined);
		assert.ok(urls.length > 0 && urls.every((url) => !url.includes(TOKEN)));
	});
});

interface TokenRequest {
	url: string;
	body: Record<string, string>;
	init: RequestInit | undefined;
}

class FakeAuthServer {
	readonly requests: TokenRequest[] = [];
	respond: (request: TokenRequest) => Response | Promise<Response> = () => json(500, {});
	readonly fetch: typeof fetch = async (input, init) => {
		const request: TokenRequest = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')), init };
		this.requests.push(request);
		return this.respond(request);
	};
}

const b64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const INSTANCE = 'https://git.example.com/sub';
const REDIRECT = 'https://git.example.com/sub/web-ide/callback';

function oauthFixture(overrides: { now?: () => number; secrets?: SecretStore; session?: SecretStore; redirectUri?: string } = {}) {
	const server = new FakeAuthServer();
	const secrets = overrides.secrets ?? new MemorySecretStore();
	const session = overrides.session ?? new MemorySecretStore();
	let counter = 0;
	const clock = { time: 1_000_000 };
	const auth = new OAuthPkceAuth({
		instance: INSTANCE,
		clientId: 'client-123',
		redirectUri: overrides.redirectUri ?? REDIRECT,
		secrets,
		session,
		fetch: server.fetch,
		random: (length) => new Uint8Array(length).map((_, i) => (i * 31 + ++counter * 17) & 0xff),
		now: overrides.now ?? (() => clock.time),
	});
	return { auth, server, secrets, session, clock };
}

async function login(fixture: ReturnType<typeof oauthFixture>, tokens: Record<string, unknown> = { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'bearer', expires_in: 3600 }) {
	fixture.server.respond = () => json(200, tokens);
	const { url, state } = await fixture.auth.beginAuthorization();
	await fixture.auth.completeAuthorization(`${REDIRECT}?code=the-code&state=${encodeURIComponent(state)}`);
	return { url, state };
}

describe('OAuthPkceAuth', () => {
	it('builds an S256 PKCE authorization URL without exposing the verifier', async () => {
		const { auth, session, secrets } = oauthFixture();
		const { url, state } = await auth.beginAuthorization();
		const parsed = new URL(url);
		assert.equal(`${parsed.origin}${parsed.pathname}`, `${INSTANCE}/login/oauth/authorize`);
		assert.equal(parsed.searchParams.get('client_id'), 'client-123');
		assert.equal(parsed.searchParams.get('redirect_uri'), REDIRECT);
		assert.equal(parsed.searchParams.get('response_type'), 'code');
		assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(parsed.searchParams.get('state'), state);
		assert.ok(!parsed.searchParams.has('client_secret'));
		const pending = JSON.parse((await session.get([...(await collectKeys(session))][0])) as string) as { verifier: string; state: string };
		assert.equal(parsed.searchParams.get('code_challenge'), b64url(createHash('sha256').update(pending.verifier).digest()));
		assert.ok(!url.includes(pending.verifier), 'verifier never appears in the URL');
		assert.ok(pending.verifier.length >= 43 && /^[A-Za-z0-9_-]+$/.test(pending.verifier), 'RFC 7636 verifier alphabet and length');
		assert.equal(pending.state, state);
		assert.equal((await collectKeys(secrets)).length, 0, 'pending data stays out of the secret store');
	});

	it('exchanges the code with the verifier, stores tokens, and sends a Bearer header', async () => {
		const fixture = oauthFixture();
		const { url } = await login(fixture);
		const request = fixture.server.requests[0];
		assert.equal(request.url, `${INSTANCE}/login/oauth/access_token`);
		assert.deepEqual(Object.keys(request.body).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
		assert.equal(request.body.grant_type, 'authorization_code');
		assert.equal(request.body.code, 'the-code');
		assert.equal(new URL(url).searchParams.get('code_challenge'), b64url(createHash('sha256').update(request.body.code_verifier).digest()));
		assert.ok(!('client_secret' in request.body));
		assert.equal(request.init?.credentials, 'omit');
		assert.equal(request.init?.redirect, 'error');
		assert.deepEqual(await fixture.auth.headers(), { Authorization: 'Bearer access-1' });
		assert.equal(await fixture.auth.isSignedIn(), true);
		assert.equal((await collectKeys(fixture.session)).length, 0, 'pending authorization is consumed');
		assert.equal((await collectKeys(fixture.secrets)).length, 1);
	});

	it('is anonymous before login', async () => {
		const { auth } = oauthFixture();
		assert.deepEqual(await auth.headers(), {});
		assert.equal(await auth.isSignedIn(), false);
	});

	it('restores a login from the secret store in a new instance', async () => {
		const first = oauthFixture();
		await login(first);
		const second = oauthFixture({ secrets: first.secrets });
		assert.deepEqual(await second.auth.headers(), { Authorization: 'Bearer access-1' });
	});

	it('rejects a mismatched state and consumes the pending authorization', async () => {
		const fixture = oauthFixture();
		const { state } = await fixture.auth.beginAuthorization();
		await rejectsCode(fixture.auth.completeAuthorization(`${REDIRECT}?code=c&state=wrong`), 'unauthenticated');
		await rejectsCode(fixture.auth.completeAuthorization(`${REDIRECT}?code=c&state=${state}`), 'unauthenticated');
		assert.equal(fixture.server.requests.length, 0, 'no token request is made');
		assert.deepEqual(await fixture.auth.headers(), {});
	});

	it('rejects a missing state, missing code, and no pending authorization', async () => {
		const fixture = oauthFixture();
		await rejectsCode(fixture.auth.completeAuthorization(`${REDIRECT}?code=c&state=x`), 'unauthenticated');
		const { state } = await fixture.auth.beginAuthorization();
		await rejectsCode(fixture.auth.completeAuthorization(`${REDIRECT}?code=c`), 'unauthenticated');
		await fixture.auth.beginAuthorization();
		await rejectsCode(fixture.auth.completeAuthorization(`${REDIRECT}?state=${state}`), 'unauthenticated');
		await rejectsCode(fixture.auth.completeAuthorization('not a url'), 'unauthenticated');
		assert.equal(fixture.server.requests.length, 0);
	});

	it('requires the callback to match the registered redirect URI exactly', async () => {
		for (const callback of ['https://evil.example/sub/web-ide/callback', 'https://git.example.com/sub/other', 'http://git.example.com/sub/web-ide/callback']) {
			const fixture = oauthFixture();
			const { state } = await fixture.auth.beginAuthorization();
			await rejectsCode(fixture.auth.completeAuthorization(`${callback}?code=c&state=${state}`), 'unauthenticated');
			assert.equal(fixture.server.requests.length, 0);
		}
	});

	it('surfaces authorization errors by code only', async () => {
		const fixture = oauthFixture();
		const { state } = await fixture.auth.beginAuthorization();
		const error = await fixture.auth.completeAuthorization(`${REDIRECT}?error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}&state=${state}`).catch((caught: unknown) => caught);
		assert.ok(error instanceof OAuthError && error.reason === 'access_denied');
		assert.ok(!error.message.includes('script'));
		const weird = oauthFixture();
		const pending = await weird.auth.beginAuthorization();
		const weirdError = await weird.auth.completeAuthorization(`${REDIRECT}?error=${encodeURIComponent('Bad Code!')}&state=${pending.state}`).catch((caught: unknown) => caught);
		assert.ok(weirdError instanceof OAuthError && weirdError.reason === undefined);
	});

	it('expires a pending authorization', async () => {
		const fixture = oauthFixture();
		const { state } = await fixture.auth.beginAuthorization();
		fixture.clock.time += 11 * 60 * 1000;
		await rejectsCode(fixture.auth.completeAuthorization(`${REDIRECT}?code=c&state=${state}`), 'unauthenticated');
		assert.equal(fixture.server.requests.length, 0);
	});

	it('maps token endpoint failures without leaking code, verifier or tokens', async () => {
		for (const response of [json(400, { error: 'invalid_grant', error_description: 'secret-code-the-code' }), json(200, { token_type: 'bearer' }), json(200, { access_token: 'a', token_type: 'mac' }), new Response('<html>', { status: 200 })]) {
			const fixture = oauthFixture();
			const { state } = await fixture.auth.beginAuthorization();
			fixture.server.respond = () => response;
			const error = await fixture.auth.completeAuthorization(`${REDIRECT}?code=the-code&state=${state}`).catch((caught: unknown) => caught);
			assert.ok(error instanceof OAuthError, String(error));
			const verifier = fixture.server.requests[0].body.code_verifier;
			const output = allOutput(error);
			for (const secret of ['the-code', verifier, 'secret-code']) {
				assert.ok(!output.includes(secret), `leaked ${secret}`);
			}
			assert.deepEqual(await fixture.auth.headers(), {});
		}
		const down = oauthFixture();
		const { state } = await down.auth.beginAuthorization();
		down.server.respond = () => json(503, {});
		await rejectsCode(down.auth.completeAuthorization(`${REDIRECT}?code=c&state=${state}`), 'unavailable');
		const offline = oauthFixture();
		const pending = await offline.auth.beginAuthorization();
		offline.server.respond = () => {
			throw new TypeError('fetch failed');
		};
		await rejectsCode(offline.auth.completeAuthorization(`${REDIRECT}?code=c&state=${pending.state}`), 'network');
	});

	it('refreshes an expired token once for concurrent callers and stores the rotated refresh token', async () => {
		const fixture = oauthFixture();
		await login(fixture);
		fixture.clock.time += 3600 * 1000;
		let release: (() => void) | undefined;
		fixture.server.respond = () =>
			new Promise<Response>((resolve) => {
				release = () => resolve(json(200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'bearer', expires_in: 3600 }));
			});
		const calls = Promise.all([fixture.auth.headers(), fixture.auth.headers(), fixture.auth.headers()]);
		for (let i = 0; i < 50 && release === undefined; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		release?.();
		const results = await calls;
		assert.ok(results.every((headers) => headers.Authorization === 'Bearer access-2'));
		const refreshes = fixture.server.requests.filter((request) => request.body.grant_type === 'refresh_token');
		assert.equal(refreshes.length, 1);
		assert.deepEqual(refreshes[0].body, { grant_type: 'refresh_token', client_id: 'client-123', refresh_token: 'refresh-1' });
		const restored = oauthFixture({ secrets: fixture.secrets, now: () => fixture.clock.time });
		fixture.server.requests.length = 0;
		await restored.auth.headers();
		assert.equal(fixture.server.requests.length, 0, 'fresh token restored from the store needs no refresh');
	});

	it('refreshes inside the skew window and keeps the old refresh token when none is rotated', async () => {
		const fixture = oauthFixture();
		await login(fixture);
		fixture.clock.time += 3600 * 1000 - 10_000;
		fixture.server.respond = () => json(200, { access_token: 'access-2', token_type: 'bearer', expires_in: 60 });
		assert.equal((await fixture.auth.headers()).Authorization, 'Bearer access-2');
		fixture.clock.time += 120 * 1000;
		await fixture.auth.headers();
		assert.equal(fixture.server.requests.at(-1)?.body.refresh_token, 'refresh-1');
	});

	it('logs out locally when the refresh token is rejected, but keeps tokens on transient failures', async () => {
		const rejected = oauthFixture();
		await login(rejected);
		rejected.clock.time += 3600 * 1000;
		rejected.server.respond = () => json(400, { error: 'invalid_grant' });
		await rejectsCode(rejected.auth.headers(), 'unauthenticated');
		assert.deepEqual(await rejected.auth.headers(), {});
		assert.equal((await collectKeys(rejected.secrets)).length, 0);

		const transient = oauthFixture();
		await login(transient);
		transient.clock.time += 3600 * 1000;
		transient.server.respond = () => json(503, {});
		await rejectsCode(transient.auth.headers(), 'unavailable');
		transient.server.respond = () => {
			throw new TypeError('fetch failed');
		};
		await rejectsCode(transient.auth.headers(), 'network');
		assert.equal((await collectKeys(transient.secrets)).length, 1, 'tokens kept for a later retry');
		transient.server.respond = () => json(200, { access_token: 'access-3', refresh_token: 'refresh-3', token_type: 'bearer', expires_in: 60 });
		assert.equal((await transient.auth.headers()).Authorization, 'Bearer access-3');
	});

	it('F7: only invalid_grant or invalid_client on 400 or 401 ends the login', async () => {
		const keeps: Array<[string, Response]> = [
			['429', json(429, {})],
			['408', json(408, {})],
			['403', json(403, {})],
			['404', json(404, {})],
			['400 invalid_request', json(400, { error: 'invalid_request' })],
			['401 temporarily_unavailable', json(401, { error: 'temporarily_unavailable' })],
			['429 invalid_grant', json(429, { error: 'invalid_grant' })],
			['malformed 200', new Response('<html>', { status: 200 })],
		];
		for (const [name, response] of keeps) {
			const fixture = oauthFixture();
			await login(fixture);
			fixture.clock.time += 3600 * 1000;
			fixture.server.respond = () => response.clone();
			await assert.rejects(fixture.auth.headers(), RepositoryError, name);
			assert.equal((await collectKeys(fixture.secrets)).length, 1, `${name} must keep the stored tokens`);
		}
		for (const response of [json(400, { error: 'invalid_grant' }), json(401, { error: 'invalid_client' })]) {
			const fixture = oauthFixture();
			await login(fixture);
			fixture.clock.time += 3600 * 1000;
			fixture.server.respond = () => response.clone();
			await rejectsCode(fixture.auth.headers(), 'unauthenticated');
			assert.equal((await collectKeys(fixture.secrets)).length, 0);
		}
	});

	it('F13: reads a token response only up to its size limit', async () => {
		const fixture = oauthFixture();
		const { state } = await fixture.auth.beginAuthorization();
		let pulled = 0;
		fixture.server.respond = () =>
			new Response(new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled += 16 * 1024;
					controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
					if (pulled >= 16 * 1024 * 1024) {
						controller.close();
					}
				},
			}, { highWaterMark: 0 }), { status: 200 });
		await assert.rejects(fixture.auth.completeAuthorization(`${REDIRECT}?code=c&state=${state}`), OAuthError);
		assert.ok(pulled <= 2 * 64 * 1024, `read ${pulled} bytes of an oversized response`);
	});

	it('fails an expired token with no refresh token', async () => {
		const fixture = oauthFixture();
		await login(fixture, { access_token: 'access-1', token_type: 'bearer', expires_in: 60 });
		fixture.clock.time += 120 * 1000;
		await rejectsCode(fixture.auth.headers(), 'unauthenticated');
		assert.deepEqual(await fixture.auth.headers(), {});
	});

	it('treats a token without expires_in as non-expiring', async () => {
		const fixture = oauthFixture();
		await login(fixture, { access_token: 'access-1', token_type: 'bearer' });
		fixture.clock.time += 10 * 365 * 24 * 3600 * 1000;
		assert.equal((await fixture.auth.headers()).Authorization, 'Bearer access-1');
	});

	it('logout clears memory, the secret store and any pending authorization, and sends no request', async () => {
		const fixture = oauthFixture();
		await login(fixture);
		await fixture.auth.beginAuthorization();
		const requests = fixture.server.requests.length;
		await fixture.auth.logout();
		assert.deepEqual(await fixture.auth.headers(), {});
		assert.equal((await collectKeys(fixture.secrets)).length, 0);
		assert.equal((await collectKeys(fixture.session)).length, 0);
		assert.equal(fixture.server.requests.length, requests, 'Gitea has no revocation endpoint');
		const reloaded = oauthFixture({ secrets: fixture.secrets });
		assert.deepEqual(await reloaded.auth.headers(), {});
	});

	it('ignores corrupt stored tokens', async () => {
		const secrets = new MemorySecretStore();
		const fixture = oauthFixture({ secrets });
		await login(fixture);
		const [key] = await collectKeys(secrets);
		await secrets.set(key, '{not json');
		assert.deepEqual(await oauthFixture({ secrets }).auth.headers(), {});
		await secrets.set(key, JSON.stringify({ accessToken: 42 }));
		assert.deepEqual(await oauthFixture({ secrets }).auth.headers(), {});
	});

	it('keeps tokens out of JSON, strings and inspection', async () => {
		const fixture = oauthFixture();
		await login(fixture);
		const output = allOutput(fixture.auth);
		for (const secret of ['access-1', 'refresh-1']) {
			assert.ok(!output.includes(secret));
		}
	});

	it('works end to end as the repository auth provider', async () => {
		const fixture = oauthFixture();
		await login(fixture);
		const seen: Headers[] = [];
		const repository = new HttpGiteaRepository({
			instance: INSTANCE,
			owner: 'a',
			repository: 'b',
			ref: 'main',
			auth: fixture.auth,
			fetch: async (_input, init) => {
				seen.push(new Headers(init?.headers));
				return json(404, { message: 'nope' });
			},
		});
		await repository.initialize().catch(() => undefined);
		assert.equal(seen[0].get('authorization'), 'Bearer access-1');
		await repository.logout();
		assert.deepEqual(await fixture.auth.headers(), {});
	});

	it('validates configuration', () => {
		const base = { instance: INSTANCE, clientId: 'c', redirectUri: REDIRECT, secrets: new MemorySecretStore(), fetch: (async () => json(200, {})) as typeof fetch };
		for (const override of [{ instance: 'https://u:p@host' }, { clientId: '' }, { clientId: 'has space' }, { redirectUri: 'nope' }, { redirectUri: 'javascript:alert(1)' }, { redirectUri: `${REDIRECT}#frag` }]) {
			assert.throws(() => new OAuthPkceAuth({ ...base, ...override }), RepositoryError);
		}
	});
});

async function collectKeys(store: SecretStore): Promise<string[]> {
	// MemorySecretStore keeps its map private; probe the keys the auth class uses.
	const probes = ['tokens', 'pending'].map((suffix) => `gitea-dev:oauth:${encodeURIComponent(INSTANCE)}:${encodeURIComponent('client-123')}:${suffix}`);
	const found: string[] = [];
	for (const key of probes) {
		if ((await store.get(key)) !== undefined) {
			found.push(key);
		}
	}
	return found;
}

describe('GiteaSessionBridgeAuth', () => {
	const DESCRIPTOR = { version: 1, csrfToken: 'csrf-token-0123456789', expiresIn: 600 };

	function bridge(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>, now = { time: 0 }) {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const auth = new GiteaSessionBridgeAuth({
			instance: INSTANCE,
			fetch: async (input, init) => {
				calls.push({ url: String(input), init });
				return respond(String(input), init);
			},
			now: () => now.time,
		});
		return { auth, calls, now };
	}

	it('fails against stock Gitea without falling back to any other credential', async () => {
		const { auth, calls } = bridge(() => json(404, { message: 'not found' }));
		await assert.rejects(auth.headers(), (error: unknown) => error instanceof SessionBridgeUnavailableError && error.code === 'unsupported');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `${INSTANCE}/-/web-ide/session`);
	});

	it('never lets the repository send API requests when the bridge is unavailable', async () => {
		const requests: string[] = [];
		const auth = new GiteaSessionBridgeAuth({
			instance: INSTANCE,
			fetch: async (input) => {
				requests.push(String(input));
				return json(404, { message: 'nope' });
			},
		});
		const repository = new HttpGiteaRepository({ instance: INSTANCE, owner: 'a', repository: 'b', ref: 'main', auth, fetch: async (input) => {
			requests.push(String(input));
			return json(200, {});
		} });
		await rejectsCode(repository.initialize(), 'unsupported');
		assert.ok(requests.every((url) => url.endsWith('/-/web-ide/session')), `unexpected requests: ${requests.join(', ')}`);
	});

	it('returns only a CSRF header, uses same-origin cookies, and caches the descriptor', async () => {
		const { auth, calls } = bridge(() => json(200, DESCRIPTOR));
		assert.deepEqual(await auth.headers(), { 'X-Csrf-Token': DESCRIPTOR.csrfToken });
		assert.deepEqual(await auth.headers(), { 'X-Csrf-Token': DESCRIPTOR.csrfToken });
		assert.equal(calls.length, 1);
		assert.equal(auth.credentials, 'same-origin');
		assert.equal(calls[0].init?.credentials, 'same-origin');
		assert.equal(calls[0].init?.redirect, 'error');
		assert.ok(!new Headers(calls[0].init?.headers).has('authorization'));
	});

	it('re-probes after expiry, invalidate, and logout; coalesces concurrent probes', async () => {
		const { auth, calls, now } = bridge(() => json(200, DESCRIPTOR));
		await Promise.all([auth.headers(), auth.headers(), auth.headers()]);
		assert.equal(calls.length, 1);
		now.time += 601_000;
		await auth.headers();
		assert.equal(calls.length, 2);
		auth.invalidate();
		await auth.headers();
		assert.equal(calls.length, 3);
		await auth.logout();
		await auth.headers();
		assert.equal(calls.length, 4);
	});

	it('caps the descriptor lifetime', async () => {
		const { auth, calls, now } = bridge(() => json(200, { ...DESCRIPTOR, expiresIn: 86_400 }));
		await auth.headers();
		now.time += 6 * 60 * 1000;
		await auth.headers();
		assert.equal(calls.length, 2);
	});

	it('maps signed-out sessions and contract violations', async () => {
		await rejectsCode(bridge(() => json(401, {})).auth.headers(), 'unauthenticated');
		await rejectsCode(bridge(() => json(403, {})).auth.headers(), 'unauthenticated');
		for (const body of [{ version: 2, csrfToken: DESCRIPTOR.csrfToken }, { version: 1 }, { version: 1, csrfToken: 'short' }, { version: 1, csrfToken: 'has space in the token!' }, { ...DESCRIPTOR, expiresIn: -1 }, null, 'text']) {
			await assert.rejects(bridge(() => json(200, body)).auth.headers(), SessionBridgeUnavailableError);
		}
		await assert.rejects(bridge(() => new Response('<html>', { status: 200 })).auth.headers(), SessionBridgeUnavailableError);
		await assert.rejects(bridge(() => json(500, {})).auth.headers(), SessionBridgeUnavailableError);
		await assert.rejects(
			bridge(() => {
				throw new TypeError('fetch failed');
			}).auth.headers(),
			SessionBridgeUnavailableError,
		);
	});

	it('F13: reads a descriptor only up to its size limit', async () => {
		let pulled = 0;
		const { auth } = bridge(() =>
			new Response(new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled += 4 * 1024;
					controller.enqueue(new Uint8Array(4 * 1024).fill(0x20));
					if (pulled >= 8 * 1024 * 1024) {
						controller.close();
					}
				},
			}, { highWaterMark: 0 }), { status: 200 }));
		await assert.rejects(auth.headers(), SessionBridgeUnavailableError);
		assert.ok(pulled <= 2 * 16 * 1024, `read ${pulled} bytes of an oversized descriptor`);
	});

	it('does not remember failures', async () => {
		let up = false;
		const { auth } = bridge(() => (up ? json(200, DESCRIPTOR) : json(404, {})));
		await assert.rejects(auth.headers(), SessionBridgeUnavailableError);
		up = true;
		assert.equal((await auth.headers())['X-Csrf-Token'], DESCRIPTOR.csrfToken);
	});

	it('forwards same-origin credentials and the CSRF header through the repository', async () => {
		const seen: Array<{ credentials?: RequestCredentials; headers: Headers }> = [];
		const auth = new GiteaSessionBridgeAuth({ instance: INSTANCE, fetch: async () => json(200, DESCRIPTOR) });
		const repository = new HttpGiteaRepository({
			instance: INSTANCE,
			owner: 'a',
			repository: 'b',
			ref: 'main',
			auth,
			fetch: async (_input, init) => {
				seen.push({ credentials: init?.credentials, headers: new Headers(init?.headers) });
				return json(404, { message: 'nope' });
			},
		});
		await repository.initialize().catch(() => undefined);
		assert.equal(seen[0].credentials, 'same-origin');
		assert.equal(seen[0].headers.get('x-csrf-token'), DESCRIPTOR.csrfToken);
		assert.equal(seen[0].headers.get('authorization'), null);
	});

	it('validates configuration', () => {
		for (const options of [{ instance: 'nope' }, { instance: INSTANCE, descriptorPath: 'relative' }, { instance: INSTANCE, descriptorPath: '/a?b=1' }, { instance: INSTANCE, descriptorPath: '/a/../b' }, { instance: INSTANCE, descriptorPath: '/a#x' }]) {
			assert.throws(() => new GiteaSessionBridgeAuth({ fetch: (async () => json(200, {})) as typeof fetch, ...options }), RepositoryError);
		}
		assert.doesNotThrow(() => new GiteaSessionBridgeAuth({ instance: INSTANCE, descriptorPath: '/custom/session', fetch: (async () => json(200, {})) as typeof fetch }));
	});
});
