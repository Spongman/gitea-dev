import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Does just-bash change globals of the extension host worker shared by all extensions?
// The probe runs in a child process so the Node-bundle control cannot disturb this runner.
const PROBE = 'tests/helpers/globals-probe.mjs';

type Report = Record<'import' | 'construct' | 'during' | 'after' | 'second', string[]>;

const probe = (entry: 'browser' | 'node', defense: 'default' | 'off'): Report =>
	JSON.parse(execFileSync(process.execPath, [PROBE, entry, defense], { encoding: 'utf8' }));

describe('just-bash and global objects', () => {
	it('the browser build patches nothing at import, construction, during or after exec, with default options', () => {
		assert.deepEqual(probe('browser', 'default'), { import: [], construct: [], during: [], after: [], second: [] });
	});

	it('the browser build patches nothing with defenseInDepth: false either (the option the shell passes)', () => {
		assert.deepEqual(probe('browser', 'off'), { import: [], construct: [], during: [], after: [], second: [] });
	});

	it('control: the Node build does patch eval, Function and timers, only during exec, and restores them', () => {
		const report = probe('node', 'default');
		assert.deepEqual(report.import, []);
		assert.deepEqual(report.construct, []);
		for (const name of ['globalThis.eval', 'globalThis.Function', 'globalThis.setTimeout', 'globalThis.setInterval', 'Function.prototype.constructor']) {
			assert.ok(report.during.includes(name), name);
		}
		assert.deepEqual(report.after, []);
	});

	it('control: defenseInDepth: false stops the Node build patching as well', () => {
		assert.deepEqual(probe('node', 'off').during, []);
	});

	it('the browser bundle sets the browser flag that turns the defense layer into a no-op', () => {
		const source = readFileSync('node_modules/just-bash/dist/bundle/browser.js', 'utf8');
		assert.match(source, /\$r=!0;/);
		assert.match(source, /activate\(\)\{if\(!\$r&&this\.config\.enabled&&!at\)throw new Error\("[^"]*"\);if\(\$r\|\|!this\.config\.enabled\)\{/);
		assert.equal((source.match(/this\.applyPatches\(\)/g) ?? []).length, 1);
	});
});
