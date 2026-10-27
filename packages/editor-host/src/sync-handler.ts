// The user-data-sync HTTP protocol the workbench's native Settings Sync client speaks, answered
// inside the service worker. Route table: userDataSyncStoreService.ts (UserDataSyncStoreClient)
// of the pinned workbench; behaviors are described in docs/settings-sync.md.
import { GiteaVariables, VariablesError, type Variables } from './sync-variables.js';
import {
  COLLECTION_ID, EMPTY_REF, REF, RESOURCES, StoreError, SyncStore, storeLimits,
  type Preconditions, type ResourceName, type StoreLimits,
} from './sync-store.js';

export interface SyncHandlerOptions {
  /** Gitea ROOT_URL without a trailing slash. */
  instance: string;
  /** Path of the sync route on this origin, with a trailing slash: `<scope>sync/`. */
  basePath: string;
  fetch?: typeof fetch;
  /** Replaces the Gitea-backed variables, for tests. */
  variables?: (authorization: string) => Variables;
  limits?: Partial<StoreLimits>;
  now?: () => number;
  /** Receives short status lines; never tokens or request headers. */
  log?: (message: string) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

type Target = 'list' | 'latest' | 'version';
type Route =
  | { kind: 'manifest' }
  | { kind: 'resources' }
  | { kind: 'resource'; collection?: string; name: ResourceName; target: Target; ref?: string }
  | { kind: 'collections' }
  | { kind: 'collection'; id: string }
  | { kind: 'download'; latest: boolean };

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const isResource = (name: string): name is ResourceName => (RESOURCES as readonly string[]).includes(name);

// Route table of the pinned client.
export function parseRoute(segments: string[]): Route | undefined {
  if (segments[0] !== 'v1' || !segments.every(part => SEGMENT.test(part))) return undefined;
  const [, area, second, third, fourth, fifth] = segments;
  const resource = (collection: string | undefined, name: string | undefined, ref: string | undefined): Route | undefined => {
    if (name === undefined || !isResource(name)) return undefined;
    if (ref === undefined) return { kind: 'resource', collection, name, target: 'list' };
    if (ref === 'latest') return { kind: 'resource', collection, name, target: 'latest' };
    return REF.test(ref) ? { kind: 'resource', collection, name, target: 'version', ref } : undefined;
  };
  switch (area) {
    case 'manifest': return segments.length === 2 ? { kind: 'manifest' } : undefined;
    case 'download': return segments.length === 2 ? { kind: 'download', latest: false }
      : segments.length === 3 && second === 'latest' ? { kind: 'download', latest: true } : undefined;
    case 'resource':
      if (segments.length === 2) return { kind: 'resources' };
      return segments.length <= 4 ? resource(undefined, second, third) : undefined;
    case 'collection':
      if (segments.length === 2) return { kind: 'collections' };
      if (!COLLECTION_ID.test(second)) return undefined;
      if (segments.length === 3) return { kind: 'collection', id: second };
      if (third !== 'resource' || segments.length > 6) return undefined;
      return resource(second, fourth, fifth);
    default: return undefined;
  }
}

function allowed(route: Route): string[] {
  switch (route.kind) {
    case 'manifest': case 'download': return ['GET'];
    case 'resources': case 'collection': return ['DELETE'];
    case 'collections': return ['GET', 'POST', 'DELETE'];
    case 'resource':
      return route.target === 'list' ? ['GET', 'POST', 'DELETE'] : route.target === 'latest' ? ['GET'] : ['GET', 'DELETE'];
  }
}

/** Parses If-Match / If-None-Match. Refs are plain tokens; quotes and weak markers are tolerated. */
function tags(header: string | null): '*' | string[] | undefined {
  if (header === null) return undefined;
  if (header.trim() === '*') return '*';
  const list = header.split(',').map(part => part.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
  if (list.length > 16 || !list.every(part => /^[A-Za-z0-9_-]{1,128}$/.test(part))) throw new HttpError(400, 'Bad precondition header');
  return list;
}

// One operation at a time per worker: parallel client requests never race each other. Other
// devices and tabs are covered by the store's compare-and-swap.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

export async function handleSync(request: Request, options: SyncHandlerOptions): Promise<Response> {
  const log = options.log ?? (() => undefined);
  try {
    return await serialized(() => serve(request, options));
  } catch (error) {
    const failure = error instanceof HttpError ? error
      : error instanceof StoreError ? new HttpError(error.status, error.message)
        : error instanceof VariablesError ? variablesFailure(error)
          : new HttpError(500, 'Settings sync failed');
    if (failure.status >= 500 || failure.status === 413) log(`settings sync: ${request.method} failed with ${failure.status}`);
    return new Response(failure.message, {
      status: failure.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...failure.headers },
    });
  }
}

function variablesFailure(error: VariablesError): HttpError {
  switch (error.kind) {
    // The client ends its session on 401 and 403.
    case 'unauthorized': return new HttpError(401, error.message, { 'WWW-Authenticate': 'Bearer realm="gitea-settings-sync"' });
    case 'forbidden': return new HttpError(403, error.message);
    // 405 makes the client turn sync off instead of retrying.
    case 'unsupported': return new HttpError(405, error.message);
    case 'unavailable': return new HttpError(503, error.message, { 'Retry-After': '5' });
    case 'rejected': return new HttpError(502, error.message);
  }
}

async function serve(request: Request, options: SyncHandlerOptions): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(options.basePath)) throw new HttpError(404, 'Not found');
  const route = parseRoute(url.pathname.slice(options.basePath.length).split('/'));
  if (!route) throw new HttpError(404, 'Not found');
  const methods = allowed(route);
  if (!methods.includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: methods.join(', ') });
  if (url.search) throw new HttpError(400, 'Bad query string');
  const writing = request.method === 'POST' && route.kind === 'resource';
  if (writing) {
    if (!/^text\/plain\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'Unsupported type');
    // Content-Length is advisory; the body is measured again below.
    if (Number(request.headers.get('content-length')) > storeLimits(options.limits).maxResourceBytes) throw new HttpError(413, 'Request too large');
  }
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match || !TOKEN.test(match[1])) throw new HttpError(401, 'Authentication required', { 'WWW-Authenticate': 'Bearer realm="gitea-settings-sync"' });
  const authorization = `Bearer ${match[1]}`;
  const variables = options.variables?.(authorization) ?? new GiteaVariables(options.instance, authorization, options.fetch);
  const sync = new SyncStore({ variables, limits: options.limits, now: options.now });
  const pre: Preconditions = { ifMatch: tags(request.headers.get('if-match')), ifNoneMatch: tags(request.headers.get('if-none-match')) };
  const send = (status: number, headers: Record<string, string> = {}, body?: string) => new Response(
    status === 204 || status === 304 ? null : body ?? null,
    { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ...headers } },
  );
  const json = (value: unknown, headers: Record<string, string> = {}) =>
    send(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(value));
  const text = (content: string, headers: Record<string, string> = {}) =>
    send(200, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, content);
  const notModified = (ref: string) => pre.ifNoneMatch !== undefined && (pre.ifNoneMatch === '*' || pre.ifNoneMatch.includes(ref));

  switch (route.kind) {
    case 'manifest': {
      const manifest = await sync.manifest();
      if (!manifest) return send(204, { ETag: EMPTY_REF });
      if (notModified(manifest.ref)) return send(304, { ETag: manifest.ref });
      return json(manifest, { ETag: manifest.ref });
    }
    case 'download': {
      if (!route.latest) return json(await sync.activity());
      const latest = await sync.latestData();
      return latest ? json(latest) : send(204);
    }
    case 'resources':
      await sync.removeResources();
      return send(204);
    case 'collections':
      if (request.method === 'GET') return json((await sync.listCollections()).map(id => ({ id })));
      if (request.method === 'POST') return text(await sync.createCollection());
      await sync.removeCollection(undefined);
      return send(204);
    case 'collection':
      await sync.removeCollection(route.id);
      return send(204);
    case 'resource': {
      const { collection, name } = route;
      if (request.method === 'POST') {
        const ref = await sync.write(collection, name, await readBody(request, sync.limits.maxResourceBytes), { ifMatch: pre.ifMatch, ifNoneMatch: pre.ifNoneMatch });
        return send(200, { ETag: ref }, '');
      }
      if (request.method === 'DELETE') {
        await sync.remove(collection, name, route.ref, pre);
        return send(204);
      }
      if (route.target === 'list') {
        const prefix = `${options.basePath}v1/${collection === undefined ? '' : `collection/${collection}/`}resource/${name}`;
        const handles = await sync.history(collection, name);
        return json(handles.map(({ ref, created }) => ({ url: `${prefix}/${ref}`, created: Math.floor(created / 1000) })));
      }
      if (route.target === 'latest') {
        const latest = await sync.readLatest(collection, name);
        if (!latest) return send(204, { ETag: EMPTY_REF });
        if (notModified(latest.ref)) return send(304, { ETag: latest.ref });
        return text(latest.content, { ETag: latest.ref });
      }
      const version = await sync.readVersion(collection, name, route.ref!);
      return notModified(version.ref) ? send(304, { ETag: version.ref }) : text(version.content, { ETag: version.ref });
    }
  }
}

async function readBody(request: Request, max: number): Promise<string> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > max) throw new HttpError(413, 'Request too large');
  if (bytes.length === 0) throw new HttpError(400, 'Empty body');
  try {
    // ignoreBOM keeps a leading BOM: the content is opaque and must round-trip.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { throw new HttpError(400, 'Body is not UTF-8'); }
}
