// Offline stand-in for open-vsx.org on a second local origin. Serves the same response shapes as
// /vscode/gallery/extensionquery, /vscode/unpkg, /vscode/asset and /api/.../file for tiny fixture
// extensions, with Open VSX's CORS (any origin, no CORP), so no test touches the network.
import http from 'node:http';

const version = '1.0.0';
const pingSource = `const vscode = require('vscode');
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('giteaTest.extensionPing', () => 'web-worker-ready'));
};
`;
// Phase S characterization: what an installed gallery extension can reach on the Gitea origin.
const probeSource = `const vscode = require('vscode');
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
async function settingsPage(username) {
  const response = await fetch(new URL('/user/settings', self.origin), { credentials: 'include' });
  const text = await response.text();
  return { status: response.status, path: new URL(response.url).pathname,
    csrf: /csrfToken: '[^']+'|name="_csrf" (value|content)="[^"]+"/.test(text), username: text.includes(username) };
}
async function secrets() {
  const db = await request(indexedDB.open('gitea-web-ide-secrets'));
  const store = name => db.transaction(name).objectStore(name);
  const key = await request(store('keys').get('aes-gcm-v1'));
  const ids = await request(store('secrets').getAllKeys());
  const records = await request(store('secrets').getAll());
  const plaintexts = [];
  for (let i = 0; i < records.length; i++) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: records[i].iv,
        additionalData: new TextEncoder().encode(JSON.stringify(ids[i])) }, key, records[i].data);
      plaintexts.push(new TextDecoder().decode(plain));
    } catch {}
  }
  db.close();
  return { records: records.length, plaintexts };
}
const attempt = async run => { try { return await run(); } catch (error) { return { error: String(error) }; } };
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('giteaTest.probe', async username =>
    ({ settings: await attempt(() => settingsPage(username)), secrets: await attempt(secrets) })));
};
`;
// Webview isolation check: a panel whose script reports what it can reach, posted back to the extension.
const panelSource = `const vscode = require('vscode');
const page = url => \`<!doctype html><html><body>Panel check<script>
const vscode = acquireVsCodeApi();
const thrown = run => { try { run(); return null; } catch (error) { return error.name; } };
(async () => {
  let databases;
  try { databases = (await indexedDB.databases()).map(database => database.name); } catch (error) { databases = 'error ' + error.name; }
  const fetched = await fetch(\${JSON.stringify(url)}, { credentials: 'include' }).then(response => 'status ' + response.status, error => 'rejected ' + error.name);
  vscode.postMessage({ origin: location.origin, framed: window.top !== window, top: thrown(() => window.top.document), databases, cookie: document.cookie, fetched });
})();
</script></body></html>\`;
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('giteaTest.panelCheck', url => new Promise(resolve => {
    const panel = vscode.window.createWebviewPanel('giteaTestPanel', 'Panel Check', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.onDidReceiveMessage(message => { resolve(message); panel.dispose(); });
    panel.webview.html = page(url);
  })));
};
`;
// 1x1 PNG.
const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

interface Fixture {
  publisher: string; name: string; displayName: string; description: string; web: boolean;
  files: Record<string, string | Buffer>;
}

function fixture(name: string, displayName: string, description: string, web: boolean,
  options: { virtual?: boolean; command?: string; source?: string; icon?: boolean } = {}): Fixture {
  const command = options.command ?? 'giteaTest.extensionPing';
  const manifest: Record<string, unknown> = {
    name, publisher: 'gitea-test', displayName, description, version,
    engines: { vscode: '^1.101.0' },
    categories: ['Other'],
    capabilities: { virtualWorkspaces: options.virtual ?? true, untrustedWorkspaces: { supported: true } },
    activationEvents: [`onCommand:${command}`],
    contributes: { commands: [{ command, title: `Gitea Test: ${displayName}` }] },
    ...(options.icon ? { icon: 'icon.png' } : {}),
    ...(web ? { browser: './extension.js' } : { main: './extension.js' }),
  };
  return {
    publisher: 'gitea-test', name, displayName, description, web,
    files: {
      'package.json': JSON.stringify(manifest, null, 2), 'extension.js': options.source ?? pingSource, 'readme.md': `# ${displayName}\n`,
      ...(options.icon ? { 'icon.png': icon } : {}),
    },
  };
}

export const fixtures = [
  fixture('web-fixture', 'Web Fixture', 'Browser extension used by Web IDE tests', true, { icon: true }),
  fixture('node-only-fixture', 'Node Only Fixture', 'Desktop Node runtime required', false),
  fixture('local-only-fixture', 'Local Only Fixture', 'Browser extension requiring a local filesystem', true, { virtual: false }),
  fixture('probe-fixture', 'Probe Fixture', 'Characterization of extension reach', true, { command: 'giteaTest.probe', source: probeSource }),
  fixture('blocked-fixture', 'Blocked Fixture', 'Browser extension outside the operator allowlist', true),
  fixture('panel-check', 'Panel Check Fixture', 'Opens a panel that inspects its origin', true, { command: 'giteaTest.panelCheck', source: panelSource }),
];

/** Ids the browser harness installs as the operator allowlist; blocked-fixture is left out. */
export const allowlist = fixtures.filter(f => f.name !== 'blocked-fixture').map(f => `${f.publisher}.${f.name}`);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function galleryEntry(origin: string, f: Fixture) {
  const asset = `${origin}/vscode/asset/${f.publisher}/${f.name}/${version}`;
  const file = (name: string) => `${origin}/api/${f.publisher}/${f.name}/${version}/file/${name}`;
  const index = fixtures.indexOf(f) + 1;
  return {
    extensionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    extensionName: f.name, displayName: f.displayName, shortDescription: f.description,
    publisher: { displayName: 'Gitea Test', publisherId: '00000000-0000-4000-9000-000000000001', publisherName: f.publisher, domain: null, isDomainVerified: null },
    versions: [{
      version, lastUpdated: '2026-01-01T00:00:00.000000Z', assetUri: asset, fallbackAssetUri: asset,
      files: [
        { assetType: 'Microsoft.VisualStudio.Code.Manifest', source: file('package.json') },
        { assetType: 'Microsoft.VisualStudio.Services.Content.Details', source: file('readme.md') },
        ...(f.files['icon.png'] ? [{ assetType: 'Microsoft.VisualStudio.Services.Icons.Default', source: file('icon.png') }] : []),
        { assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: file(`${f.publisher}.${f.name}-${version}.vsix`) },
        { assetType: 'Microsoft.VisualStudio.Services.VsixSignature', source: file(`${f.publisher}.${f.name}-${version}.sigzip`) },
      ],
      properties: [
        { key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.101.0' },
        { key: 'Microsoft.VisualStudio.Code.ExtensionDependencies', value: '' },
        { key: 'Microsoft.VisualStudio.Code.ExtensionPack', value: '' },
        { key: 'Microsoft.VisualStudio.Code.LocalizedLanguages', value: '' },
        ...(f.web ? [{ key: 'Microsoft.VisualStudio.Code.WebExtension', value: 'true' }] : []),
      ],
      targetPlatform: 'universal',
    }],
    statistics: [{ statisticName: 'install', value: 1 }],
    tags: f.web ? ['__web_extension', 'gitea-test'] : ['gitea-test'],
    releaseDate: '2026-01-01T00:00:00.000000Z', publishedDate: '2026-01-01T00:00:00.000000Z',
    lastUpdated: '2026-01-01T00:00:00.000000Z', categories: ['Other'], flags: '',
  };
}

interface Criterion { filterType: number; value?: string }

function query(origin: string, body: { filters?: { criteria?: Criterion[] }[] }) {
  const criteria = body.filters?.[0]?.criteria ?? [];
  const text = criteria.filter(c => c.filterType === 10).map(c => c.value ?? '').join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  const names = criteria.filter(c => c.filterType === 7).map(c => (c.value ?? '').toLowerCase());
  const ids = criteria.filter(c => c.filterType === 4).map(c => (c.value ?? '').toLowerCase());
  const matches = fixtures.filter(f => {
    const haystack = `${f.publisher}.${f.name} ${f.displayName} ${f.description}`.toLowerCase();
    return text.every(term => haystack.includes(term))
      && (!names.length || names.includes(`${f.publisher}.${f.name}`))
      && (!ids.length || ids.includes(galleryEntry(origin, f).extensionId));
  });
  return json({ results: [{
    extensions: matches.map(f => galleryEntry(origin, f)),
    resultMetadata: [{ metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: matches.length }] }],
  }] });
}

const ASSET_FILES: Record<string, string> = {
  'Microsoft.VisualStudio.Code.Manifest': 'package.json',
  'Microsoft.VisualStudio.Services.Content.Details': 'readme.md',
  'Microsoft.VisualStudio.Services.Icons.Default': 'icon.png',
};
const typeOf = (path: string) => path.endsWith('.json') ? 'application/json' : path.endsWith('.js') ? 'text/javascript'
  : path.endsWith('.png') ? 'image/png' : 'text/plain';

async function openVsx(origin: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/vscode/gallery/extensionquery' && request.method === 'POST') return query(origin, await request.json());
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // /vscode/unpkg/{publisher}/{name}/{version}/{path...}, /api/{publisher}/{name}/{version}/file/{file}, /vscode/asset/{publisher}/{name}/{version}/{type}
  const nativeLatest = parts.slice(0, 3).join('/') === 'vscode/gallery/vscode';
  const [kind, publisher, name, ver, ...rest] = nativeLatest ? ['gallery', ...parts.slice(3)]
    : parts[0] === 'vscode' ? parts.slice(1) : parts;
  const f = fixtures.find(item => item.publisher === publisher && item.name === name);
  if (kind === 'gallery' && f && ver === 'latest' && request.method === 'GET') return json(galleryEntry(origin, f));
  if (!f || ver !== version || request.method !== 'GET') return new Response('Not found', { status: 404 });
  const serve = (path: string) => f.files[path] === undefined ? new Response('Not found', { status: 404 })
    : new Response(new Uint8Array(Buffer.from(f.files[path])), { headers: { 'Content-Type': typeOf(path) } });
  if (kind === 'unpkg' && rest[0] === 'extension') {
    const path = rest.slice(1).join('/');
    if (!path) return json(Object.keys(f.files).map(file => `${origin}/vscode/unpkg/${publisher}/${name}/${version}/extension/${file}`));
    return serve(path);
  }
  const asset = kind === 'api' && rest[0] === 'file' ? rest[1] : kind === 'asset' ? ASSET_FILES[rest[0]] : undefined;
  return asset ? serve(asset) : new Response('Not found', { status: 404 });
}

/** Serves the fixture gallery at `origin`; `extra` handles other routes first (for example test controls). */
export function createGalleryServer(origin: string, extra?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean) {
  return http.createServer(async (req, res) => {
    if (extra?.(req, res)) return;
    // Like Open VSX: CORS for any origin, no Cross-Origin-Resource-Policy.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
        'Access-Control-Max-Age': '600',
      }).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
      const response = await openVsx(origin, new Request(new URL(req.url!, origin), { method: req.method, body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
}
