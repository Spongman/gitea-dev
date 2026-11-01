// The release credits every npm package it bundles, including those inlined in just-bash's prebuilt browser bundle.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error plain ES module without declarations
import { INLINED, noticeText, packageDirs, withDependencies } from '../scripts/notices.mjs';

const bundle = readFileSync('node_modules/just-bash/dist/bundle/browser.js', 'utf8');
const info = (name: string) => JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'));

function scripts(dir: string, depth = 0, out: string[] = []): string[] {
	if (depth > 4 || out.length > 300) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) scripts(full, depth + 1, out);
		else if (/\.(m?js|cjs)$/.test(entry.name) && statSync(full).size < 3_000_000) out.push(full);
	}
	return out;
}

/** String literals of 30 to 160 characters in a package's scripts that also occur in the just-bash browser bundle. */
function literalsInBundle(name: string): number {
	const literals = new Set<string>();
	for (const file of scripts(join('node_modules', name))) {
		for (const match of readFileSync(file, 'utf8').matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.){30,160})\1/g)) literals.add(match[2]!);
		if (literals.size > 600) break;
	}
	return [...literals].filter(literal => bundle.includes(literal)).length;
}

test('every just-bash dependency that its browser bundle inlines is credited', async () => {
	const credited = await withDependencies(INLINED);
	const creditedNames = new Set([...credited].map(dir => info(dir.replace(/^node_modules\//, '')).name));
	const candidates = [...await withDependencies(Object.keys(info('just-bash').dependencies))].map(dir => info(dir.replace(/^node_modules\//, '')).name);
	const inlined = candidates.filter(name => existsSync(join('node_modules', name)) && literalsInBundle(name) >= 5);
	assert.ok(inlined.includes('file-type') && inlined.includes('re2js'), `the match finds the known packages: ${inlined.join(', ')}`);
	assert.deepEqual(inlined.filter(name => !creditedNames.has(name)), [], 'add these to INLINED in scripts/notices.mjs');
});

test('the notice text holds each package with its version, declared license and license text', async () => {
	const text: string = await noticeText(new Set([...await withDependencies(INLINED), ...packageDirs(['node_modules/just-bash/dist/bundle/browser.js', 'node_modules/@scope/none/x.js'].slice(0, 1))]));
	for (const name of ['file-type', 're2js', 'strtok3', 'ieee754', 'just-bash']) {
		assert.match(text, new RegExp(`^${name}@${info(name).version.replace(/\./g, '\\.')}$`, 'm'), name);
	}
	assert.doesNotMatch(text, /ships no license file/);
	assert.match(text, /Permission is hereby granted, free of charge/);
	assert.match(text, /Apache License/);
});

test('package directories come from node_modules paths, scoped packages and nested copies included', () => {
	const dirs: Set<string> = packageDirs(['src/a.ts', 'node_modules/x/dist/y.js', 'node_modules/@s/p/lib/z.js', 'node_modules/x/node_modules/inner/i.js']);
	assert.deepEqual([...dirs].sort(), ['node_modules/@s/p', 'node_modules/x', 'node_modules/x/node_modules/inner']);
});
