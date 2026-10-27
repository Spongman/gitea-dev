// Service worker (coi-serviceworker pattern). Gitea serves the editor as plain static files;
// this worker re-serves same-scope responses with the isolation and CSP headers the editor needs.
import { filterQueryResponse, galleryExtensionId } from './gallery.js';
import type { DeploymentConfiguration } from './deployment.js';
import { handleSync } from './sync-handler.js';
import { localCsp, localUrl, needsHtml } from './sw-policy.js';

// Build-time constants (scripts/build.mjs). CSP templates keep the install-time source tokens.
declare const __PAGE_CSP__: string;
declare const __IFRAME_CSP__: string;

interface SwFetchEvent extends Event { readonly request: Request; respondWith(response: Promise<Response>): void }
interface SwExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
const sw = self as unknown as {
  registration: { scope: string };
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
};

// Install-time values (scripts/install.sh).
const config = '@CONFIG@' as unknown as DeploymentConfiguration;
const gallerySources = '@GALLERY_SOURCES@';
const scriptHashes = '@SCRIPT_HASHES@' as unknown as Record<string, string>;
const policies = { page: __PAGE_CSP__, iframe: __IFRAME_CSP__, scriptHashes };

const scope = new URL(sw.registration.scope).pathname;
const galleryOrigins = new Set(gallerySources.split(' ').filter(Boolean));
const allowlist = config.extensionsAllowlist ? new Set(config.extensionsAllowlist) : undefined;
const NULL_BODY = new Set([101, 204, 205, 304]);

sw.addEventListener('install', () => { void sw.skipWaiting(); });
sw.addEventListener('activate', event => event.waitUntil(sw.clients.claim()));

sw.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin === sw.location.origin) {
    // Gitea pages and the API pass through untouched.
    if (!url.pathname.startsWith(scope)) return;
    const relative = url.pathname.slice(scope.length);
    if (relative.startsWith('sync/')) event.respondWith(syncResponse(request));
    else if (request.method === 'GET' || request.method === 'HEAD') event.respondWith(serveLocal(request, url, relative));
    return;
  }
  if (config.gallery && galleryOrigins.has(url.origin)) {
    const id = allowlist ? galleryExtensionId(url, config.gallery) : null;
    if (allowlist && (id === undefined || (id !== null && !allowlist.has(id)))) {
      event.respondWith(Promise.resolve(new Response('Extension not allowed by this deployment.', { status: 403 })));
    } else if (allowlist && request.method === 'POST' && url.pathname.endsWith('/extensionquery')) {
      event.respondWith(filteredQuery(request, allowlist));
    } else if (request.mode === 'no-cors' && request.method === 'GET') {
      event.respondWith(corsResource(url));
    }
  }
});

// The Settings Sync store (docs/settings-sync.md) keeps its data in the user's Gitea Actions variables.
const syncResponse = (request: Request) => handleSync(request, { instance: config.instance, basePath: `${scope}sync/` });

async function serveLocal(request: Request, url: URL, relative: string): Promise<Response> {
  // Unversioned files and HTML revalidate; versioned assets may use Gitea's six-hour cache.
  const fresh = !relative.includes('/') || relative.endsWith('.html');
  const cache: RequestCache = fresh ? 'no-cache' : 'default';
  const target = localUrl(url, relative);
  // A navigation request cannot be copied into a new Request, so it is fetched from its URL.
  const copy = () => {
    const source = target === url ? request : new Request(target.href, request);
    return fresh ? new Request(source, { cache }) : source;
  };
  const response = request.mode === 'navigate'
    ? await fetch(target.href, { cache, credentials: 'same-origin', redirect: 'manual' })
    : await fetch(copy());
  if (response.type !== 'basic') return response;
  const html = needsHtml(relative, config.version) ? await response.text() : undefined;
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set('Content-Security-Policy', `${await localCsp(relative, config.version, policies, html)}; frame-ancestors 'self'`);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  const body = request.method === 'HEAD' || NULL_BODY.has(response.status) ? null : html ?? response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Gallery images are no-cors requests without CORP, which require-corp blocks. Open VSX allows
// CORS from any origin, so fetch them with CORS and mark the copy as cross-origin readable.
async function corsResource(url: URL): Promise<Response> {
  try {
    const response = await fetch(url.href, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    const headers = new Headers({ 'Cross-Origin-Resource-Policy': 'cross-origin' });
    const type = response.headers.get('content-type');
    if (type) headers.set('Content-Type', type);
    return new Response(NULL_BODY.has(response.status) ? null : response.body, { status: response.status, statusText: response.statusText, headers });
  } catch { return Response.error(); }
}

async function filteredQuery(request: Request, allowed: ReadonlySet<string>): Promise<Response> {
  const response = await fetch(request);
  if (!response.ok) return response;
  const body = filterQueryResponse(await response.json(), allowed);
  return new Response(JSON.stringify(body), {
    status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  });
}
