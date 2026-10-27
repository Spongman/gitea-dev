import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LineEditor } from '../packages/gitea-vscode-web/src/shell/line-editor.js';
import { VfsFileSystem } from '../packages/gitea-vscode-web/src/shell/fs.js';
import { GiteaShell } from '../packages/gitea-vscode-web/src/shell/shell.js';
import { ShellTerminal } from '../packages/gitea-vscode-web/src/shell/terminal.js';
import { FakeWorkspaceFs, fakeUri } from './helpers/workspace-fs.js';
import { Screen } from './helpers/screen.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const HOME = '\x1b[H';
const END = '\x1b[F';
const DELETE = '\x1b[3~';
const BACKSPACE = '\x7f';

function editor(columns = 80, prompt = '$ ') {
	const screen = new Screen(columns);
	const lines: string[] = [];
	const events: string[] = [];
	const ed = new LineEditor({
		write: (data) => screen.write(data),
		prompt: () => prompt,
		onLine: (line) => lines.push(line),
		onInterrupt: () => events.push('interrupt'),
		onEof: () => events.push('eof'),
	});
	ed.setColumns(columns);
	ed.ready();
	return { ed, screen, lines, events };
}

/** Types and submits, returning to the prompt after each line as the shell does. */
function submit(e: ReturnType<typeof editor>, data: string): void {
	e.ed.feed(data);
	e.ed.ready();
}

describe('LineEditor', () => {
	it('inserts text and submits on Enter with CRLF', () => {
		const e = editor();
		e.ed.feed('echo hi\r');
		assert.deepEqual(e.lines, ['echo hi']);
		assert.deepEqual(e.screen.lines(), ['$ echo hi']);
	});

	it('Backspace edits at the end and in the middle', () => {
		const e = editor();
		e.ed.feed(`abcd${BACKSPACE}${LEFT}${LEFT}${BACKSPACE}X`);
		assert.deepEqual(e.screen.lines(), ['$ Xbc']);
		e.ed.feed('\r');
		assert.deepEqual(e.lines, ['Xbc']);
	});

	it('moves with arrows, Home, End, Ctrl+A/E and deletes with Delete', () => {
		const e = editor();
		e.ed.feed(`bcd${HOME}a${END}e${LEFT}${LEFT}${DELETE}\r`);
		assert.deepEqual(e.lines, ['abce']);
		const f = editor();
		f.ed.feed('bc\x01a\x05d\x02\x02\x02\x06\x06\x04\r');
		assert.deepEqual(f.lines, ['abc']);
		const g = editor();
		g.ed.feed('abc' + LEFT + RIGHT + RIGHT + RIGHT + 'd\r');
		assert.deepEqual(g.lines, ['abcd']);
	});

	it('kills with Ctrl+U, Ctrl+K and Ctrl+W', () => {
		const e = editor();
		e.ed.feed('one two three\x17\x17\r');
		assert.deepEqual(e.lines, ['one ']);
		const f = editor();
		f.ed.feed(`hello world${HOME}${RIGHT}${RIGHT}\x0b\r`);
		assert.deepEqual(f.lines, ['he']);
		const g = editor();
		g.ed.feed(`abc${LEFT}\x15\r`);
		assert.deepEqual(g.lines, ['c']);
	});

	it('recalls history with Up and Down and restores the unfinished line', () => {
		const e = editor();
		submit(e, 'first\r');
		submit(e, 'second\r');
		submit(e, '\r');
		e.ed.feed(`draft${UP}`);
		assert.deepEqual(e.screen.lines().at(-1), '$ second');
		e.ed.feed(UP);
		assert.deepEqual(e.screen.lines().at(-1), '$ first');
		e.ed.feed(UP);
		assert.deepEqual(e.screen.lines().at(-1), '$ first');
		e.ed.feed(DOWN + DOWN);
		assert.deepEqual(e.screen.lines().at(-1), '$ draft');
		e.ed.feed(UP + '2\r');
		assert.deepEqual(e.lines.at(-1), 'second2');
		assert.deepEqual(e.ed.history, ['first', 'second', 'second2']);
	});

	it('does not store blank lines or repeats in history', () => {
		const e = editor();
		submit(e, 'ls\r');
		submit(e, 'ls\r');
		submit(e, '   \r');
		assert.deepEqual(e.ed.history, ['ls']);
	});

	it('Ctrl+C abandons the line and shows a fresh prompt; Ctrl+D ends only on an empty line', () => {
		const e = editor();
		e.ed.feed('abc\x03');
		assert.deepEqual(e.screen.lines(), ['$ abc^C', '$']);
		assert.deepEqual(e.lines, []);
		e.ed.feed('\x04');
		assert.deepEqual(e.events, ['eof']);
		const f = editor();
		f.ed.feed(`abc${LEFT}\x04\r`);
		assert.deepEqual(f.events, []);
		assert.deepEqual(f.lines, ['ab']);
	});

	it('while busy only Ctrl+C acts; typed-ahead input is replayed at the next prompt', () => {
		const e = editor();
		e.ed.feed('run\r');
		e.ed.feed('next');
		e.ed.feed('\x03');
		assert.deepEqual(e.events, ['interrupt']);
		assert.deepEqual(e.lines, ['run']);
		e.ed.ready();
		assert.deepEqual(e.screen.lines().at(-1), '$ next');
		e.ed.feed('\r');
		assert.deepEqual(e.lines, ['run', 'next']);
	});

	it('treats CR LF as one Enter and splits pasted lines', () => {
		const e = editor();
		e.ed.feed('a\r\nb\nc\r');
		assert.deepEqual(e.lines, ['a']);
		e.ed.ready();
		assert.deepEqual(e.lines, ['a', 'b']);
		e.ed.ready();
		assert.deepEqual(e.lines, ['a', 'b', 'c']);
	});

	it('handles escape sequences split across chunks and ignores unknown ones', () => {
		const e = editor();
		e.ed.feed('ab\x1b');
		e.ed.feed('[');
		e.ed.feed('D');
		e.ed.feed('X\x1b[1;5C\x1bOHY\r');
		assert.deepEqual(e.lines, ['YaXb']);
	});

	it('keeps the screen right when editing a line that wraps', () => {
		const e = editor(10, '$ ');
		e.ed.feed('abcdefghijklmnop');
		assert.deepEqual(e.screen.lines(), ['$ abcdefgh', 'ijklmnop']);
		e.ed.feed(`${HOME}XY`);
		assert.deepEqual(e.screen.lines(), ['$ XYabcdef', 'ghijklmnop']);
		e.ed.feed(`${BACKSPACE}${BACKSPACE}${END}${BACKSPACE}`);
		assert.deepEqual(e.screen.lines(), ['$ abcdefgh', 'ijklmno']);
		assert.deepEqual([e.screen.y, e.screen.x], [1, 7]);
	});

	it('settles a line that ends exactly at the right edge', () => {
		const e = editor(10, '$ ');
		e.ed.feed('abcdefgh');
		assert.deepEqual(e.screen.lines(), ['$ abcdefgh']);
		assert.deepEqual([e.screen.y, e.screen.x], [1, 0]);
		e.ed.feed(BACKSPACE);
		assert.deepEqual(e.screen.lines(), ['$ abcdefg']);
		assert.deepEqual([e.screen.y, e.screen.x], [0, 9]);
		e.ed.feed('hi\r');
		assert.deepEqual(e.lines, ['abcdefghi']);
	});

	it('prompts with color codes count only visible characters', () => {
		const e = editor(10, '\x1b[1;32m$ \x1b[0m');
		e.ed.feed('abcdefghijkl');
		assert.deepEqual(e.screen.lines(), ['$ abcdefgh', 'ijkl']);
	});
});

function terminal(files: Record<string, string> = { 'hello.txt': 'Hello\n' }) {
	const ws = new FakeWorkspaceFs(files);
	const fs = new VfsFileSystem(ws, fakeUri);
	const shell = new GiteaShell({ fs, label: 'owner/repo@main', pending: () => [] });
	const screen = new Screen(80);
	const closes: number[] = [];
	const term = new ShellTerminal(shell, { write: (data) => screen.write(data), close: (code) => closes.push(code) });
	term.open(80);
	return { ws, screen, closes, term };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('ShellTerminal', () => {
	it('prints a banner and the prompt owner/repo@ref:cwd$', () => {
		const t = terminal();
		assert.match(t.screen.lines()[0], /Type "help"/);
		assert.equal(t.screen.lines().at(-1), 'owner/repo@main:~$');
	});

	it('runs a line, translates output to CRLF lines and shows the next prompt', async () => {
		const t = terminal();
		t.term.handleInput('cat hello.txt\r');
		await settle();
		assert.deepEqual(t.screen.lines().slice(-3), ['owner/repo@main:~$ cat hello.txt', 'Hello', 'owner/repo@main:~$']);
		assert.equal(t.screen.x, 'owner/repo@main:~$ '.length);
	});

	it('output without a trailing newline still starts the prompt on a new line', async () => {
		const t = terminal();
		t.term.handleInput('printf abc\r');
		await settle();
		assert.deepEqual(t.screen.lines().slice(-2), ['abc', 'owner/repo@main:~$']);
	});

	it('shows stderr, and cd changes the prompt', async () => {
		const t = terminal({ 'src/a.ts': 'x\n' });
		t.term.handleInput('cat nope\r');
		await settle();
		assert.ok(t.screen.lines().includes('cat: nope: No such file or directory'));
		t.term.handleInput('cd src\r');
		await settle();
		assert.equal(t.screen.lines().at(-1), 'owner/repo@main:~/src$');
	});

	it('Ctrl+D on an empty line and "exit" close the terminal once', async () => {
		const a = terminal();
		a.term.handleInput('\x04');
		a.term.handleInput('ls\r');
		await settle();
		assert.deepEqual(a.closes, [0]);
		const b = terminal();
		b.term.handleInput('exit 3\r');
		await settle();
		assert.deepEqual(b.closes, [3]);
	});

	it('Ctrl+C interrupts a running command and returns to the prompt', async () => {
		const t = terminal();
		t.term.handleInput('sleep 2; echo late > late.txt\r');
		await settle();
		t.term.handleInput('\x03');
		await new Promise((resolve) => setTimeout(resolve, 2600));
		assert.equal(t.ws.nodes.has('/late.txt'), false, 'the interrupted line stopped');
		assert.ok(t.screen.lines().includes('^C'));
		assert.equal(t.screen.lines().at(-1), 'owner/repo@main:~$');
		t.term.handleInput('echo back\r');
		await settle();
		assert.ok(t.screen.lines().includes('back'));
	});

	it('dispose stops output and input', async () => {
		const t = terminal();
		t.term.handleInput('echo late\r');
		t.term.dispose();
		await settle();
		assert.equal(t.screen.lines().includes('late'), false);
		t.term.handleInput('echo more\r');
		await settle();
		assert.equal(t.screen.lines().includes('more'), false);
	});

	it('keeps history for Up recall', async () => {
		const t = terminal();
		t.term.handleInput('echo one\r');
		await settle();
		t.term.handleInput(`${UP}\r`);
		await settle();
		assert.equal(t.screen.lines().filter((line) => line === 'one').length, 2);
	});

	it('writes made in the shell reach workspace.fs only', async () => {
		const t = terminal();
		t.term.handleInput('echo x > t.txt\r');
		await settle();
		assert.equal(t.ws.text('t.txt'), 'x\n');
		// A redirect truncates first, then writes: two writes, one file, no other mutation.
		assert.deepEqual([...new Set(t.ws.calls.filter((c) => /^(writeFile|createDirectory|delete|rename)/.test(c)))], ['writeFile /t.txt']);
	});
});

/** A workspace whose reads of `/gated.txt` wait until released, standing in for a command that ignores Ctrl+C. */
function gatedWorkspace() {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ws = new FakeWorkspaceFs({ 'gated.txt': 'late\n', 'src/a.ts': 'x\n' });
	const read = ws.readFile.bind(ws);
	ws.readFile = async (uri: string) => {
		if (uri === '/gated.txt') await gate;
		return read(uri);
	};
	const shell = new GiteaShell({ fs: new VfsFileSystem(ws, fakeUri), label: 'o/r@main', pending: () => [] });
	return { shell, release };
}

describe('GiteaShell after an interrupt', () => {
	it('refuses new lines while the interrupted one still runs, and its late result does not change the state', async () => {
		const { shell, release } = gatedWorkspace();
		const abort = new AbortController();
		const zombie = shell.run('cat gated.txt; cd src', abort.signal);
		await settle();
		abort.abort();
		const refused = await shell.run('echo hi');
		assert.equal(refused.stdout, '');
		assert.match(refused.stderr, /still stopping/);
		release();
		await zombie;
		assert.equal(shell.cwd, '/workspace', 'the abandoned cd did not apply');
		assert.equal((await shell.run('echo hi')).stdout, 'hi\n', 'the shell works again afterwards');
	});

	it('ignores a PWD that is not an absolute path', async () => {
		const { shell } = gatedWorkspace();
		await shell.run('PWD=nonsense');
		assert.equal(shell.cwd, '/workspace');
		assert.equal((await shell.run('pwd')).exitCode, 0);
	});
});

describe('LineEditor escape handling', () => {
	const lone = () => new Promise((resolve) => setTimeout(resolve, 120));

	it('a lone Esc does not swallow the next key', async () => {
		const e = editor();
		e.ed.feed('\x1b');
		await lone();
		e.ed.feed('a\r');
		assert.deepEqual(e.lines, ['a']);
	});

	it('ESC ESC [ A is one Up key, not inserted text', () => {
		const e = editor();
		submit(e, 'prev\r');
		e.ed.feed(`\x1b${UP}\r`);
		assert.deepEqual(e.lines, ['prev', 'prev']);
	});
});
