import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handleSync, parseRoute, type SyncHandlerOptions } from '../packages/editor-host/src/sync-handler.js';
import { SyncStore, StoreError, PREFIX, type StoreLimits } from '../packages/editor-host/src/sync-store.js';
import { GiteaVariables, VariablesError } from '../packages/editor-host/src/sync-variables.js';
import { CHUNK_CHARS, decode, encode, split } from '../packages/editor-host/src/sync-codec.js';
import { FakeGitea } from './helpers/gitea-variables.js';

// Protocol source of truth: microsoft/vscode e646868227c3e3a9e3f24277c8c7220be42c0be7
// src/vs/platform/userDataSync/common/userDataSyncStoreService.ts (UserDataSyncStoreClient).

const ORIGIN = 'http://127.0.0.1:8081';
const BASE = '/assets/gitea-dev/sync/';
const V1 = `${BASE}v1/`;
const tokenOf = (name: string) => `tok-${name}-0123456789abcdef`;

interface Res { status: number; headers: Headers; text: string; }
interface Req { token?: string | null; headers?: Record<string, string>; body?: string | Uint8Array; ifMatch?: string; ifNoneMatch?: string; }

interface Ctx {
  gitea: FakeGitea;
  logs: string[];
  options: SyncHandlerOptions;
  send(method: string, path: string, req?: Req): Promise<Res>;
  call(name: string, method: string, path: string, req?: Req): Promise<Res>;
  client(name: string): NativeClient;
  store(name: string, limits?: Partial<StoreLimits>, now?: () => number): SyncStore;
}

function setup(limits?: Partial<StoreLimits>, now?: () => number): Ctx {
  const gitea = new FakeGitea(ORIGIN);
  gitea.addToken(tokenOf('alice'), 'alice');
  gitea.addToken(tokenOf('bob'), 'bob');
  const logs: string[] = [];
  const options: SyncHandlerOptions = { instance: ORIGIN, basePath: BASE, fetch: gitea.fetch, limits, now, log: message => logs.push(message) };
  const send = async (method: string, path: string, req: Req = {}): Promise<Res> => {
    const headers: Record<string, string> = { ...req.headers };
    if (req.token !== null && req.token !== undefined) headers.authorization = `Bearer ${req.token}`;
    if (req.ifMatch !== undefined) headers['if-match'] = req.ifMatch;
    if (req.ifNoneMatch !== undefined) headers['if-none-match'] = req.ifNoneMatch;
    const res = await handleSync(new Request(`${ORIGIN}${path}`, { method, headers, body: req.body as BodyInit | undefined }), options);
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return {
    gitea, logs, options, send,
    call: (name, method, path, req = {}) => send(method, path, { token: tokenOf(name), ...req }),
    client: name => new NativeClient(send, tokenOf(name)),
    store: (name, l, n) => new SyncStore({ variables: new GiteaVariables(ORIGIN, `Bearer ${tokenOf(name)}`, gitea.fetch), limits: l, now: n }),
  };
}

/** Replays the request shapes of UserDataSyncStoreClient (lines cited per method). */
class NativeClient {
  constructor(private readonly send: Ctx['send'], private readonly token: string) {}

  private url(collection: string | undefined, resource: string) {
    return collection ? `${V1}collection/${collection}/resource/${resource}` : `${V1}resource/${resource}`;
  }

  /** userDataSyncStoreService.ts:348-383 readResource */
  async read(resource: string, old: { ref: string; content: string | null } | null, collection?: string) {
    const res = await this.send('GET', `${this.url(collection, resource)}/latest`, {
      token: this.token, headers: { 'cache-control': 'no-cache' }, ifNoneMatch: old?.ref,
    });
    if (res.status === 304) return old!;
    assert.ok([200, 204].includes(res.status), `read ${resource}: ${res.status} ${res.text}`);
    const ref = res.headers.get('etag');
    assert.ok(ref, 'server must return a ref');
    return { ref, content: res.status === 204 ? null : res.text };
  }

  /** userDataSyncStoreService.ts:385-404 writeResource: If-Match only when ref is truthy. */
  async write(resource: string, data: string, ref: string | null, collection?: string) {
    const res = await this.send('POST', this.url(collection, resource), {
      token: this.token, body: data, headers: { 'content-type': 'text/plain' }, ifMatch: ref || undefined,
    });
    return { status: res.status, ref: res.headers.get('etag') ?? undefined, text: res.text };
  }

  /** userDataSyncStoreService.ts:408-461 manifest */
  async manifest(old: { ref: string } | null = null) {
    const res = await this.send('GET', `${V1}manifest`, { token: this.token, headers: { 'content-type': 'application/json' }, ifNoneMatch: old?.ref });
    if (res.status === 304) return old as { ref: string; session: string; latest?: Record<string, string>; collections?: Record<string, { latest?: Record<string, string> }> };
    assert.ok(res.headers.get('etag'), 'server must return a ref');
    if (res.status === 204) return null;
    assert.equal(res.status, 200, res.text);
    return { ...JSON.parse(res.text), ref: res.headers.get('etag')! };
  }

  /** userDataSyncStoreService.ts:298-310 getAllResourceRefs: ref is the path relative to the resource URL. */
  async refs(resource: string, collection?: string) {
    const res = await this.send('GET', this.url(collection, resource), { token: this.token });
    assert.equal(res.status, 200, res.text);
    const base = `${this.url(collection, resource)}/`;
    return (JSON.parse(res.text) as { url: string; created: number }[]).map(({ url, created }) => {
      assert.ok(url.startsWith(base), `history url ${url} must be below ${base}`);
      return { ref: url.slice(base.length), created: created * 1000 };
    });
  }

  /** userDataSyncStoreService.ts:312-324 resolveResourceContent */
  async resolve(resource: string, ref: string, collection?: string) {
    const res = await this.send('GET', `${this.url(collection, resource)}/${ref}`, { token: this.token, headers: { 'cache-control': 'no-cache' } });
    return { status: res.status, content: res.text };
  }

  /** userDataSyncStoreService.ts:266-281 createCollection */
  async createCollection() {
    const res = await this.send('POST', `${V1}collection`, { token: this.token, headers: { 'content-type': 'text/plain' } });
    assert.equal(res.status, 200, res.text);
    return res.text;
  }

  /** userDataSyncStoreService.ts:463-473 clear */
  async clear() {
    assert.equal((await this.send('DELETE', `${V1}collection`, { token: this.token })).status, 204);
    assert.equal((await this.send('DELETE', `${V1}resource`, { token: this.token, headers: { 'content-type': 'text/plain' } })).status, 204);
  }
}

const mine = (ctx: Ctx, user = 'alice') => [...ctx.gitea.vars(user).keys()];
const chunkNames = (ctx: Ctx, user = 'alice') => mine(ctx, user).filter(name => name.startsWith(`${PREFIX}B`));

// region codec

test('payloads round-trip through gzip and base64url, including unicode, BOM and large random text', async () => {
  for (const text of ['x', 'caf\u00e9 \u20ac \ud83d\ude00', '\ufeff{"a":1}', 'line\r\nbreak\n', randomBytes(100_000).toString('base64')]) {
    const encoded = await encode(text);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(await decode(encoded, 1 << 20), text);
  }
});

test('decoding is bounded and rejects garbage', async () => {
  const bomb = await encode('a'.repeat(1_000_000));
  assert.ok(bomb.length < 5_000, 'it compresses');
  await assert.rejects(decode(bomb, 100_000), /too large/);
  await assert.rejects(decode('not gzip at all', 1000));
  await assert.rejects(decode('****', 1000), /base64url/);
});

test('chunks stay below the per-variable limit and join back', () => {
  const encoded = 'a'.repeat(CHUNK_CHARS * 2 + 5);
  const chunks = split(encoded);
  assert.deepEqual(chunks.map(c => c.length), [CHUNK_CHARS, CHUNK_CHARS, 5]);
  assert.equal(chunks.join(''), encoded);
  assert.ok(CHUNK_CHARS < 65_536);
});

// endregion
// region protocol

test('first sync: empty manifest, empty resource, conditional first write, then manifest and reads', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  assert.equal(await alice.manifest(), null);
  assert.deepEqual(await alice.read('settings', null), { ref: '0', content: null });
  const first = await alice.write('settings', '{"settings":"{}"}', '0');
  assert.equal(first.status, 200);
  assert.ok(first.ref && first.ref !== '0');
  const manifest = await alice.manifest();
  assert.ok(manifest);
  assert.equal(manifest.latest!.settings, first.ref);
  assert.match(manifest.session, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await alice.read('settings', null), { ref: first.ref, content: '{"settings":"{}"}' });
  assert.equal((await alice.read('settings', { ref: first.ref, content: 'cached' })).content, 'cached', '304 returns the cached copy');
  assert.equal((await alice.manifest(manifest))!.ref, manifest.ref, '304 for an unchanged manifest');
  assert.equal((await ctx.client('bob').manifest()), null, 'another Gitea user sees nothing');
});

test('manifest ref changes with every write and the session stays stable', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  await alice.write('settings', 'a', '0');
  const one = (await alice.manifest())!;
  await alice.write('keybindings', 'b', '0');
  const two = (await alice.manifest())!;
  assert.notEqual(one.ref, two.ref);
  assert.equal(one.session, two.session);
  assert.deepEqual(Object.keys(two.latest!).sort(), ['keybindings', 'settings']);
});

test('writes use If-Match as compare-and-swap, also with quoted refs and wildcards', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const one = await alice.write('settings', 'one', '0');
  assert.equal((await alice.write('settings', 'x', '0')).status, 412, 'stale first-write ref');
  const two = await alice.write('settings', 'two', one.ref!);
  assert.equal(two.status, 200);
  assert.equal((await alice.write('settings', 'y', one.ref!)).status, 412);
  assert.equal((await alice.read('settings', null)).content, 'two');
  const send = (req: Req) => ctx.call('alice', 'POST', `${V1}resource/settings`, { body: 'z', headers: { 'content-type': 'text/plain' }, ...req });
  assert.equal((await send({ ifMatch: `"${two.ref}"` })).status, 200, 'quoted ref');
  assert.equal((await send({ ifMatch: '*' })).status, 200, '* matches an existing resource');
  assert.equal((await send({ ifNoneMatch: '*' })).status, 412, 'If-None-Match * refuses an existing resource');
  assert.equal((await ctx.call('alice', 'POST', `${V1}resource/tasks`, { body: 'z', headers: { 'content-type': 'text/plain' }, ifMatch: '*' })).status, 412, '* needs the resource to exist');
  assert.equal((await ctx.call('alice', 'POST', `${V1}resource/tasks`, { body: 'z', headers: { 'content-type': 'text/plain' }, ifNoneMatch: '*' })).status, 200);
  assert.equal((await send({})).status, 200, 'no precondition: unconditional, as the client does in cleanUpRemoteData');
});

test('two devices writing with the same If-Match: exactly one wins, in any interleaving', async () => {
  const ctx = setup();
  const base = (await ctx.client('alice').write('settings', 'base', '0')).ref!;
  // Two stores share Gitea but not memory, like two browsers; both read before either commits.
  const a = ctx.store('alice');
  const b = ctx.store('alice');
  const outcomes = await Promise.allSettled([
    a.write(undefined, 'settings', 'from-a', { ifMatch: [base] }),
    b.write(undefined, 'settings', 'from-b', { ifMatch: [base] }),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const loser = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.ok(loser.reason instanceof StoreError && loser.reason.status === 412);
  const winner = (await ctx.store('alice').readLatest(undefined, 'settings'))!;
  assert.match(winner.content, /^from-[ab]$/);
});

test('a writer that loses the race for a manifest generation re-checks its precondition on the winner', async () => {
  const ctx = setup();
  const settings = (await ctx.client('alice').write('settings', 'base', '0')).ref!;
  const a = ctx.store('alice');
  const other = ctx.store('alice');
  let interleaved = false;
  ctx.gitea.before = async call => {
    // Right before A creates its manifest generation, another device commits a different resource.
    if (!interleaved && call.method === 'POST' && call.name?.startsWith(`${PREFIX}M`)) {
      interleaved = true;
      await other.write(undefined, 'keybindings', 'kb', { ifMatch: ['0'] });
    }
  };
  const ref = await a.write(undefined, 'settings', 'from-a', { ifMatch: [settings] });
  assert.ok(interleaved);
  const manifest = (await ctx.client('alice').manifest())!;
  assert.equal(manifest.latest!.settings, ref, 'the unrelated write did not make A fail, and A did not drop it');
  assert.ok(manifest.latest!.keybindings, 'the other device\'s write survived');
});

test('a writer that loses the race to a write of the same resource gets 412', async () => {
  const ctx = setup();
  const base = (await ctx.client('alice').write('settings', 'base', '0')).ref!;
  const a = ctx.store('alice');
  const other = ctx.store('alice');
  let interleaved = false;
  ctx.gitea.before = async call => {
    if (!interleaved && call.method === 'POST' && call.name?.startsWith(`${PREFIX}M`)) {
      interleaved = true;
      await other.write(undefined, 'settings', 'from-other', { ifMatch: [base] });
    }
  };
  await assert.rejects(a.write(undefined, 'settings', 'from-a', { ifMatch: [base] }), (error: StoreError) => error.status === 412);
  assert.equal((await ctx.client('alice').read('settings', null)).content, 'from-other');
  assert.deepEqual(chunkNames(ctx).length, 2, 'the loser removed its chunks; base and the winner remain');
});

test('history lists versions newest first, refs resolve, and old versions are pruned with their chunks', async () => {
  let clock = 1_700_000_000_000;
  const ctx = setup({ maxVersions: 3 }, () => (clock += 1000));
  const alice = ctx.client('alice');
  let ref: string | null = '0';
  const refs: string[] = [];
  for (const content of ['v1', 'v2', 'v3', 'v4', 'v5']) {
    const written = await alice.write('settings', content, ref);
    ref = written.ref!;
    refs.push(ref);
  }
  const history = await alice.refs('settings');
  assert.deepEqual(history.map(h => h.ref), [refs[4], refs[3], refs[2]]);
  assert.ok(history[0].created > history[1].created);
  assert.equal(history[0].created % 1000, 0, 'created is whole seconds');
  assert.deepEqual((await Promise.all(history.map(h => alice.resolve('settings', h.ref)))).map(r => r.content), ['v5', 'v4', 'v3']);
  assert.equal((await alice.resolve('settings', refs[0])).status, 404, 'pruned');
  assert.equal((await alice.resolve('settings', 'f'.repeat(24))).status, 404);
  assert.equal(chunkNames(ctx).length, 3, 'pruned versions lose their chunk variables');
});

test('by default each resource keeps the current and one previous version', async () => {
  let clock = 1_700_000_000_000;
  const ctx = setup({}, () => (clock += 1000));
  const alice = ctx.client('alice');
  let ref: string | null = '0';
  const refs: string[] = [];
  for (const content of ['v1', 'v2', 'v3']) {
    ref = (await alice.write('settings', content, ref)).ref!;
    refs.push(ref);
  }
  assert.deepEqual((await alice.refs('settings')).map(h => h.ref), [refs[2], refs[1]]);
  assert.equal(chunkNames(ctx).length, 2);
});

test('opaque payloads round-trip byte for byte', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  // fetch's text() strips a leading BOM and the client sends JSON, so BOM is covered at store level.
  const payloads = ['{"version":1,"content":"caf\u00e9 \u20ac"}', ' leading and trailing \n\n', 'a\r\nb', '"quoted"', 'x'.repeat(100_000)];
  let ref: string | null = '0';
  for (const payload of payloads) {
    const written = await alice.write('globalState', payload, ref);
    ref = written.ref!;
    assert.equal((await alice.read('globalState', null)).content, payload);
  }
});

test('the store keeps a leading BOM', async () => {
  const store = setup().store('alice');
  await store.write(undefined, 'settings', '\ufeffbom first');
  assert.equal((await store.readLatest(undefined, 'settings'))!.content, '\ufeffbom first');
});

test('collections: create, list, write, manifest, history, delete, and per-user isolation', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const id = await alice.createCollection();
  assert.match(id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(JSON.parse((await ctx.call('alice', 'GET', `${V1}collection`)).text)), JSON.stringify([{ id }]));
  assert.equal(await alice.manifest(), null, 'a collection alone is not data');
  const written = await alice.write('settings', 'profile', '0', id);
  assert.equal(written.status, 200);
  assert.equal((await alice.read('settings', null, id)).content, 'profile');
  assert.equal((await alice.read('settings', null)).content, null, 'top level is separate');
  const manifest = (await alice.manifest())!;
  assert.deepEqual(manifest.collections, { [id]: { latest: { settings: written.ref } } });
  assert.equal((await alice.refs('settings', id)).length, 1);
  assert.equal((await ctx.client('bob').read('settings', null, id).catch(error => error)).message?.includes('404'), true, 'bob cannot see alice\'s collection');
  assert.equal((await ctx.call('bob', 'POST', `${V1}collection/${id}/resource/settings`, { body: 'x', headers: { 'content-type': 'text/plain' } })).status, 404);
  assert.equal((await ctx.call('alice', 'POST', `${V1}collection/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/resource/settings`, { body: 'x', headers: { 'content-type': 'text/plain' } })).status, 404, 'writes never create a collection');
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}collection/${id}`)).status, 204);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}collection/${id}`)).status, 204, 'idempotent');
  assert.equal(await alice.manifest(), null);
  assert.equal(chunkNames(ctx).length, 0);
});

test('the collection count is bounded', async () => {
  const ctx = setup({ maxCollections: 2 });
  const alice = ctx.client('alice');
  await alice.createCollection();
  await alice.createCollection();
  assert.equal((await ctx.call('alice', 'POST', `${V1}collection`, { headers: { 'content-type': 'text/plain' } })).status, 413);
});

test('download/latest and download return the shapes the client parses', async () => {
  let clock = 1_700_000_000_000;
  const ctx = setup({}, () => (clock += 1000));
  const alice = ctx.client('alice');
  assert.equal((await ctx.call('alice', 'GET', `${V1}download/latest`)).status, 204);
  assert.deepEqual(JSON.parse((await ctx.call('alice', 'GET', `${V1}download`)).text), { resources: {} });
  const s1 = await alice.write('settings', 's1', '0');
  const s2 = await alice.write('settings', 's2', s1.ref!);
  const k1 = await alice.write('keybindings', 'k1', '0');
  const id = await alice.createCollection();
  const c1 = await alice.write('snippets', 'c1', '0', id);
  const latest = JSON.parse((await ctx.call('alice', 'GET', `${V1}download/latest`)).text);
  assert.deepEqual(latest.resources.settings.map((v: { ref: string; content: string }) => [v.ref, v.content]), [[s2.ref, 's2']]);
  assert.deepEqual(latest.resources.keybindings.map((v: { ref: string }) => v.ref), [k1.ref]);
  assert.deepEqual(latest.collections[id].resources.snippets.map((v: { ref: string; content: string }) => [v.ref, v.content]), [[c1.ref, 'c1']]);
  const activity = JSON.parse((await ctx.call('alice', 'GET', `${V1}download`)).text);
  assert.deepEqual(activity.resources.settings.map((v: { content: string }) => v.content), ['s2', 's1'], 'newest first');
  assert.ok(Number.isInteger(activity.resources.settings[0].created) && activity.resources.settings[0].created < 1e11, 'seconds');
  assert.deepEqual(activity.collections[id].resources.snippets.map((v: { content: string }) => v.content), ['c1']);
});

test('reset (client.clear) empties the store, starts a new session, and stale clients cannot overwrite', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const written = await alice.write('settings', 'old', '0');
  await alice.write('keybindings', 'kb', '0');
  const id = await alice.createCollection();
  await alice.write('tasks', 't', '0', id);
  const before = (await alice.manifest())!;
  await alice.clear();
  assert.equal(await alice.manifest(), null);
  assert.deepEqual(chunkNames(ctx), [], 'no chunk variable is left');
  assert.deepEqual(mine(ctx).filter(n => n.startsWith(`${PREFIX}M`)).length, 1, 'only the newest (empty) manifest generation remains');
  const stale = await alice.write('settings', 'zombie', written.ref!);
  assert.equal(stale.status, 412, 'the old ref no longer matches');
  const fresh = await alice.write('settings', 'new', '0');
  assert.equal(fresh.status, 200);
  const after = (await alice.manifest())!;
  assert.notEqual(after.session, before.session, 'a new session tells other devices their data was cleared');
});

test('a stale writer cannot resurrect cleared data: manifest generations never repeat', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const base = (await alice.write('settings', 'old', '0')).ref!;
  const a = ctx.store('alice');
  const b = ctx.store('alice');
  let interleaved = false;
  ctx.gitea.before = async call => {
    if (!interleaved && call.method === 'POST' && call.name?.startsWith(`${PREFIX}M`)) {
      interleaved = true;
      await b.removeResources();
      await b.removeCollection(undefined);
    }
  };
  await assert.rejects(a.write(undefined, 'settings', 'zombie', { ifMatch: [base] }), (error: StoreError) => error.status === 412);
  assert.equal(await alice.manifest(), null);
});

test('deleting a resource, a version, or everything is explicit and conditional', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const one = await alice.write('settings', 'one', '0');
  const two = await alice.write('settings', 'two', one.ref!);
  await alice.write('keybindings', 'kb', '0');
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource/settings/${one.ref}`)).status, 204);
  assert.deepEqual((await alice.refs('settings')).map(r => r.ref), [two.ref]);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource/settings/${one.ref}`)).status, 404, 'version already gone');
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource/settings`, { ifMatch: 'f'.repeat(24) })).status, 412);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource/settings`, { ifMatch: two.ref })).status, 204);
  assert.equal((await alice.read('settings', null)).content, null);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource/settings`)).status, 204, 'deleting nothing succeeds');
  assert.ok((await alice.manifest())!.latest!.keybindings);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource`)).status, 204);
  assert.equal(await alice.manifest(), null);
  assert.equal(chunkNames(ctx).length, 0);
});

test('deleting only collections keeps top-level data and deleting only resources keeps collections', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  await alice.write('settings', 'top', '0');
  const id = await alice.createCollection();
  await alice.write('settings', 'inner', '0', id);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}collection`)).status, 204);
  assert.equal((await alice.read('settings', null)).content, 'top');
  const id2 = await alice.createCollection();
  await alice.write('settings', 'inner2', '0', id2);
  assert.equal((await ctx.call('alice', 'DELETE', `${V1}resource`)).status, 204);
  assert.equal((await alice.read('settings', null)).content, null);
  assert.equal((await alice.read('settings', null, id2)).content, 'inner2');
});

test('reads never write', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  await alice.write('settings', 'x', '0');
  ctx.gitea.calls.length = 0;
  const before = JSON.stringify([...ctx.gitea.vars('alice')]);
  for (const path of ['manifest', 'resource/settings/latest', 'resource/settings', 'download', 'download/latest', 'collection']) {
    assert.equal((await ctx.call('alice', 'GET', `${V1}${path}`)).status, 200, path);
  }
  assert.ok(ctx.gitea.calls.every(call => call.method === 'GET'));
  assert.equal(JSON.stringify([...ctx.gitea.vars('alice')]), before);
});

// endregion
// region chunking and torn writes

test('a resource over 64 KiB is chunked below the variable limit and reads back byte for byte', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const big = randomBytes(300_000).toString('base64');
  const written = await alice.write('globalState', big, '0');
  assert.equal(written.status, 200);
  const chunks = chunkNames(ctx);
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);
  assert.ok(ctx.gitea.maxValueSeen <= 60_000 && ctx.gitea.maxValueSeen < 65_536, `largest variable ${ctx.gitea.maxValueSeen}`);
  assert.equal((await alice.read('globalState', null)).content, big);
  const next = await alice.write('globalState', big.slice(1000), written.ref!);
  assert.equal(next.status, 200);
  assert.equal((await alice.read('globalState', null)).content, big.slice(1000));
  assert.equal(chunkNames(ctx).length, chunks.length * 2 - 0, 'both versions are retained until pruned');
});

test('every variable name is valid for Gitea, short, and uses the WEBIDE_SYNC_ prefix', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  await alice.write('globalState', randomBytes(100_000).toString('base64'), '0');
  const id = await alice.createCollection();
  await alice.write('settings', 'a', '0', id);
  await alice.write('settings', 'b', '0');
  const names = mine(ctx);
  assert.ok(names.length > 5);
  for (const name of names) {
    assert.match(name, /^WEBIDE_SYNC_[A-Z0-9_]+$/);
    assert.ok(name.length <= 48, name);
    assert.ok(!/^(GITEA_|GITHUB_|CI)/.test(name));
  }
});

test('torn write: a failure between chunks leaves the previous version readable and the manifest unchanged', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const v1 = await alice.write('globalState', randomBytes(150_000).toString('base64'), '0');
  const manifest = (await alice.manifest())!;
  const previous = (await alice.read('globalState', null)).content;
  let chunkWrites = 0;
  ctx.gitea.before = call => {
    if (call.method === 'POST' && call.name?.startsWith(`${PREFIX}B`) && ++chunkWrites === 2) throw new TypeError('connection lost');
  };
  const failed = await alice.write('globalState', randomBytes(150_000).toString('base64'), v1.ref!);
  assert.equal(failed.status, 503);
  ctx.gitea.before = undefined;
  assert.equal((await alice.manifest())!.ref, manifest.ref, 'no manifest generation was created');
  assert.equal((await alice.read('globalState', null)).content, previous);
  assert.equal((await alice.write('globalState', 'retry', v1.ref!)).status, 200, 'the client retries with the same ref');
});

test('torn write: a failure creating the manifest leaves the previous version readable', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const v1 = await alice.write('settings', 'v1', '0');
  ctx.gitea.before = call => {
    if (call.method === 'POST' && call.name?.startsWith(`${PREFIX}M`)) throw new TypeError('connection lost');
  };
  assert.equal((await alice.write('settings', 'v2', v1.ref!)).status, 503);
  ctx.gitea.before = undefined;
  assert.equal((await alice.read('settings', null)).content, 'v1');
  assert.equal((await alice.manifest())!.latest!.settings, v1.ref);
});

test('a failed hint write does not make the store unreadable: readers walk forward from the stale hint', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const v1 = await alice.write('settings', 'v1', '0');
  ctx.gitea.before = call => {
    if (call.method !== 'GET' && call.name === `${PREFIX}H`) throw new TypeError('connection lost');
  };
  const v2 = await alice.write('settings', 'v2', v1.ref!);
  assert.equal(v2.status, 200);
  const v3 = await alice.write('settings', 'v3', v2.ref!);
  assert.equal(v3.status, 200, 'writers also cope with the stale hint');
  ctx.gitea.before = undefined;
  assert.equal((await alice.read('settings', null)).content, 'v3');
  assert.equal((await alice.manifest())!.latest!.settings, v3.ref);
});

test('an older hint that lands last does not make the store unreadable', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  let ref = '0';
  for (const content of ['v1', 'v2', 'v3']) ref = (await alice.write('settings', content, ref)).ref!;
  const vars = ctx.gitea.vars('alice');
  for (const stale of ['1', '2']) {
    vars.set(`${PREFIX}H`, stale);
    assert.equal((await ctx.call('alice', 'GET', `${V1}resource/settings/latest`)).text, 'v3', `hint ${stale}`);
  }
  vars.set(`${PREFIX}H`, '1');
  ref = (await alice.write('settings', 'v4', ref)).ref!;
  assert.equal((await alice.read('settings', null)).content, 'v4');
});

test('a write reads the hint once, and reuses that read for its precondition', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const v1 = await alice.write('settings', 'v1', '0');
  ctx.gitea.calls.length = 0;
  assert.equal((await alice.write('settings', 'v2', v1.ref!)).status, 200);
  assert.equal(ctx.gitea.calls.filter(call => call.method === 'GET' && call.name === `${PREFIX}H`).length, 1);
});

test('a writer whose base generation was superseded and pruned meanwhile does not commit on the stale state', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const v1 = await alice.write('settings', 'v1', '0');
  const a = ctx.store('alice');
  const b = ctx.store('alice');
  let interleaved = false;
  ctx.gitea.before = async call => {
    if (interleaved || call.method !== 'POST' || !call.name?.startsWith(`${PREFIX}B`)) return;
    interleaved = true;
    // Two commits by another device: the generation A started from is pruned, and so is the next.
    const v2 = await b.write(undefined, 'settings', 'v2', { ifMatch: [v1.ref!] });
    await b.write(undefined, 'settings', 'v3', { ifMatch: [v2] });
  };
  await assert.rejects(a.write(undefined, 'settings', 'zombie', { ifMatch: [v1.ref!] }), (error: StoreError) => error.status === 412);
  assert.equal((await alice.read('settings', null)).content, 'v3');
});

test('chunks of one resource are fetched concurrently, with a bound', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  await alice.write('globalState', randomBytes(1_000_000).toString('base64'), '0');
  const chunks = chunkNames(ctx).length;
  assert.ok(chunks > 8, `${chunks} chunks`);
  let active = 0;
  let peak = 0;
  ctx.gitea.before = async call => {
    if (call.method !== 'GET' || !call.name?.startsWith(`${PREFIX}B`)) return;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  };
  assert.equal((await alice.read('globalState', null)).content?.length, 1_333_336);
  assert.ok(peak > 1, `peak ${peak}`);
  assert.ok(peak <= 8, `peak ${peak}`);
});

test('a reader never sees a half-written version: it gets the old one until the manifest commits', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  const reader = ctx.store('alice');
  const v1 = await alice.write('globalState', randomBytes(150_000).toString('base64'), '0');
  const old = (await alice.read('globalState', null)).content;
  const next = randomBytes(150_000).toString('base64');
  const seen: (string | undefined)[] = [];
  let writes = 0;
  ctx.gitea.before = async call => {
    if (call.method !== 'POST' || !call.name?.startsWith(PREFIX + 'B')) return;
    // After every chunk the writer uploads, a reader on another device reads.
    if (writes++ > 0) seen.push((await reader.readLatest(undefined, 'globalState'))?.content);
  };
  assert.equal((await alice.write('globalState', next, v1.ref!)).status, 200);
  ctx.gitea.before = undefined;
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(content => content === old), 'every concurrent read saw the previous version');
  assert.equal((await alice.read('globalState', null)).content, next);
});

test('a reader whose chunks are pruned underneath it retries on the new manifest', async () => {
  const ctx = setup({ maxVersions: 1 });
  const alice = ctx.client('alice');
  const writer = ctx.store('alice', { maxVersions: 1 });
  const v1 = await alice.write('settings', 'v1', '0');
  let raced = false;
  ctx.gitea.before = async call => {
    // The reader has the manifest of v1 and is about to fetch its chunk; a writer replaces and prunes v1.
    if (!raced && call.method === 'GET' && call.name?.startsWith(`${PREFIX}B`)) {
      raced = true;
      await writer.write(undefined, 'settings', 'v2', { ifMatch: [v1.ref!] });
    }
  };
  assert.equal((await alice.read('settings', null)).content, 'v2');
  assert.ok(raced);
});

test('a full clear removes crashed uploads that are old, and keeps fresh ones that may be in flight', async () => {
  const now = 1_800_000_000_000;
  const ctx = setup({}, () => now);
  const alice = ctx.client('alice');
  await alice.write('settings', 'x', '0');
  const vars = ctx.gitea.vars('alice');
  const hex = (seconds: number) => seconds.toString(16).padStart(8, '0');
  const stale = `${PREFIX}B${hex(now / 1000 - 7200)}${'A'.repeat(16)}_0`.toUpperCase();
  const fresh = `${PREFIX}B${hex(now / 1000 - 5)}${'B'.repeat(16)}_0`.toUpperCase();
  vars.set(stale, 'orphan');
  vars.set(fresh, 'in flight');
  vars.set('SOMEONE_ELSES_VARIABLE', 'keep');
  await alice.clear();
  assert.ok(!vars.has(stale), 'stale orphan swept');
  assert.ok(vars.has(fresh), 'recent chunk kept');
  assert.equal(vars.get('SOMEONE_ELSES_VARIABLE'), 'keep', 'variables outside the prefix are never touched');
});

// endregion
// region limits

test('request and storage sizes are bounded', async () => {
  const ctx = setup({ maxResourceBytes: 1000, maxStoredChars: 3000 });
  const alice = ctx.client('alice');
  assert.equal((await alice.write('settings', 'x'.repeat(1001), '0')).status, 413);
  const noise = () => randomBytes(700).toString('base64').slice(0, 900);
  let ref: string | null = '0';
  let status = 200;
  for (let i = 0; i < 8 && status === 200; i++) {
    const written = await alice.write(['settings', 'keybindings', 'snippets', 'tasks'][i % 4], noise(), ref && i < 4 ? '0' : null);
    status = written.status;
  }
  assert.equal(status, 413, 'the per-user quota applies');
  assert.equal((await ctx.call('alice', 'POST', `${V1}resource/settings`, { body: new Uint8Array(0), headers: { 'content-type': 'text/plain' } })).status, 400);
  const oversized = await ctx.call('alice', 'POST', `${V1}resource/settings`, { body: 'x'.repeat(2000), headers: { 'content-type': 'text/plain', 'content-length': '2000' } });
  assert.equal(oversized.status, 413);
  assert.ok(ctx.logs.some(line => line.includes('413')));
});

test('the manifest itself is bounded', async () => {
  const store = setup().store('alice', { maxVersions: 4000 });
  let status: number | undefined;
  for (let i = 0; i < 4000 && status === undefined; i++) {
    await store.write(undefined, 'settings', `v${i}`).catch((error: StoreError) => { status = error.status; });
  }
  assert.equal(status, 413);
});

// endregion
// region identity and errors

test('requests without a valid bearer token are rejected before Gitea is contacted', async () => {
  const ctx = setup();
  const attempts: Req[] = [{}, { token: '' }, { token: 'short' }, { headers: { authorization: 'Basic abcdefgh12345678' } }, { headers: { authorization: 'token abcdefgh12345678' } }, { token: 'a b c d e f g h' }];
  for (const attempt of attempts) {
    const res = await ctx.send('GET', `${V1}manifest`, attempt);
    assert.equal(res.status, 401, JSON.stringify(attempt));
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/);
  }
  assert.equal(ctx.gitea.calls.length, 0);
});

test('a token Gitea does not know gets 401 and the client ends its session', async () => {
  const ctx = setup();
  const res = await ctx.send('GET', `${V1}manifest`, { token: tokenOf('stranger') });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/);
  ctx.gitea.tokens.delete(tokenOf('alice'));
  assert.equal((await ctx.call('alice', 'GET', `${V1}resource/settings/latest`)).status, 401, 'a revoked token stops working at once');
});

test('the token is forwarded to the Gitea variables API only, never stored or echoed', async () => {
  const ctx = setup();
  const token = tokenOf('alice');
  const alice = ctx.client('alice');
  const responses = [
    await alice.write('settings', 'payload', '0'), await ctx.call('alice', 'GET', `${V1}manifest`),
    await ctx.call('alice', 'GET', `${V1}download`), await ctx.call('alice', 'GET', `${V1}manifest`, { token: tokenOf('stranger') }),
  ];
  assert.ok(responses.every(r => !JSON.stringify(r).includes(token)));
  assert.ok(ctx.gitea.calls.length > 0 && ctx.gitea.calls.every(call => call.headers.get('authorization') === `Bearer ${call.token}`));
  assert.ok(ctx.gitea.calls.every(call => call.credentials === 'omit' && call.redirect === 'error'), 'no cookies, no redirects');
  assert.ok(ctx.gitea.calls.every(call => [...call.headers.keys()].every(key => ['authorization', 'accept', 'content-type'].includes(key))));
  for (const user of ctx.gitea.data.values()) for (const value of user.values()) assert.ok(!value.includes(token));
  assert.ok(!ctx.logs.join('\n').includes(token));
});

test('data is per Gitea user: the same names under another token are a different store', async () => {
  const ctx = setup();
  await ctx.client('alice').write('settings', 'alice-only', '0');
  assert.equal((await ctx.client('bob').read('settings', null)).content, null);
  await ctx.client('bob').write('settings', 'bob-only', '0');
  assert.equal((await ctx.client('alice').read('settings', null)).content, 'alice-only');
  assert.equal((await ctx.client('bob').read('settings', null)).content, 'bob-only');
  assert.ok(ctx.gitea.vars('alice').size > 0 && ctx.gitea.vars('bob').size > 0);
});

test('token scopes: read:user alone can read and not write, write:user can do both', async () => {
  const ctx = setup();
  ctx.gitea.addToken(tokenOf('reader'), 'alice', ['read:user']);
  ctx.gitea.addToken(tokenOf('writer'), 'alice', ['write:user']);
  await ctx.client('alice').write('settings', 'x', '0');
  const read = await ctx.call('reader', 'GET', `${V1}resource/settings/latest`);
  assert.equal(read.status, 200);
  assert.equal(read.text, 'x');
  const write = await ctx.call('reader', 'POST', `${V1}resource/settings`, { body: 'y', headers: { 'content-type': 'text/plain' } });
  assert.equal(write.status, 403, 'a missing scope is reported, not retried');
  assert.equal(await ctx.call('reader', 'GET', `${V1}resource/settings/latest`).then(r => r.text), 'x');
  assert.deepEqual(chunkNames(ctx).length, 1, 'the refused write left no chunks');
  assert.equal((await ctx.call('writer', 'POST', `${V1}resource/settings`, { body: 'z', headers: { 'content-type': 'text/plain' } })).status, 200);
  assert.equal((await ctx.call('writer', 'GET', `${V1}resource/settings/latest`)).text, 'z');
});

test('a Gitea without the variables API makes the client turn sync off, with a clear message', async () => {
  const ctx = setup();
  ctx.gitea.unsupported = true;
  const res = await ctx.call('alice', 'GET', `${V1}manifest`);
  assert.equal(res.status, 405);
  assert.match(res.text, /Gitea 1\.24 or later/);
});

test('Gitea outages map to 503 with Retry-After, and unreadable values to 502', async () => {
  const ctx = setup();
  ctx.gitea.before = () => { throw new TypeError('connect ECONNREFUSED'); };
  const down = await ctx.call('alice', 'GET', `${V1}manifest`);
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('retry-after'), '5');
  ctx.gitea.before = undefined;
  const vars = new GiteaVariables(ORIGIN, `Bearer ${tokenOf('alice')}`, (async () => new Response('x'.repeat(10), { status: 400 })) as typeof fetch);
  await assert.rejects(vars.create('WEBIDE_SYNC_X', 'v'), (error: VariablesError) => error.kind === 'rejected');
  const limited = new GiteaVariables(ORIGIN, `Bearer ${tokenOf('alice')}`, (async () => new Response('', { status: 429 })) as typeof fetch);
  await assert.rejects(limited.get('WEBIDE_SYNC_X'), (error: VariablesError) => error.kind === 'unavailable');
});

test('variables behave the same when Gitea answers 201 or 204 to a create', async () => {
  for (const status of [201, 204] as const) {
    const ctx = setup();
    ctx.gitea.createStatus = status;
    const alice = ctx.client('alice');
    const written = await alice.write('settings', 'x', '0');
    assert.equal(written.status, 200);
    assert.equal((await alice.read('settings', null)).content, 'x');
  }
});

test('the variables list is read page by page', async () => {
  const ctx = setup();
  const vars = new GiteaVariables(ORIGIN, `Bearer ${tokenOf('alice')}`, ctx.gitea.fetch);
  for (let i = 0; i < 120; i++) await vars.create(`${PREFIX}K${i}`, 'v');
  await vars.create('OTHER', 'v');
  assert.equal((await vars.names(PREFIX)).length, 120);
});

test('stored data that is unreadable is reported as 500, never silently reset', async () => {
  const ctx = setup();
  const alice = ctx.client('alice');
  await alice.write('settings', 'x', '0');
  const vars = ctx.gitea.vars('alice');
  const chunk = chunkNames(ctx)[0];
  const good = vars.get(chunk)!;
  vars.set(chunk, 'AAAA');
  assert.equal((await ctx.call('alice', 'GET', `${V1}resource/settings/latest`)).status, 500);
  vars.set(chunk, good);
  const manifest = [...vars.keys()].find(name => /^WEBIDE_SYNC_M\d+$/.test(name))!;
  vars.set(manifest, 'AAAA');
  assert.equal((await ctx.call('alice', 'GET', `${V1}manifest`)).status, 500);
  assert.equal((await ctx.call('alice', 'POST', `${V1}resource/settings`, { body: 'y', headers: { 'content-type': 'text/plain' } })).status, 500);
  vars.delete(chunk);
  vars.set(manifest, ctx.gitea.vars('alice').get(manifest)!);
});

// endregion
// region routing

test('routing: unknown paths, methods and names are rejected without touching Gitea', async () => {
  const ctx = setup();
  const cases: [string, string, number][] = [
    ['GET', `${V1}nope`, 404], ['GET', `${V1}resource/unknown/latest`, 404], ['GET', `${V1}resource/editSessions/latest`, 404],
    ['GET', `${V1}resource/settings/not-a-ref`, 404], ['GET', `${BASE}manifest`, 404], ['GET', `${BASE}v2/manifest`, 404],
    ['POST', `${V1}manifest`, 405], ['PUT', `${V1}resource/settings`, 405], ['POST', `${V1}resource/settings/latest`, 405],
    ['GET', `${V1}collection/not-a-uuid/resource/settings`, 404], ['GET', `${V1}resource/settings/latest/extra`, 404],
    ['GET', `${V1}manifest?x=1`, 400], ['DELETE', `${V1}download`, 405],
  ];
  for (const [method, path, status] of cases) {
    assert.equal((await ctx.call('alice', method, path)).status, status, `${method} ${path}`);
  }
  assert.equal((await ctx.call('alice', 'POST', `${V1}manifest`)).headers.get('allow'), 'GET');
  assert.equal(ctx.gitea.calls.length, 0, 'none of them reached Gitea');
  assert.deepEqual(parseRoute(['v1', 'manifest']), { kind: 'manifest' });
});

test('only text/plain UTF-8 bodies are accepted for writes', async () => {
  const ctx = setup();
  // A string body would make Request add its own text/plain content type.
  const post = (headers: Record<string, string>, body: string | Uint8Array = new TextEncoder().encode('x')) => ctx.call('alice', 'POST', `${V1}resource/settings`, { body, headers });
  assert.equal((await post({ 'content-type': 'application/json' })).status, 415);
  assert.equal((await post({})).status, 415);
  assert.equal((await post({ 'content-type': 'text/plain; charset=utf-8' })).status, 200);
  assert.equal((await post({ 'content-type': 'text/plain' }, new Uint8Array([0xff, 0xfe, 0x41]))).status, 400);
  assert.equal((await post({ 'content-type': 'text/plain', 'if-match': '"a b"' })).status, 400, 'a malformed precondition');
});

// endregion
