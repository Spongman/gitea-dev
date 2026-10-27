// Pure parts of the service worker's handling of same-scope files (coi-sw.ts).

/** The extension host iframe of an installed workbench, below the version directory. */
export const IFRAME = 'workbench/out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html';

/** CSP templates (scripts/build.mjs) and the installed workbench's inline script hashes (install time). */
export interface CspPolicies {
  page: string;
  iframe: string;
  /** Space-separated `'sha256-...'` sources of this version's pages, keyed by `cspKey`. */
  scriptHashes: Record<string, string>;
}

/** The path below the version directory: the key of the script hashes. */
export const cspKey = (relative: string) => relative.includes('/') ? relative.slice(relative.indexOf('/') + 1) : relative;

const isOtherVersion = (relative: string, version: string) => relative.includes('/') && !relative.startsWith(`${version}/`);

/** The hashes are of this version's pages; HTML of an older version (an open tab) brings its own. */
export const needsHtml = (relative: string, version: string) => relative.endsWith('.html') && isOtherVersion(relative, version);

async function inlineScriptHashes(html: string): Promise<string[]> {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  return Promise.all(scripts.map(async script => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)));
    return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
  }));
}

/** `html` is the page's own text, required when `needsHtml` is true. */
export async function localCsp(relative: string, version: string, policies: CspPolicies, html?: string): Promise<string> {
  const key = cspKey(relative);
  const csp = key === IFRAME ? policies.iframe : policies.page;
  const hashes = html !== undefined && needsHtml(relative, version)
    ? await inlineScriptHashes(html)
    : policies.scriptHashes[key]?.split(' ') ?? [];
  return csp.replace("script-src 'self'", `script-src 'self'${hashes.map(hash => ` ${hash}`).join('')}`);
}

/** What to ask Gitea for: the OAuth redirect carries the code and state, which Gitea has no use for. */
export function localUrl(url: URL, relative: string): URL {
  if (relative !== 'oauth-callback.html') return url;
  const bare = new URL(url.href);
  bare.search = '';
  bare.hash = '';
  return bare;
}
