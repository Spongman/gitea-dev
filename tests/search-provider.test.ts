import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

// search.ts imports the `vscode` module, which only exists inside the extension host: serve a small fake.
const statusMessages: string[] = [];
(globalThis as { __statusMessages?: string[] }).__statusMessages = statusMessages;
const fake = `
export class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }
export const window = { setStatusBarMessage: (message) => globalThis.__statusMessages.push(message) };
`;
register(
	`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
	if (specifier === 'vscode') return { url: 'data:text/javascript,${encodeURIComponent(fake)}', shortCircuit: true };
	return next(specifier, context);
}`)}`,
);
const { GiteaSearchProvider } = await import('../packages/gitea-vscode-web/src/search.js');

const folder = { path: '/', with: ({ path }: { path: string }) => ({ path }) };
const live = { isCancellationRequested: false };

function overlay(files: number, broken = false) {
	return {
		async readDirectory(path: string) {
			if (broken && path === 'bad') throw new Error('denied');
			if (path !== '') return [];
			const rows = Array.from({ length: files }, (_, i) => ({ name: `f${i}.txt`, type: 'file' }));
			return broken ? [...rows, { name: 'bad', type: 'directory' }] : rows;
		},
		async readFile() {
			return new Uint8Array();
		},
		async stat() {
			return { size: 0 };
		},
	};
}

const ask = (provider: InstanceType<typeof GiteaSearchProvider>) =>
	provider.provideFileSearchResults({ pattern: '' }, { folder, maxResults: 1000 } as never, live as never);

describe('file search notices', () => {
	it('says in the status bar when Quick Open stopped at the file limit', async () => {
		statusMessages.length = 0;
		const provider = new GiteaSearchProvider(async () => overlay(5) as never, { maxFiles: 3 });
		assert.equal((await ask(provider)).length, 3);
		assert.deepEqual(statusMessages, ['Quick Open lists only the first 3 files.']);
	});

	it('says so when a folder could not be listed, and stays quiet otherwise', async () => {
		statusMessages.length = 0;
		await ask(new GiteaSearchProvider(async () => overlay(2, true) as never));
		assert.deepEqual(statusMessages, ['1 folder(s) could not be listed.']);
		statusMessages.length = 0;
		await ask(new GiteaSearchProvider(async () => overlay(2) as never));
		assert.deepEqual(statusMessages, []);
	});
});
