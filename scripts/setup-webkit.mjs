#!/usr/bin/env node
// Fetch Ubuntu focal amd64 shared libs needed by Playwright's ubuntu20.04 WebKit
// into data/browser-libs. No system changes. Usage:
//   node scripts/setup-webkit.mjs [extra-deb-package ...]
// Then run WebKit with:
//   LD_LIBRARY_PATH=$PWD/data/browser-libs PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'data', 'browser-libs');
// Private (0700) scratch directory: debs are unpacked here and their libs are later preloaded.
const work = mkdtempSync(join(tmpdir(), 'webkit-setup-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const base = 'https://archive.ubuntu.com/ubuntu';
// Highest priority first; the first pocket that has a package wins.
const pockets = ['focal-security', 'focal-updates', 'focal'];
const components = ['main', 'universe'];
const arch = 'amd64';

// Never add libc/libstdc++/libgcc etc: those must come from the host.
const packages = [
  'libffi7',
  'libicu66',
  'libjpeg-turbo8',
  'libwebp6',
  'libwoff1',
  'libenchant-2-2',
  'libhyphen0',
  ...process.argv.slice(2),
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fetchBuf = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
};

// Release file: map of "main/binary-amd64/Packages.gz" -> sha256
const parseRelease = (text) => {
  const m = text.split(/^SHA256:\n/m)[1] ?? '';
  const out = new Map();
  for (const line of m.split('\n')) {
    if (!line.startsWith(' ')) break;
    const [hash, , path] = line.trim().split(/\s+/);
    out.set(path, hash);
  }
  return out;
};

const parsePackages = (text) => {
  const pkgs = new Map();
  for (const stanza of text.split('\n\n')) {
    const f = {};
    let key;
    for (const line of stanza.split('\n')) {
      if (/^\s/.test(line)) { if (key) f[key] += '\n' + line; continue; }
      const i = line.indexOf(':');
      if (i < 0) continue;
      key = line.slice(0, i);
      f[key] = line.slice(i + 1).trim();
    }
    if (f.Package && (f.Architecture === arch || f.Architecture === 'all')) pkgs.set(f.Package, f);
  }
  return pkgs;
};

mkdirSync(outDir, { recursive: true });

const index = {}; // pocket -> Map(name -> fields)
for (const pocket of pockets) {
  const release = parseRelease((await fetchBuf(`${base}/dists/${pocket}/Release`)).toString());
  index[pocket] = new Map();
  for (const comp of components) {
    const rel = `${comp}/binary-${arch}/Packages.gz`;
    const want = release.get(rel);
    if (!want) throw new Error(`${pocket}: ${rel} not in Release`);
    const gz = await fetchBuf(`${base}/dists/${pocket}/${rel}`);
    const got = sha256(gz);
    if (got !== want) throw new Error(`${pocket}/${rel}: sha256 ${got} != Release ${want}`);
    console.log(`index ok ${pocket}/${rel} ${got}`);
    for (const [k, v] of parsePackages(gunzipSync(gz).toString())) index[pocket].set(k, { ...v, pocket });
  }
}

const manifest = [];
for (const name of packages) {
  const f = pockets.map((p) => index[p].get(name)).find(Boolean);
  if (!f) throw new Error(`package not found in focal: ${name}`);
  if (f.Architecture !== arch) throw new Error(`${name}: arch ${f.Architecture}`);
  const url = `${base}/${f.Filename}`;
  const deb = join(work, f.Filename.split('/').pop());
  const buf = await fetchBuf(url);
  const got = sha256(buf);
  if (got !== f.SHA256) throw new Error(`${name}: deb sha256 ${got} != Packages ${f.SHA256}`);
  writeFileSync(deb, buf);
  console.log(`deb ok ${name} ${f.Version} (${f.pocket}) ${got}`);

  const x = join(work, `x-${name}`);
  rmSync(x, { recursive: true, force: true });
  mkdirSync(x, { recursive: true });
  execFileSync('ar', ['x', deb], { cwd: x });
  const data = readdirSync(x).find((n) => n.startsWith('data.tar'));
  execFileSync('tar', ['-xf', join(x, data), '-C', x]);
  // Copy shared libs (and symlinks) only.
  for (const rel of ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu']) {
    const d = join(x, rel);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      if (/\.so(\.|$)/.test(n)) execFileSync('cp', ['-a', join(d, n), outDir]);
    }
    const enchant = join(d, 'enchant-2');
    if (existsSync(enchant)) execFileSync('cp', ['-a', enchant, outDir]);
  }
  manifest.push(`${name}\t${f.Version}\t${f.pocket}\t${url}\t${f.SHA256}`);
}
writeFileSync(join(outDir, 'MANIFEST.tsv'), 'package\tversion\tpocket\turl\tsha256\n' + manifest.join('\n') + '\n');

// The bundled MiniBrowser wrapper overwrites LD_LIBRARY_PATH, so inject the libs via
// LD_PRELOAD (absolute paths, dependency order). Only glib-free libs: preloading a lib
// that pulls in the host glib would shadow the bundled one.
const preload = ['libicudata.so.66', 'libicuuc.so.66', 'libicui18n.so.66', 'libwoff2common.so.1.0.2',
  'libwoff2dec.so.1.0.2', 'libjpeg.so.8', 'libwebp.so.6', 'libffi.so.7'];
writeFileSync(join(outDir, 'env.sh'), `# source this before running WebKit tests
export LD_PRELOAD="${preload.map((l) => join(outDir, l)).join(':')}\${LD_PRELOAD:+:$LD_PRELOAD}"
export LD_LIBRARY_PATH="${outDir}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
`);

// Report remaining unresolved libs for the WebKit builds.
const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
const wk = readdirSync(pw).find((n) => n.startsWith('webkit_ubuntu20.04_x64'));
if (wk) {
  let missing = new Set();
  for (const flavor of ['minibrowser-wpe', 'minibrowser-gtk']) {
    const dir = join(pw, wk, flavor);
    const env = { ...process.env, LD_LIBRARY_PATH: [join(dir, 'lib'), join(dir, 'sys', 'lib'), outDir].join(':') };
    for (const sub of ['bin', 'lib']) {
      for (const n of readdirSync(join(dir, sub))) {
        if (!/^(?:[A-Za-z]+Process|MiniBrowser|.*\.so[.\d]*)$/.test(n) && !/Driver$/.test(n)) continue;
        let out = '';
        try { out = execFileSync('ldd', [join(dir, sub, n)], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
        for (const l of out.split('\n')) if (l.includes('not found')) missing.add(`${flavor}: ${l.trim()}`);
      }
    }
  }
  console.log(missing.size ? `STILL MISSING:\n${[...missing].sort().join('\n')}` : 'ldd: no missing libs');
}
