// Browser-side Open VSX gallery helpers: product configuration and the optional
// operator allowlist, which the service worker enforces on gallery traffic.

export interface GalleryProductConfiguration {
  serviceUrl: string;
  itemUrl: string;
  resourceUrlTemplate: string;
  extensionUrlTemplate: string;
}

/** Same shape the workbench expects for `extensionsGallery`; `base` is the gallery root without a trailing slash. */
export function galleryProductConfiguration(base: string): GalleryProductConfiguration {
  return {
    serviceUrl: `${base}/vscode/gallery`,
    itemUrl: `${base}/vscode/item`,
    resourceUrlTemplate: `${base}/vscode/unpkg/{publisher}/{name}/{version}/{path}`,
    extensionUrlTemplate: `${base}/vscode/gallery/{publisher}/{name}/latest`,
  };
}

const decode = (part: string) => { try { return decodeURIComponent(part).toLowerCase(); } catch { return undefined; } };

/**
 * Extension id (`publisher.name`, lowercase) addressed by a gallery or content-host URL,
 * `null` for routes that name no extension, `undefined` for unrecognized routes (including the
 * other `/api/-/` routes, which list extensions without naming one).
 */
export function galleryExtensionId(url: URL, galleryBase: string): string | null | undefined {
  const base = new URL(`${galleryBase}/`);
  const id = (publisher?: string, name?: string) => {
    const p = publisher && decode(publisher), n = name && decode(name);
    return p && n ? `${p}.${n}` : undefined;
  };
  if (url.origin !== base.origin) return id(...url.pathname.slice(1).split('/')); // content host: /<publisher>/<name>/...
  if (!url.pathname.startsWith(base.pathname)) return undefined;
  const parts = url.pathname.slice(base.pathname.length).split('/');
  if (parts[0] === 'vscode' && parts[1] === 'gallery') {
    if (parts.length === 3 && parts[2] === 'extensionquery') return null;
    return parts[2] === 'vscode' ? id(parts[3], parts[4]) : id(parts[2], parts[3]);
  }
  if (parts[0] === 'vscode' && (parts[1] === 'unpkg' || parts[1] === 'asset')) return id(parts[2], parts[3]);
  if (parts[0] === 'vscode' && parts[1] === 'item') return url.searchParams.get('itemName')?.toLowerCase() ?? undefined;
  if (parts[0] === 'api' && parts[1] === '-') return parts[2] === 'public-key' && parts.length === 4 ? null : undefined;
  if (parts[0] === 'api') return id(parts[1], parts[2]);
  return undefined;
}

interface QueryResult {
  extensions?: { extensionName?: string; publisher?: { publisherName?: string } }[];
  resultMetadata?: { metadataType?: string; metadataItems?: { name?: string; count?: number }[] }[];
}

/** Removes extensions outside `allowed` from an extensionquery response; TotalCount drops by the number removed from this page. */
export function filterQueryResponse(body: { results?: QueryResult[] }, allowed: ReadonlySet<string>) {
  for (const result of body.results ?? []) {
    const before = result.extensions?.length ?? 0;
    result.extensions = (result.extensions ?? []).filter(extension =>
      allowed.has(`${extension.publisher?.publisherName ?? ''}.${extension.extensionName ?? ''}`.toLowerCase()));
    const removed = before - result.extensions.length;
    for (const metadata of result.resultMetadata ?? []) {
      if (metadata.metadataType !== 'ResultCount') continue;
      for (const item of metadata.metadataItems ?? []) {
        if (item.name === 'TotalCount' && typeof item.count === 'number') item.count = Math.max(0, item.count - removed);
      }
    }
  }
  return body;
}
