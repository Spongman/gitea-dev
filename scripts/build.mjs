// Builds the static release tree dist/gitea-dev/: Gitea custom files, the editor host and extension
// under a versioned directory, and the workbench pin. It contains no Microsoft workbench files:
// scripts/install.sh copies the tree into $GITEA_CUSTOM and, unless the workbench
// loads from Microsoft's CDN, fetch and install the pinned workbench there.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

const browser = { bundle: true, platform: 'browser', target: 'es2022' };

// Install replaces @WORKBENCH_SOURCES@, @GALLERY_SOURCES@, @CONNECT_SOURCES@ and @FRAME_SOURCES@ with " source..." or "".
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval' blob:@WORKBENCH_SOURCES@",
  "style-src 'self' 'unsafe-inline'@WORKBENCH_SOURCES@", "img-src 'self' data: blob:@WORKBENCH_SOURCES@@GALLERY_SOURCES@",
  "font-src 'self' data:@WORKBENCH_SOURCES@", "connect-src 'self'@WORKBENCH_SOURCES@@GALLERY_SOURCES@", "worker-src 'self' blob:@WORKBENCH_SOURCES@",
  "frame-src 'self'@FRAME_SOURCES@", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');
// The extension host iframe (installed workbench only): the gallery and the operator allowlist.
const IFRAME_CSP = PAGE_CSP
  .replace("script-src 'self'", "script-src 'self' 'unsafe-eval'@GALLERY_SOURCES@")
  .replace("connect-src 'self'@WORKBENCH_SOURCES@@GALLERY_SOURCES@", "connect-src 'self'@WORKBENCH_SOURCES@@GALLERY_SOURCES@@CONNECT_SOURCES@");

const pin = JSON.parse(await readFile('config/workbench.json', 'utf8'));
for (const [key, pattern] of [['commit', /^[0-9a-f]{40}$/], ['sha256', /^[0-9a-f]{64}$/], ['url', /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*$/]]) {
  if (typeof pin[key] !== 'string' || !pattern.test(pin[key])) throw new Error(`config/workbench.json: invalid ${key}`);
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist/extension/dist', { recursive: true });
await build({
  ...browser, entryPoints: ['packages/gitea-vscode-web/src/extension.ts'],
  outfile: 'dist/extension/dist/extension.js', format: 'cjs', external: ['vscode'],
  // just-bash's browser build imports node:zlib for gzip, gunzip and zcat only.
  alias: { 'node:zlib': './packages/gitea-vscode-web/src/shell/zlib-stub.ts' },
});
await build({
  ...browser, format: 'esm', outdir: 'dist/host',
  entryPoints: ['bootstrap', 'oauth-callback', 'start'].map(name => `packages/editor-host/src/${name}.ts`),
});
const manifest = JSON.parse(await readFile('packages/gitea-vscode-web/package.json', 'utf8'));
manifest.browser = './dist/extension.js';
manifest.type = 'commonjs';
delete manifest.main;
await writeFile('dist/extension/package.json', JSON.stringify(manifest, null, 2));
await writeFile('dist/extension/package.nls.json', '{}');

async function* files(root, dir = root) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(root, path);
    else if (entry.isFile()) yield relative(root, path).split('\\').join('/');
  }
}

const hostCss = 'html,body{height:100%;width:100%;margin:0;overflow:hidden}';
const webviewDisabled = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embedded page unavailable</title></head><body><p>Embedded extension pages are unavailable in this deployment.</p></body></html>';
const fingerprint = createHash('sha256');
for (const root of ['dist/host', 'dist/extension']) {
  for await (const file of files(root)) fingerprint.update(`${root}/${file}\0`).update(await readFile(join(root, file)));
}
fingerprint.update(hostCss).update(webviewDisabled).update(`${pin.commit}\0${pin.sha256}`);
const version = `${pin.commit.slice(0, 12)}-${fingerprint.digest('hex').slice(0, 12)}`;

const release = 'dist/gitea-dev';
const assets = `${release}/custom/public/assets/gitea-dev`;
const versioned = `${assets}/${version}`;
await cp('gitea/custom', `${release}/custom`, { recursive: true });
await cp('dist/extension', `${versioned}/extension`, { recursive: true });
await cp('dist/host/bootstrap.js', `${versioned}/bootstrap.js`);
await writeFile(`${versioned}/host.css`, hostCss);
await mkdir(`${versioned}/webview-disabled`, { recursive: true });
await writeFile(`${versioned}/webview-disabled/index.html`, webviewDisabled);
for (const name of ['start.js', 'oauth-callback.js']) await cp(`dist/host/${name}`, `${assets}/${name}`);
await build({
  ...browser, entryPoints: ['packages/editor-host/src/coi-sw.ts'], outfile: `${assets}/coi-sw.js`, format: 'iife',
  define: { __PAGE_CSP__: JSON.stringify(PAGE_CSP), __IFRAME_CSP__: JSON.stringify(IFRAME_CSP) },
});
const worker = await readFile(`${assets}/coi-sw.js`, 'utf8');
for (const token of ['"@CONFIG@"', '"@SCRIPT_HASHES@"']) {
  if (worker.split(token).length !== 2) throw new Error(`coi-sw.js must contain one ${token}`);
}
const page = (title, script) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><script type="module" src="${script}"></script></body></html>\n`;
await writeFile(`${assets}/index.html`, page('Gitea Web IDE', 'start.js'));
await writeFile(`${assets}/oauth-callback.html`, page('Gitea sign-in', 'oauth-callback.js'));
await writeFile(`${release}/VERSION`, `${version}\n`);
// One field per line: install.sh reads it with sed.
await writeFile(`${release}/workbench.json`, `${JSON.stringify({ version: pin.version, commit: pin.commit, url: pin.url, sha256: pin.sha256 }, null, 2)}\n`);
await cp('scripts/install.sh', `${release}/install.sh`);
await chmod(`${release}/install.sh`, 0o755);
console.log(`Built ${release} (version ${version}).`);
