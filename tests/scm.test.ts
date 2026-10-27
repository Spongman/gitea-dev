import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { beforeEach, describe, it } from 'node:test';
import type { RepositoryEntry, RepositoryFile } from '../packages/gitea-repository/src/types.js';
import { descriptorAuthority, type Descriptor } from '../packages/gitea-vscode-web/src/descriptor.js';
import { ChangeOverlay, type BaseReader } from '../packages/gitea-vscode-web/src/overlay.js';
import type { Session } from '../packages/gitea-vscode-web/src/session.js';
import type { StagedStore } from '../packages/gitea-vscode-web/src/staged.js';
import { MemoryOverlayStorage } from '../packages/gitea-vscode-web/src/storage.js';

const stub = new URL('./vscode-stub.ts', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === 'vscode' ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : n(s, c); }`)}`);
const vscode = await import(stub);
const { ScmManager, SessionScm } = await import('../packages/gitea-vscode-web/src/scm.js');

const enc = new TextEncoder();
const WRITE = { create: true, overwrite: true };
const DESCRIPTOR: Descriptor = { instance: 'https://git.example', owner: 'o', repository: 'r', ref: 'main', refKind: 'branch' };

class NotFound extends Error {
	readonly code = 'not-found';
}

const files = new Map([['a.txt', 'alpha'], ['b.txt', 'bravo']]);
const entry = (path: string): RepositoryEntry => {
	const text = files.get(path);
	if (path === '') return { path, name: '', type: 'directory', sha: 'd'.repeat(40), size: 0 };
	if (text === undefined) throw new NotFound(path);
	const sha = createHash('sha1').update(`blob ${text.length}\0${text}`).digest('hex');
	return { path, name: path, type: 'file', sha, size: text.length };
};
const base: BaseReader = {
	getEntry: async (path) => entry(path),
	readDirectory: async () => [...files.keys()].map(entry),
	readFile: async (path): Promise<RepositoryFile> => ({ entry: entry(path), content: enc.encode(files.get(path)) }),
};

async function session(descriptor: Descriptor = DESCRIPTOR): Promise<Session> {
	const overlay = await ChangeOverlay.open({
		key: { instance: DESCRIPTOR.instance, owner: 'o', repository: 'r', ref: 'refs/heads/main', baseCommit: 'c1' },
		storage: new MemoryOverlayStorage(),
		base,
	});
	return { descriptor, overlay, readonlyHint: descriptor.mode === 'readonly' } as unknown as Session;
}

const failingStore: StagedStore = {
	load: async () => {
		throw new Error('staged store broken');
	},
	save: async () => undefined,
};

beforeEach(() => vscode.testing.reset());

describe('commit selection', () => {
	it('asks before committing everything when the staged set could not be loaded, and logs why', async () => {
		const logs: string[] = [];
		const s = await session();
		await s.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		const view = new SessionScm(s, failingStore, (message: string) => logs.push(message));
		let asked = 0;
		assert.equal(await view.commitPaths(async () => (asked++, false)), null);
		assert.equal(asked, 1);
		assert.equal(await view.commitPaths(async () => true), undefined);
		assert.ok(logs.some((message) => message.includes('staged store broken')), logs.join('\n'));
	});

	it('commits the staged set, or everything without asking when nothing is staged', async () => {
		const s = await session();
		await s.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		await s.overlay.writeFile('b.txt', enc.encode('mine'), WRITE);
		const view = new SessionScm(s);
		const never = async () => assert.fail('no confirmation needed');
		assert.equal(await view.commitPaths(never), undefined);
		await view.stage(['b.txt']);
		assert.deepEqual(await view.commitPaths(never), ['b.txt']);
	});
});

type Control = InstanceType<typeof SessionScm>['sourceControl'];
const noteFor = (control: Control, text: string) => control.inputBox.validateInput?.(text, text.length) as { message: string; type: number } | undefined;
const INFORMATION = 2;

describe('commit UI', () => {
	it('names the branch and the shortcut in the input placeholder', async () => {
		const view = new SessionScm(await session());
		const { placeholder } = view.sourceControl.inputBox;
		assert.ok(placeholder.includes('main') && placeholder.includes('Ctrl+Enter'), placeholder);
		const tagged = new SessionScm(await session({ ...DESCRIPTOR, ref: 'refs/tags/v1', refKind: 'tag' }));
		assert.ok(tagged.sourceControl.inputBox.placeholder.includes('v1'), tagged.sourceControl.inputBox.placeholder);
		assert.ok(!tagged.sourceControl.inputBox.placeholder.includes('refs/tags'));
	});

	it('shows a Commit button that runs gitea.commit on the source control, enabled only with pending changes', async () => {
		const s = await session();
		const view = new SessionScm(s);
		const control = view.sourceControl;
		assert.equal(control.actionButton?.enabled, false);
		assert.equal(control.actionButton?.command.command, 'gitea.commit');
		assert.equal(control.actionButton?.command.title, 'Commit');
		assert.deepEqual(control.actionButton?.command.arguments, [control]);
		assert.deepEqual(control.acceptInputCommand?.arguments, [control]);
		await s.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		assert.equal(control.actionButton?.enabled, true);
		await view.stage(['a.txt']);
		assert.equal(control.actionButton?.enabled, true, 'staged changes still enable it');
		await view.unstageAll();
		assert.equal(control.actionButton?.enabled, true, 'unstaged changes still enable it');
	});

	it('disables the button again when the changes are gone', async () => {
		const s = await session();
		const view = new SessionScm(s);
		await s.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		assert.equal(view.sourceControl.actionButton?.enabled, true);
		await s.overlay.writeFile('a.txt', enc.encode('alpha'), WRITE);
		assert.equal(s.overlay.size, 0);
		assert.equal(view.sourceControl.actionButton?.enabled, false);
	});

	it('offers commit to a new branch as the secondary command', async () => {
		const view = new SessionScm(await session());
		const { secondaryCommands } = view.sourceControl.actionButton!;
		assert.equal(secondaryCommands?.length, 1);
		assert.equal(secondaryCommands?.[0]?.length, 1);
		assert.equal(secondaryCommands?.[0]?.[0]?.command, 'gitea.commitToNewBranch');
		assert.deepEqual(secondaryCommands?.[0]?.[0]?.arguments, [view.sourceControl]);
	});

	it('keeps the button disabled on a tag or a read-only editor even with changes', async () => {
		for (const descriptor of [{ ...DESCRIPTOR, ref: 'refs/tags/v1', refKind: 'tag' as const }, { ...DESCRIPTOR, mode: 'readonly' as const }]) {
			const s = await session(descriptor);
			const view = new SessionScm(s);
			await s.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
			assert.equal(view.sourceControl.actionButton?.enabled, false, JSON.stringify(descriptor));
		}
	});

	it('notes where the commit will go once there is a message, and nothing for an empty box', async () => {
		const view = new SessionScm(await session());
		assert.equal(noteFor(view.sourceControl, ''), undefined);
		assert.equal(noteFor(view.sourceControl, '  \n'), undefined);
		const note = noteFor(view.sourceControl, 'Fix it');
		assert.equal(note?.type, INFORMATION);
		assert.ok(note?.message.includes('directly') && note.message.includes('main'), note?.message);
	});

	it('says so instead when the ref cannot take commits', async () => {
		const tag = new SessionScm(await session({ ...DESCRIPTOR, ref: 'refs/tags/v1', refKind: 'tag' }));
		const note = noteFor(tag.sourceControl, 'Fix it');
		assert.equal(note?.type, INFORMATION);
		assert.ok(note?.message.includes('v1') && note.message.includes('read-only'), note?.message);
		assert.ok(!note?.message.includes('directly'));
		const commit = new SessionScm(await session({ ...DESCRIPTOR, ref: 'a'.repeat(40), refKind: 'commit' }));
		assert.ok(noteFor(commit.sourceControl, 'x')?.message.includes('read-only'));
		const readonly = new SessionScm(await session({ ...DESCRIPTOR, mode: 'readonly' }));
		assert.ok(noteFor(readonly.sourceControl, 'x')?.message.includes('read-only'));
	});
});

describe('explorer decorations', () => {
	it('fires only for paths whose pending status changed', async () => {
		const s = await session();
		const view = new SessionScm(s);
		await s.overlay.writeFile('a.txt', enc.encode('one'), WRITE);
		await s.overlay.writeFile('b.txt', enc.encode('two'), WRITE);
		const fired: string[][] = [];
		view.onDidChangeDecorations((uris: { path: string }[]) => fired.push(uris.map((uri) => uri.path)));
		await s.overlay.writeFile('b.txt', enc.encode('two again'), WRITE);
		await s.overlay.writeFile('c.txt', enc.encode('new'), WRITE);
		assert.deepEqual(fired, [['/c.txt']]);
	});

	it('does not parse the workspace descriptor again for every decorated file', async () => {
		const manager = new ScmManager();
		const s = await session();
		await s.overlay.writeFile('a.txt', enc.encode('mine'), WRITE);
		manager.attach(s);
		const authority = descriptorAuthority(DESCRIPTOR);
		const uris = Array.from({ length: 50 }, (_, i) => vscode.Uri.from({ scheme: 'gitea-vfs', authority, path: i === 0 ? '/a.txt' : `/f${i}.txt` }));
		manager.provideFileDecoration(uris[0]);
		const parse = JSON.parse;
		let parses = 0;
		JSON.parse = ((...args: Parameters<typeof parse>) => (parses++, parse(...args))) as typeof parse;
		let decorated: unknown[];
		try {
			decorated = uris.map((uri) => manager.provideFileDecoration(uri));
		} finally {
			JSON.parse = parse;
		}
		assert.equal((decorated[0] as { badge?: string } | undefined)?.badge, 'M');
		assert.equal(parses, 0);
	});
});
