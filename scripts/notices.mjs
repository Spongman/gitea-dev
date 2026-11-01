// The npm packages a release bundles and the notice file that credits them (used by scripts/build.mjs).
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Dependencies that just-bash's prebuilt browser bundle (dist/bundle/browser.js) inlines, which the build
// cannot see as separate inputs. Found by matching each dependency's string literals against that bundle
// (tests/notices.test.ts repeats the match); recheck when upgrading just-bash.
export const INLINED = ['file-type', 're2js'];

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-.].*)?$/i;

/** Directory of the package `name` as Node resolves it from the package in `from` (its own node_modules, then the root's). */
function locate(name, from) {
  for (const base of [from && join(from, 'node_modules'), 'node_modules']) {
    if (base && existsSync(join(base, name, 'package.json'))) return join(base, name);
  }
  return undefined;
}

/** Package directories for `names` and their transitive `dependencies`. */
export async function withDependencies(names) {
  const dirs = new Set();
  const visit = async (name, from) => {
    const dir = locate(name, from);
    if (dir === undefined || dirs.has(dir)) return;
    dirs.add(dir);
    const info = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(info.dependencies ?? {})) await visit(dependency, dir);
  };
  for (const name of names) await visit(name);
  return dirs;
}

/** Package directories of the node_modules paths in an esbuild metafile's inputs. */
export function packageDirs(inputs) {
  const dirs = new Set();
  for (const input of inputs) {
    const at = input.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const start = at + 'node_modules/'.length;
    const [first, second] = input.slice(start).split('/');
    dirs.add(input.slice(0, start) + (first.startsWith('@') ? `${first}/${second}` : first));
  }
  return dirs;
}

/** The notice text: name, version, declared license and the license files each package ships. */
export async function noticeText(dirs) {
  const entries = [];
  for (const dir of dirs) {
    const info = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const declared = typeof info.license === 'string' ? info.license : info.license?.type ?? info.licenses?.map(l => l.type).join(' OR ') ?? 'unknown';
    const texts = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && LICENSE_FILE.test(entry.name)) texts.push((await readFile(join(dir, entry.name), 'utf8')).trim());
    }
    if (texts.length === 0) {
      // A package without a license file may state the license in its README, under a License heading.
      const readme = await readFile(join(dir, 'README.md'), 'utf8').catch(() => '');
      const heading = [...readme.matchAll(/^#+\s*licen[cs]e.*$/gim)].pop();
      if (heading) texts.push(readme.slice(heading.index).trim());
    }
    entries.push({ title: `${info.name}@${info.version}`, declared, texts });
  }
  entries.sort((a, b) => a.title.localeCompare(b.title));
  const line = '-'.repeat(72);
  const body = entries.map(({ title, declared, texts }) =>
    `${line}\n${title}\nLicense: ${declared}\n\n${texts.length > 0 ? texts.join('\n\n') : `(The package ships no license file; its package.json declares ${declared}.)`}\n`);
  return `THIRD-PARTY NOTICES

This release bundles the npm packages below into its JavaScript files. Each is
under the license shown, reproduced from the package.

${body.join('\n')}`;
}
