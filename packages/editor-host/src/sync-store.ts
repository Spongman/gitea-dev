// Settings Sync store semantics on top of Variables (the user's Gitea Actions variables).
//
// Variables, all named WEBIDE_SYNC_*:
//   H            hint: the newest manifest generation (written after the manifest)
//   M<gen>       manifest generation: the whole index, gzip+base64url; the commit point
//   B<ref>_<i>   chunk i of one resource version, gzip+base64url, below Gitea's per-variable limit
// A write uploads its chunks first and creates M<gen+1> last. Creating a variable that exists
// fails with 409, so two writers racing for the same generation cannot both win. Readers follow
// the newest manifest and only touch chunks it names, so they never see a torn write.
import { CHUNK_CHARS, base64url, decode, encode, split } from './sync-codec.js';
import type { Variables } from './sync-variables.js';

/** Resource names the pinned client reads and writes (ServerResource minus editSessions/workspaceState). */
export const RESOURCES = [
  'settings', 'keybindings', 'snippets', 'prompts', 'tasks', 'mcp', 'extensions', 'globalState', 'profiles', 'machines',
] as const;
export type ResourceName = (typeof RESOURCES)[number];

/** Pseudo ref of a resource that has no versions; the client echoes it in If-Match for a first write. */
export const EMPTY_REF = '0';
export const REF = /^[0-9a-f]{24}$/;
export const COLLECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoreLimits {
  /** Largest single resource content, in UTF-8 bytes. */
  maxResourceBytes: number;
  /** History depth kept per resource. */
  maxVersions: number;
  maxCollections: number;
  /** Encoded characters of all retained versions of one user. */
  maxStoredChars: number;
}

const DEFAULT_STORE_LIMITS: StoreLimits = {
  maxResourceBytes: 2 * 1024 * 1024,
  maxVersions: 2,
  maxCollections: 16,
  maxStoredChars: 8 * 1024 * 1024,
};

export const storeLimits = (limits?: Partial<StoreLimits>): StoreLimits => ({ ...DEFAULT_STORE_LIMITS, ...limits });

export class StoreError extends Error {
  constructor(readonly status: 404 | 412 | 413 | 500, message: string) { super(message); }
}

/** `*` or the listed refs, as parsed from If-Match / If-None-Match. */
export interface Preconditions {
  ifMatch?: '*' | string[];
  ifNoneMatch?: '*' | string[];
}

export interface Manifest {
  session: string;
  latest: Record<string, string>;
  collections?: Record<string, { latest: Record<string, string> }>;
  ref: string;
}

interface Handle { ref: string; created: number; }
export interface Versioned { ref: string; created: number; content: string; }

export const PREFIX = 'WEBIDE_SYNC_';
const HINT = `${PREFIX}H`;
const manifestName = (gen: number) => `${PREFIX}M${gen}`;
const chunkName = (ref: string, index: number) => `${PREFIX}B${ref.toUpperCase()}_${index}`;
const CHUNK_NAME = /^WEBIDE_SYNC_B([0-9A-F]{8})[0-9A-F]{16}_\d+$/;
const MANIFEST_NAME = /^WEBIDE_SYNC_M(\d+)$/;
/** Concurrent chunk reads per request. */
const CHUNK_READS = 6;
/** Unreferenced chunks younger than this may belong to a write in progress. */
const ORPHAN_AGE_SECONDS = 3600;

/** ref, created (ms), chunk count, encoded characters. */
type Entry = [ref: string, created: number, chunks: number, chars: number];
type Resources = Record<string, Entry[]>;
interface State {
  v: 1;
  session?: string;
  root: Resources;
  cols: Record<string, { created: number; res: Resources }>;
  /** Chunk variables this commit superseded; deleted after the commit, again by the next writer if that failed. */
  trash: string[];
}

const corrupt = () => new StoreError(500, 'Stored data is corrupt');
const notFound = () => new StoreError(404, 'Not found');
const failed = () => new StoreError(412, 'Precondition failed');
// A chunk disappeared under a reader: a writer pruned it after the reader took the manifest.
const MISSING = Symbol('missing chunk');

const emptyState = (): State => ({ v: 1, root: {}, cols: {}, trash: [] });
const names = (entries: Entry[]) => entries.flatMap(([ref, , chunks]) => Array.from({ length: chunks }, (_, i) => chunkName(ref, i)));
const hasResources = (res: Resources) => Object.values(res).some(entries => entries.length > 0);
const isEmpty = (state: State) => !hasResources(state.root) && Object.keys(state.cols).length === 0;
const storedChars = (state: State) => [state.root, ...Object.values(state.cols).map(c => c.res)]
  .reduce((sum, res) => sum + Object.values(res).reduce((s, entries) => s + entries.reduce((n, e) => n + e[3], 0), 0), 0);
const isResources = (value: unknown): value is Resources => !!value && typeof value === 'object' && Object.values(value).every(entries =>
  Array.isArray(entries) && entries.every(e => Array.isArray(e) && e.length === 4 && typeof e[0] === 'string' && REF.test(e[0])
    && Number.isFinite(e[1]) && Number.isSafeInteger(e[2]) && e[2] > 0 && Number.isSafeInteger(e[3]) && e[3] > 0));

function check(pre: Preconditions | undefined, current: string, exists: boolean) {
  if (!pre) return;
  if (pre.ifMatch !== undefined && !(pre.ifMatch === '*' ? exists : pre.ifMatch.includes(current))) throw failed();
  if (pre.ifNoneMatch !== undefined && (pre.ifNoneMatch === '*' ? exists : exists && pre.ifNoneMatch.includes(current))) throw failed();
}

const latestOf = (entries: Entry[] | undefined) => entries?.[entries.length - 1];

/** Runs at most `max` jobs at a time. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); } finally {
      // A waiter inherits this slot.
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}

interface SyncStoreOptions {
  variables: Variables;
  limits?: Partial<StoreLimits>;
  now?: () => number;
}

export class SyncStore {
  readonly limits: StoreLimits;
  private readonly variables: Variables;
  private readonly now: () => number;
  private readonly chunkSlot = limiter(CHUNK_READS);

  constructor(options: SyncStoreOptions) {
    this.variables = options.variables;
    this.limits = storeLimits(options.limits);
    this.now = options.now ?? Date.now;
  }

  // #region plumbing

  /** Refs start with the creation time in seconds, so a sweep can tell a stale orphan from an upload in progress. */
  private newRef(): string {
    const random = crypto.getRandomValues(new Uint8Array(8));
    return Math.floor(this.now() / 1000).toString(16).padStart(8, '0') + [...random].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async parse(text: string): Promise<State> {
    let state: State;
    try { state = JSON.parse(await decode(text, 4 * CHUNK_CHARS * 8)) as State; } catch { throw corrupt(); }
    if (state?.v !== 1 || !isResources(state.root) || !state.cols || typeof state.cols !== 'object' || !Array.isArray(state.trash)
      || !Object.entries(state.cols).every(([id, c]) => COLLECTION_ID.test(id) && Number.isFinite(c?.created) && isResources(c.res))) {
      throw corrupt();
    }
    return state;
  }

  /**
   * The newest manifest generation. Generation 0 is the empty store. The hint can be stale (its
   * write failed, or an older one landed last) and can name a generation that was already deleted.
   */
  private async head(): Promise<{ gen: number; state: State }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const hint = Number(await this.variables.get(HINT) ?? 0);
      let gen = Number.isSafeInteger(hint) && hint > 0 ? hint : 0;
      let [text, next] = await Promise.all([
        gen > 0 ? this.variables.get(manifestName(gen)) : undefined,
        this.variables.get(manifestName(gen + 1)),
      ]);
      if (gen > 0 && text === undefined) {
        if (next === undefined) {
          // Unless a writer replaced it since, the newest manifest is the highest one that exists.
          const found = await this.newestManifest();
          if (found === undefined) continue;
          gen = found.gen;
          text = found.text;
          next = await this.variables.get(manifestName(gen + 1));
        } else {
          // Ahead of the hint: the generation it names was deleted.
          gen++;
          text = next;
          next = await this.variables.get(manifestName(gen + 1));
        }
      }
      for (; next !== undefined; next = await this.variables.get(manifestName(gen + 1))) {
        gen++;
        text = next;
      }
      return { gen, state: text === undefined ? emptyState() : await this.parse(text) };
    }
    throw corrupt();
  }

  private async newestManifest(): Promise<{ gen: number; text: string } | undefined> {
    const gens = (await this.variables.names(PREFIX)).flatMap(name => { const found = MANIFEST_NAME.exec(name); return found ? [Number(found[1])] : []; });
    for (const gen of gens.sort((a, b) => b - a)) {
      const text = await this.variables.get(manifestName(gen));
      if (text !== undefined) return { gen, text };
    }
    return undefined;
  }

  /** Reads against one manifest snapshot; retries when a chunk of it was pruned meanwhile. */
  private async read<T>(work: (state: State) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await work((await this.head()).state); } catch (error) { if (error !== MISSING) throw error; }
    }
    throw corrupt();
  }

  private resources(state: State, collection: string | undefined): Resources {
    if (collection === undefined) return state.root;
    const found = COLLECTION_ID.test(collection) ? state.cols[collection] : undefined;
    if (!found) throw notFound();
    return found.res;
  }

  private async blob(entry: Entry): Promise<string> {
    const parts = await Promise.all(names([entry]).map(name => this.chunkSlot(() => this.variables.get(name))));
    if (parts.some(part => part === undefined)) throw MISSING;
    try { return await decode(parts.join(''), this.limits.maxResourceBytes); } catch { throw corrupt(); }
  }

  private async versioned(entry: Entry): Promise<Versioned> {
    return { ref: entry[0], created: entry[1], content: await this.blob(entry) };
  }

  private async upload(ref: string, chunks: string[]) {
    for (const [index, chunk] of chunks.entries()) {
      if (!(await this.variables.create(chunkName(ref, index), chunk))) throw new StoreError(500, 'Chunk name collision');
    }
  }

  private async discard(trash: string[]) {
    for (const name of trash) await this.variables.remove(name).catch(() => undefined);
  }

  /**
   * Applies `change` to the newest state and creates the next manifest generation (`next`
   * undefined means no change). Losing the race for the generation re-runs `change` on the
   * winner's state, which is where preconditions are decided. `seed` is a head read earlier;
   * it is used while its generation still exists.
   */
  private async commit<T>(change: (state: State) => { next: State | undefined; result: T }, seed?: { gen: number; state: State }): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const fresh = seed && (seed.gen === 0 || await this.variables.get(manifestName(seed.gen)) !== undefined) ? seed : undefined;
      seed = undefined;
      const { gen, state } = fresh ?? await this.head();
      const { next, result } = change(structuredClone(state));
      // Nothing to change: no new generation.
      if (!next) return result;
      if (isEmpty(next)) delete next.session;
      const encoded = await encode(JSON.stringify(next));
      if (encoded.length > CHUNK_CHARS) throw new StoreError(413, 'Too many stored versions');
      if (!(await this.variables.create(manifestName(gen + 1), encoded))) continue;
      // Committed. The rest is housekeeping that a later writer repeats if it fails.
      // With a stale hint the old generation must stay: readers walk forward from it.
      const hinted = await this.variables.set(HINT, String(gen + 1)).then(() => true, () => false);
      if (hinted) await this.variables.remove(manifestName(gen)).catch(() => undefined);
      await this.discard([...state.trash, ...next.trash]);
      if (isEmpty(next)) await this.sweep(gen + 1).catch(() => undefined);
      return result;
    }
    throw failed();
  }

  /** After a full clear: removes chunks no manifest references (crashed writes) and old generations. */
  private async sweep(gen: number) {
    const stale = Math.floor(this.now() / 1000) - ORPHAN_AGE_SECONDS;
    for (const name of await this.variables.names(PREFIX)) {
      const generation = MANIFEST_NAME.exec(name);
      if (generation ? Number(generation[1]) < gen : Number.parseInt(CHUNK_NAME.exec(name)?.[1] ?? 'ffffffff', 16) < stale) {
        await this.variables.remove(name).catch(() => undefined);
      }
    }
  }

  // #endregion

  // #region manifest and reads

  /** Undefined means "no data": the client treats it as an empty store. */
  async manifest(): Promise<Manifest | undefined> {
    const { state } = await this.head();
    if (!state.session) return undefined;
    const refs = (res: Resources) => Object.fromEntries(Object.entries(res).filter(([, e]) => e.length > 0).map(([name, e]) => [name, latestOf(e)![0]]));
    const latest = refs(state.root);
    const collections = Object.fromEntries(Object.entries(state.cols)
      .sort(([a, x], [b, y]) => x.created - y.created || (a < b ? -1 : 1))
      .map(([id, c]) => [id, { latest: refs(c.res) }]));
    if (Object.keys(latest).length === 0 && !Object.values(collections).some(c => Object.keys(c.latest).length > 0)) return undefined;
    const body = { session: state.session, latest, ...(Object.keys(collections).length > 0 ? { collections } : {}) };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
    return { ...body, ref: base64url(new Uint8Array(digest)).slice(0, 22) };
  }

  readLatest(collection: string | undefined, name: ResourceName): Promise<Versioned | undefined> {
    return this.read(async state => {
      const latest = latestOf(this.resources(state, collection)[name]);
      return latest && this.versioned(latest);
    });
  }

  readVersion(collection: string | undefined, name: ResourceName, ref: string): Promise<Versioned> {
    return this.read(async state => {
      const res = this.resources(state, collection);
      const entry = REF.test(ref) ? res[name]?.find(e => e[0] === ref) : undefined;
      if (!entry) throw notFound();
      return this.versioned(entry);
    });
  }

  /** Newest first. */
  async history(collection: string | undefined, name: ResourceName): Promise<Handle[]> {
    const { state } = await this.head();
    return [...(this.resources(state, collection)[name] ?? [])].reverse().map(([ref, created]) => ({ ref, created }));
  }

  /** Latest version of everything, as served by `download/latest`. */
  latestData() {
    return this.read(async state => {
      if (!hasResources(state.root) && !Object.values(state.cols).some(c => hasResources(c.res))) return undefined;
      const latest = async (res: Resources) => {
        const out: Record<string, [Versioned]> = {};
        for (const name of RESOURCES) if (latestOf(res[name])) out[name] = [await this.versioned(latestOf(res[name])!)];
        return out;
      };
      const collections: Record<string, { resources: Record<string, [Versioned]> }> = {};
      for (const [id, c] of Object.entries(state.cols)) collections[id] = { resources: await latest(c.res) };
      return { resources: await latest(state.root), ...(Object.keys(collections).length > 0 ? { collections } : {}) };
    });
  }

  /** Every retained version, as served by `download`. */
  activity() {
    return this.read(async state => {
      const all = async (res: Resources) => {
        const out: Record<string, { created: number; content: string }[]> = {};
        for (const name of RESOURCES) {
          if (!res[name]?.length) continue;
          out[name] = [];
          for (const entry of [...res[name]].reverse()) out[name].push({ created: Math.floor(entry[1] / 1000), content: await this.blob(entry) });
        }
        return out;
      };
      const collections: Record<string, { resources: Record<string, { created: number; content: string }[]> }> = {};
      for (const [id, c] of Object.entries(state.cols)) collections[id] = { resources: await all(c.res) };
      return { resources: await all(state.root), ...(Object.keys(collections).length > 0 ? { collections } : {}) };
    });
  }

  // #endregion

  // #region writes

  /** Returns the new ref. Without preconditions the write is unconditional. */
  async write(collection: string | undefined, name: ResourceName, content: string, pre?: Preconditions): Promise<string> {
    if (new TextEncoder().encode(content).length > this.limits.maxResourceBytes) throw new StoreError(413, 'Resource too large');
    const decide = (state: State) => {
      const entries = this.resources(state, collection)[name];
      check(pre, latestOf(entries)?.[0] ?? EMPTY_REF, entries !== undefined && entries.length > 0);
    };
    const seed = await this.head();
    decide(seed.state);
    const encoded = await encode(content);
    const chunks = split(encoded);
    const ref = this.newRef();
    const unreferenced = () => this.discard(names([[ref, 0, chunks.length, 0]]));
    try { await this.upload(ref, chunks); } catch (error) { await unreferenced(); throw error; }
    try {
      return await this.commit(state => {
        decide(state);
        const entries = [...(this.resources(state, collection)[name] ?? []), [ref, this.now(), chunks.length, encoded.length] as Entry];
        const pruned = entries.splice(0, Math.max(0, entries.length - this.limits.maxVersions));
        this.resources(state, collection)[name] = entries;
        state.trash = names(pruned);
        if (storedChars(state) > this.limits.maxStoredChars) throw new StoreError(413, 'Storage quota exceeded');
        state.session ??= crypto.randomUUID();
        return { next: state, result: ref };
      }, seed);
    } catch (error) {
      // A store error means the manifest was not created. After a network error it may have been,
      // so the chunks stay; a later full clear sweeps them if they are orphans.
      if (error instanceof StoreError) await unreferenced();
      throw error;
    }
  }

  /** Deletes all versions of a resource, or one version when `ref` is given. */
  remove(collection: string | undefined, name: ResourceName, ref?: string, pre?: Preconditions): Promise<void> {
    return this.commit(state => {
      const res = this.resources(state, collection);
      const entries = res[name] ?? [];
      check(pre, latestOf(entries)?.[0] ?? EMPTY_REF, entries.length > 0);
      let removed = entries;
      if (ref !== undefined) {
        const keep = entries.filter(e => e[0] !== ref);
        if (!REF.test(ref) || keep.length === entries.length) throw notFound();
        removed = entries.filter(e => e[0] === ref);
        res[name] = keep;
      } else delete res[name];
      if (res[name]?.length === 0) delete res[name];
      state.trash = names(removed);
      return { next: removed.length > 0 ? state : undefined, result: undefined };
    });
  }

  /** Deletes every top-level resource; collections are untouched. */
  removeResources(): Promise<void> {
    return this.commit(state => {
      state.trash = names(Object.values(state.root).flat());
      const changed = state.trash.length > 0;
      state.root = {};
      return { next: changed ? state : undefined, result: undefined };
    });
  }

  // #endregion

  // #region collections

  async listCollections(): Promise<string[]> {
    const { state } = await this.head();
    return Object.entries(state.cols).sort(([a, x], [b, y]) => x.created - y.created || (a < b ? -1 : 1)).map(([id]) => id);
  }

  createCollection(): Promise<string> {
    return this.commit(state => {
      if (Object.keys(state.cols).length >= this.limits.maxCollections) throw new StoreError(413, 'Too many collections');
      const id = crypto.randomUUID();
      state.cols[id] = { created: this.now(), res: {} };
      state.trash = [];
      return { next: state, result: id };
    });
  }

  /** Idempotent: removing a collection that does not exist succeeds. */
  removeCollection(collection: string | undefined): Promise<void> {
    return this.commit(state => {
      const ids = collection === undefined ? Object.keys(state.cols) : COLLECTION_ID.test(collection) && state.cols[collection] ? [collection] : [];
      state.trash = ids.flatMap(id => names(Object.values(state.cols[id].res).flat()));
      for (const id of ids) delete state.cols[id];
      return { next: ids.length > 0 ? state : undefined, result: undefined };
    });
  }

  // #endregion
}
