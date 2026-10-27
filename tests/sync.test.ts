import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  GiteaAuthenticationProvider, registerSyncAuthentication, signInWithCommands, tokenFromHeaders,
  type SyncAuthApi, type SyncAuthDeps,
} from '../packages/gitea-vscode-web/src/sync-auth.js';
import { SYNC_SCOPES as EXTENSION_SCOPES } from '../packages/gitea-vscode-web/src/sync-auth.js';
import { AutoSettingsSync, probeVariables, TURN_ON_COMMAND } from '../packages/gitea-vscode-web/src/sync-auto.js';
import { SYNC_PROVIDER_ID, SYNC_SCOPES, syncProductConfiguration } from '../packages/editor-host/src/sync-config.js';
import { acceptSyncQuickInputs, type QuickInputWidget } from '../packages/editor-host/src/sync-turn-on.js';

// Native client protocol: microsoft/vscode e646868227c3e3a9e3f24277c8c7220be42c0be7
// src/vs/platform/userDataSync/common/userDataSyncStoreService.ts. The store is tested in sync-store.test.ts.

const tokenOf = (name: string) => `tok-${name}-0123456789abcdef`;

interface GiteaUser { id: number; login: string; status?: number; body?: string; throws?: boolean; only?: 'Bearer' | 'token'; }
interface Call { url: string; method: string; headers: Record<string, string>; redirect?: string; credentials?: string; }

/** Fake Gitea: token -> user. Records every call it receives. */
function fakeGitea(users: Record<string, GiteaUser>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)), redirect: init?.redirect, credentials: init?.credentials });
    const auth = /^(Bearer|token) (.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '');
    const user = auth ? users[auth[2]] : undefined;
    if (!user || (user.only && user.only !== auth![1])) return new Response('{}', { status: 401 });
    if (user.throws) throw new TypeError('connect ECONNREFUSED');
    if (user.status) return new Response(user.body ?? '{}', { status: user.status });
    return new Response(user.body ?? JSON.stringify({ id: user.id, login: user.login, active: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetcher, users };
}

const DEFAULT_USERS = (): Record<string, GiteaUser> => ({
  [tokenOf('alice')]: { id: 1, login: 'alice' },
  [tokenOf('bob')]: { id: 2, login: 'bob' },
});

// region configuration

const SYNC_URL = 'https://git.example.com/git/assets/gitea-dev/sync/';

test('product configuration is the native configurationSync.store for provider gitea', () => {
  const store = {
    url: SYNC_URL, stableUrl: SYNC_URL, insidersUrl: SYNC_URL,
    canSwitch: false, authenticationProviders: { gitea: { scopes: ['read:user', 'write:user'] } },
  };
  assert.deepEqual(syncProductConfiguration(SYNC_URL), { ...store, web: store });
  assert.equal(SYNC_PROVIDER_ID, 'gitea');
  assert.deepEqual(EXTENSION_SCOPES, SYNC_SCOPES, 'host and extension agree on the scopes');
});

test('the web override leaves gitea as the only provider after the workbench merges product defaults', () => {
  // Default from the pinned workbench.web.main.internal.js ("configurationSync.store":{url:"https://vscode-sync...).
  const defaults = {
    url: 'https://vscode-sync.trafficmanager.net/', stableUrl: 'https://vscode-sync.trafficmanager.net/',
    insidersUrl: 'https://vscode-sync-insiders.trafficmanager.net/', canSwitch: false,
    authenticationProviders: { github: { scopes: ['user:email'] }, microsoft: { scopes: ['openid', 'profile', 'email', 'offline_access'] } },
  };
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  // vs/base/common/objects.ts mixin(destination, source, overwrite = true), as shipped in the bundle (function Wp).
  const mixin = (destination: any, source: any): any => {
    if (!isObject(destination)) return source;
    if (isObject(source)) {
      for (const key of Object.keys(source)) {
        if (key in destination) {
          if (isObject(destination[key]) && isObject(source[key])) mixin(destination[key], source[key]);
          else destination[key] = source[key];
        } else destination[key] = source[key];
      }
    }
    return destination;
  };
  const merged = mixin(structuredClone(defaults), structuredClone(syncProductConfiguration(SYNC_URL)));
  // UserDataSyncStoreManagementService.toUserDataSyncStore (userDataSyncStoreService.ts:85-90): web override is spread.
  const effective = { ...merged, ...merged.web };
  assert.deepEqual(Object.keys(merged.authenticationProviders).sort(), ['gitea', 'github', 'microsoft'], 'without the override GitHub would stay');
  assert.deepEqual(effective.authenticationProviders, { gitea: { scopes: ['read:user', 'write:user'] } });
  assert.equal(effective.url, SYNC_URL);
  assert.equal(effective.canSwitch, false);
});

// endregion

// region sync-auth (extension side)

type Change = { added?: readonly { id: string }[]; removed?: readonly { id: string }[]; changed?: readonly { id: string }[] };

interface FakeEnv {
  api: SyncAuthApi;
  registered: { id: string; label: string; options: unknown }[];
  events: Change[];
  fire(): void;
  deps: SyncAuthDeps;
  creds: { headers: Record<string, string> };
  fetchCalls: Call[];
  users: Record<string, GiteaUser>;
  signIns: number;
  signOuts: number;
  nextSignIn: { headers?: Record<string, string>; ok: boolean };
}

function fakeEnv(users: Record<string, GiteaUser> = DEFAULT_USERS()): FakeEnv {
  const gitea = fakeGitea(users);
  const listeners = new Set<() => void>();
  const env = {
    registered: [] as FakeEnv['registered'], events: [] as FakeEnv['events'], creds: { headers: {} as Record<string, string> },
    signIns: 0, signOuts: 0, nextSignIn: { ok: true } as FakeEnv['nextSignIn'],
    fire: () => listeners.forEach(l => l()), fetchCalls: gitea.calls, users: gitea.users,
  } as FakeEnv;
  env.api = {
    authentication: { registerAuthenticationProvider: (id, label, provider, options) => {
      env.registered.push({ id, label, options });
      (provider as unknown as GiteaAuthenticationProvider).onDidChangeSessions(e => env.events.push(e));
      return { dispose() {} };
    } },
    EventEmitter: class<T> {
      #listeners = new Set<(value: T) => void>();
      event = ((listener: (value: T) => void) => { this.#listeners.add(listener); return { dispose: () => this.#listeners.delete(listener) }; }) as never;
      fire(value: T) { this.#listeners.forEach(l => l(value)); }
      dispose() { this.#listeners.clear(); }
    } as never,
    commands: { executeCommand: async () => undefined } as never,
  };
  env.deps = {
    instance: 'http://git.test/git/',
    headers: async () => ({ ...env.creds.headers }),
    signIn: async () => { env.signIns++; await Promise.resolve(); if (env.nextSignIn.headers) env.creds.headers = env.nextSignIn.headers; return env.nextSignIn.ok; },
    signOut: async () => { env.signOuts++; env.creds.headers = {}; },
    onDidChangeCredentials: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    fetch: gitea.fetcher,
  };
  return env;
}

const PAT = (name: string) => ({ Authorization: `token ${tokenOf(name)}` });
const OAUTH = (name: string) => ({ Authorization: `Bearer ${tokenOf(name)}` });

test('tokenFromHeaders reads PAT and OAuth headers and nothing else', () => {
  assert.equal(tokenFromHeaders({ Authorization: 'token abcdef0123456789' }), 'abcdef0123456789');
  assert.equal(tokenFromHeaders({ authorization: 'Bearer abcdef0123456789' }), 'abcdef0123456789');
  assert.equal(tokenFromHeaders({ Authorization: 'BEARER abcdef0123456789' }), 'abcdef0123456789');
  const rejected: Record<string, string>[] = [{}, { Authorization: '' }, { Authorization: 'Basic abcdef0123456789' }, { Authorization: 'token a b' }, { Authorization: 'token short' }, { 'X-Csrf-Token': 'abcdef0123456789' }];
  for (const bad of rejected) {
    assert.equal(tokenFromHeaders(bad), undefined, JSON.stringify(bad));
  }
});

test('the provider registers as gitea without multiple accounts and signed-out has no sessions', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  assert.deepEqual(env.registered, [{ id: 'gitea', label: 'Gitea', options: { supportsMultipleAccounts: false } }]);
  assert.deepEqual(await provider.getSessions(), []);
  assert.deepEqual(await provider.getSessions(['read:user']), []);
  assert.equal(env.fetchCalls.length, 0, 'no credentials, no network');
  assert.equal(env.signIns, 0, 'getSessions never prompts');
});

test('a signed-in editor exposes one session with the stable Gitea user id and the in-memory token', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.creds.headers = PAT('alice');
  const [session] = await provider.getSessions(['read:user']);
  assert.deepEqual(session, {
    id: 'gitea:1', accessToken: tokenOf('alice'), account: { id: '1', label: 'alice' }, scopes: ['read:user', 'write:user'],
  });
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].url, 'http://git.test/git/api/v1/user');
  assert.equal(env.fetchCalls[0].credentials, 'omit');
  assert.equal(env.fetchCalls[0].redirect, 'error');
  assert.deepEqual(Object.keys(env.fetchCalls[0].headers).sort(), ['accept', 'authorization']);
  assert.equal(env.fetchCalls[0].headers.authorization, `token ${tokenOf('alice')}`, 'the credential header is forwarded as the repository code sends it');
  await provider.getSessions();
  assert.equal(env.fetchCalls.length, 1, 'the same token is validated once');
  assert.ok(!JSON.stringify(provider).includes(tokenOf('alice')), 'token is not reachable by serializing the provider');
  assert.ok(!inspect(provider, { depth: 6, showHidden: true }).includes(tokenOf('alice')), 'token is not reachable by inspecting the provider');
  // An OAuth token of the same Gitea user gives the same account id, so the sync account is stable across sign-in methods.
  env.users[tokenOf('alice-oauth')] = { id: 1, login: 'alice' };
  env.creds.headers = OAUTH('alice-oauth');
  const [oauth] = await provider.getSessions();
  assert.equal(oauth.id, 'gitea:1');
  assert.equal(oauth.accessToken, tokenOf('alice-oauth'));
  assert.deepEqual(env.events.at(-1)!.changed!.map(s => s.id), ['gitea:1'], 'same account, new token: changed, not removed');
});

test('other extensions asking for broader scopes are not given the token', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.creds.headers = PAT('alice');
  assert.deepEqual(await provider.getSessions(['repo']), []);
  assert.deepEqual(await provider.getSessions(['read:user', 'write:repository']), []);
  await assert.rejects(provider.createSession(['repo']), /only provides Settings Sync/);
  assert.equal(env.signIns, 0);
});

test('sessions follow credential changes and fire change events', async () => {
  const env = fakeEnv();
  registerSyncAuthentication(env.api, env.deps);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  env.creds.headers = PAT('alice'); env.fire(); await settle();
  env.creds.headers = PAT('bob'); env.fire(); await settle();
  env.creds.headers = {}; env.fire(); await settle();
  env.fire(); await settle();
  assert.equal(env.events.length, 3, 'unchanged credentials fire nothing');
  assert.deepEqual(env.events[0].added!.map(s => s.id), ['gitea:1']);
  assert.deepEqual(env.events[1].removed!.map(s => s.id), ['gitea:1'], 'another account replaces the first');
  assert.deepEqual(env.events[1].added!.map(s => s.id), ['gitea:2']);
  assert.deepEqual(env.events[2].removed!.map(s => s.id), ['gitea:2']);
});

test('a failing credential read or an unreachable Gitea does not remove the session', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.creds.headers = PAT('alice');
  assert.equal((await provider.getSessions()).length, 1);
  env.deps.headers = async () => { throw new Error('storage unavailable'); };
  assert.equal((await provider.getSessions()).length, 1, 'a credential read error keeps the session');
  env.deps.headers = async () => ({ ...env.creds.headers });
  env.users[tokenOf('flaky')] = { id: 5, login: 'f', throws: true };
  env.creds.headers = PAT('flaky');
  assert.equal((await provider.getSessions())[0]?.id, 'gitea:1', 'a transient network failure keeps the session');
  assert.deepEqual(env.events.map(e => [e.added?.length ?? 0, e.removed?.length ?? 0]), [[1, 0]]);
  env.creds.headers = {};
  assert.deepEqual(await provider.getSessions(), [], 'signed-out credentials still remove it');
  assert.equal(env.events.length, 2);
});

test('createSession reuses existing credentials without prompting', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.creds.headers = PAT('bob');
  assert.equal((await provider.createSession(['read:user'])).account.label, 'bob');
  assert.equal(env.signIns, 0);
});

test('createSession signs in through the existing flow before any repository session, once for concurrent callers', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.nextSignIn = { ok: true, headers: OAUTH('alice') };
  const sessions = await Promise.all([provider.createSession(['read:user']), provider.createSession(['read:user'])]);
  assert.equal(env.signIns, 1);
  assert.equal(sessions[0].id, 'gitea:1');
  assert.equal(sessions[1].id, 'gitea:1');
  assert.equal(env.events.filter(e => e.added).length, 1);
});

test('createSession fails cleanly when sign-in is cancelled or Gitea rejects the token', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.nextSignIn = { ok: false };
  await assert.rejects(provider.createSession(['read:user']), /cancelled/);
  env.nextSignIn = { ok: true, headers: PAT('stranger') };
  await assert.rejects(provider.createSession(['read:user']), /did not accept/);
  assert.deepEqual(await provider.getSessions(), []);
  env.users[tokenOf('flaky')] = { id: 5, login: 'f', throws: true };
  env.creds.headers = PAT('flaky');
  assert.deepEqual(await provider.getSessions(), [], 'a network failure yields no session instead of an error');
  const logged: string[] = [];
  env.deps.log = m => logged.push(m);
  await provider.refresh();
  assert.ok(logged.length > 0 && logged.every(m => !m.includes(tokenOf('flaky'))));
});

test('removeSession signs out of the shared credential and reports the removal', async () => {
  const env = fakeEnv();
  const { provider } = registerSyncAuthentication(env.api, env.deps);
  env.creds.headers = PAT('alice');
  const [session] = await provider.getSessions();
  await provider.removeSession('gitea:999');
  assert.equal(env.signOuts, 0, 'unknown session ids are ignored');
  await provider.removeSession(session.id);
  assert.equal(env.signOuts, 1);
  assert.deepEqual(await provider.getSessions(), []);
  assert.deepEqual(env.events.at(-1)!.removed!.map(s => s.id), ['gitea:1']);
});

test('disposing unregisters the credential listener', async () => {
  const env = fakeEnv();
  const registration = registerSyncAuthentication(env.api, env.deps);
  registration.dispose();
  env.creds.headers = PAT('alice');
  env.fire();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(env.fetchCalls.length, 0);
});

test('signInWithCommands uses OAuth when the host configures it and the token prompt otherwise', async () => {
  const run = async (oauth: unknown, result: unknown) => {
    const executed: string[] = [];
    const ok = await signInWithCommands({ executeCommand: (async (id: string) => {
      executed.push(id);
      return id === 'giteaHost.authConfiguration' ? oauth : result;
    }) as never })();
    return { executed, ok };
  };
  assert.deepEqual(await run({ clientId: 'x', redirectUri: 'y' }, { ok: true }), { executed: ['giteaHost.authConfiguration', 'gitea.signInOAuth'], ok: true });
  assert.deepEqual(await run(undefined, { ok: true }), { executed: ['giteaHost.authConfiguration', 'gitea.signIn'], ok: true });
  assert.equal((await run(undefined, { ok: false, cancelled: true })).ok, false);
  assert.equal((await run(undefined, undefined)).ok, false);
  const failing = await signInWithCommands({ executeCommand: (async (id: string) => { if (id === 'giteaHost.authConfiguration') throw new Error('no handler'); return { ok: true }; }) as never })();
  assert.equal(failing, true, 'a missing OAuth command falls back to the token prompt');
});

// endregion
// region automatic turn-on

const flush = () => new Promise(resolve => setTimeout(resolve, 15));

test('the provider hands the credential\'s own Authorization header to the session listeners', async () => {
  const env = fakeEnv();
  const seen: string[] = [];
  const { provider } = registerSyncAuthentication(env.api, { ...env.deps, onSession: (_session, authorization) => seen.push(authorization) });
  env.creds.headers = PAT('alice');
  await provider.refresh();
  assert.deepEqual(seen, [`token ${tokenOf('alice')}`]);
});

test('the provider reports each newly held session once, restored or signed in', async () => {
  const env = fakeEnv();
  const seen: string[] = [];
  const { provider } = registerSyncAuthentication(env.api, { ...env.deps, onSession: session => seen.push(session.id) });
  await provider.refresh();
  assert.deepEqual(seen, [], 'signed out: nothing to report');
  env.creds.headers = PAT('alice');
  await provider.refresh();
  await provider.getSessions();
  assert.deepEqual(seen, ['gitea:1'], 'the same session is reported once');
  env.users[tokenOf('alice2')] = { id: 1, login: 'alice' };
  env.creds.headers = OAUTH('alice2');
  await provider.refresh();
  assert.deepEqual(seen, ['gitea:1'], 'a new token of the same account is not a new session');
  env.creds.headers = PAT('bob');
  await provider.refresh();
  assert.deepEqual(seen, ['gitea:1', 'gitea:2']);
});

interface Auto {
  auto: AutoSettingsSync;
  commands: string[];
  warnings: string[];
  logs: string[];
  state: Map<string, unknown>;
  requests: { method: string; url: string; authorization: string | null }[];
}

/** `variables` answers the probe: status of POST, then DELETE. */
function autoSync(options: { post?: number; body?: string; commandFails?: boolean; throwsFetch?: boolean; clock?: { now: number } } = {}): Auto {
  const state = new Map<string, unknown>();
  const out: Auto = { commands: [], warnings: [], logs: [], state, requests: [], auto: undefined as never };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    out.requests.push({ method: init?.method ?? 'GET', url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    if (options.throwsFetch) throw new TypeError('offline');
    return init?.method === 'POST' ? new Response(options.body ?? null, { status: options.post ?? 204 }) : new Response(null, { status: 204 });
  }) as typeof fetch;
  out.auto = new AutoSettingsSync({
    instance: 'http://git.test/git/', delayMs: 0, fetch: fetcher, now: () => options.clock?.now ?? Date.now(), log: message => out.logs.push(message),
    state: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { value === undefined ? state.delete(key) : state.set(key, value); } } as never,
    commands: { executeCommand: (async (id: string) => { out.commands.push(id); if (options.commandFails) throw new Error('boom'); }) as never },
    window: { showWarningMessage: (async (message: string) => { out.warnings.push(message); }) as never },
  });
  return out;
}

const authOf = (id: number) => `token ${tokenOf(`user${id}`)}`;
const session = (id: number) => ({ id: `gitea:${id}`, accessToken: tokenOf(`user${id}`), account: { id: String(id), label: `u${id}` }, scopes: [...SYNC_SCOPES] });

test('after sign-in the native turn-on runs once per account, after a write probe that leaves nothing behind', async () => {
  const t = autoSync();
  await t.auto.onSession(session(1), authOf(1));
  assert.deepEqual(t.commands, [TURN_ON_COMMAND]);
  assert.deepEqual(t.requests.map(r => `${r.method} ${r.url}`), [
    'POST http://git.test/git/api/v1/user/actions/variables/WEBIDE_SYNC_PROBE',
    'DELETE http://git.test/git/api/v1/user/actions/variables/WEBIDE_SYNC_PROBE',
  ]);
  assert.ok(t.requests.every(r => r.authorization === authOf(1)), 'the credential\'s own Authorization header, not a rebuilt Bearer one');
  await t.auto.onSession(session(1), authOf(1));
  assert.deepEqual(t.commands, [TURN_ON_COMMAND], 'the same account does not turn sync on again, e.g. after the user turned it off');
  await t.auto.onSession(session(2), authOf(2));
  assert.deepEqual(t.commands, [TURN_ON_COMMAND, TURN_ON_COMMAND], 'another account does');
  assert.deepEqual(t.warnings, []);
});

test('concurrent sessions start one turn-on', async () => {
  const t = autoSync();
  await Promise.all([t.auto.onSession(session(1), authOf(1)), t.auto.onSession(session(1), authOf(1))]);
  assert.deepEqual(t.commands, [TURN_ON_COMMAND]);
});

test('a Gitea without the variables API is reported once and sync stays off', async () => {
  const t = autoSync({ post: 404, body: '404 page not found' });
  await t.auto.onSession(session(1), authOf(1));
  await t.auto.onSession(session(1), authOf(1));
  assert.deepEqual(t.commands, []);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /Gitea 1\.24 or later/);
  assert.match(String([...t.state.values()][0]), /^unsupported:\d+$/, 'the finding is remembered, so no probe on every load');
  assert.equal(t.requests.length, 1);
});

test('an unsupported finding is remembered for a week, then the Gitea is probed again', async () => {
  const clock = { now: 1_000_000 };
  const t = autoSync({ post: 404, clock });
  await t.auto.onSession(session(1), authOf(1));
  clock.now += 6 * 24 * 3600 * 1000;
  await t.auto.onSession(session(1), authOf(1));
  assert.equal(t.requests.length, 1, 'still remembered after six days');
  clock.now += 2 * 24 * 3600 * 1000;
  await t.auto.onSession(session(1), authOf(1));
  assert.equal(t.requests.length, 2, 'probed again after more than seven days');
});

test('a token without write:user does not turn sync on and is retried with a better token', async () => {
  const t = autoSync({ post: 403 });
  await t.auto.onSession(session(1), authOf(1));
  assert.deepEqual(t.commands, []);
  assert.match(t.warnings[0], /read:user and write:user/);
  assert.equal(t.state.size, 0);
});

test('a rejected token or an unreachable Gitea turns nothing on and does not leak the token', async () => {
  for (const options of [{ post: 401 }, { post: 500 }, { throwsFetch: true }]) {
    const t = autoSync(options);
    await t.auto.onSession(session(1), authOf(1));
    assert.deepEqual(t.commands, [], JSON.stringify(options));
    assert.equal(t.state.size, 0);
    assert.ok(t.logs.length > 0 && t.logs.every(m => !m.includes(tokenOf('user1'))));
  }
});

test('a failed turn-on is logged and tried again on the next sign-in', async () => {
  const t = autoSync({ commandFails: true });
  await t.auto.onSession(session(1), authOf(1));
  assert.deepEqual(t.commands, [TURN_ON_COMMAND]);
  assert.equal(t.state.size, 0);
  assert.match(t.logs.join('\n'), /boom/);
  await t.auto.onSession(session(1), authOf(1));
  assert.equal(t.commands.length, 2);
});

test('probeVariables treats an existing probe variable as writable and removes it', async () => {
  const requests: string[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(init?.method ?? 'GET');
    return init?.method === 'POST' ? new Response('{"message":"variable name WEBIDE_SYNC_PROBE already exists"}', { status: 409 }) : new Response(null, { status: 204 });
  }) as typeof fetch;
  assert.equal(await probeVariables('http://git.test', `Bearer ${tokenOf('alice')}`, fetcher), 'ok');
  assert.deepEqual(requests, ['POST', 'DELETE']);
});

test('probeVariables retries a failed removal of its probe variable once and logs it', async () => {
  const requests: string[] = [];
  const logs: string[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(init?.method ?? 'GET');
    return new Response(null, { status: init?.method === 'POST' ? 204 : 500 });
  }) as typeof fetch;
  assert.equal(await probeVariables('http://git.test', `Bearer ${tokenOf('alice')}`, fetcher, message => logs.push(message)), 'ok');
  assert.deepEqual(requests, ['POST', 'DELETE', 'DELETE']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /WEBIDE_SYNC_PROBE could not be removed/);
});

function fakeWidget(title: string) {
  const widget = {
    style: { display: 'none' },
    querySelector: (selector: string) => selector === '.quick-input-title' ? { textContent: title } : null,
  } satisfies QuickInputWidget;
  return widget;
}

test('the native turn-on quick inputs are accepted while hidden, then shown again', async () => {
  const widget = fakeWidget('Settings Sync');
  const root = { querySelector: () => widget };
  const accepted: string[] = [];
  const hides: boolean[] = [];
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  // The action opens the widget twice (settings, account) and finishes after the second accept.
  const run = async () => {
    assert.deepEqual(hides, [true], 'hidden before the action starts, so nothing is ever painted');
    widget.style.display = 'flex';
    await done;
  };
  const accept = async () => {
    accepted.push('accept');
    if (accepted.length === 1) { widget.style.display = 'none'; await flush(); widget.style.display = 'flex'; }
    else { widget.style.display = 'none'; release(); }
  };
  await acceptSyncQuickInputs(run, accept, { hide: hidden => hides.push(hidden), root, timeoutMs: 5_000 });
  assert.equal(accepted.length, 2);
  assert.deepEqual(hides, [true, false]);
});

test('quick inputs of other features are not accepted and the flow times out', async () => {
  const widget = fakeWidget('Go to File');
  widget.style.display = 'flex';
  const accepted: number[] = [];
  const hides: boolean[] = [];
  await assert.rejects(
    acceptSyncQuickInputs(() => new Promise(() => undefined), async () => { accepted.push(1); }, { hide: hidden => hides.push(hidden), root: { querySelector: () => widget }, timeoutMs: 120 }),
    /timed out/,
  );
  assert.deepEqual(accepted, []);
  assert.deepEqual(hides, [true, false], 'shown again after the timeout');
});

test('errors of the native action propagate and quick inputs are shown again', async () => {
  const widget = fakeWidget('Settings Sync');
  widget.style.display = 'flex';
  const hides: boolean[] = [];
  await assert.rejects(
    acceptSyncQuickInputs(async () => { await flush(); throw new Error('Cannot turn on'); }, async () => undefined, { hide: hidden => hides.push(hidden), root: { querySelector: () => widget }, timeoutMs: 5_000 }),
    /Cannot turn on/,
  );
  assert.deepEqual(hides, [true, false]);
});

// endregion
