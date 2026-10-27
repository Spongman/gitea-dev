import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COLOR_SCHEME_COMMAND, CONFIRM_COLOR_SCHEME_COMMAND, ThemeConfirmation, userTheme } from '../packages/gitea-vscode-web/src/theme-confirm.js';

function settingsFetch(theme: string | undefined, status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(theme === undefined ? {} : { theme }), { status, headers: { 'Content-Type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { fetcher, calls };
}

function harness(started: string | undefined, theme: string | undefined) {
	const executed: unknown[][] = [];
	const messages: string[] = [];
	const { fetcher, calls } = settingsFetch(theme);
	const confirmation = new ThemeConfirmation({
		instance: 'https://git.example.com/gitea/',
		fetcher,
		commands: { executeCommand: (async (id: string, ...args: unknown[]) => { executed.push([id, ...args]); return id === COLOR_SCHEME_COMMAND ? started : undefined; }) as never },
		window: { showInformationMessage: (async (message: string) => { messages.push(message); return undefined; }) as never },
	});
	return { confirmation, executed, messages, calls };
}

describe('userTheme', () => {
	it('reads the theme user setting with the credential\'s own Authorization header', async () => {
		const { fetcher, calls } = settingsFetch('gitea-dark');
		assert.equal(await userTheme('https://git.example.com/gitea/', 'token tok', fetcher), 'gitea-dark');
		assert.equal(calls[0].url, 'https://git.example.com/gitea/api/v1/user/settings');
		assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'token tok');
		assert.equal(calls[0].init?.credentials, 'omit');
	});

	it('is undefined on an error status or a missing field', async () => {
		assert.equal(await userTheme('https://g/', 'Bearer t', settingsFetch('gitea-dark', 401).fetcher), undefined);
		assert.equal(await userTheme('https://g/', 'Bearer t', settingsFetch(undefined).fetcher), undefined);
	});
});

describe('ThemeConfirmation', () => {
	it('does nothing when the editor already started with the setting\'s scheme', async () => {
		const h = harness('dark', 'gitea-dark');
		assert.equal(await h.confirmation.onSession('Bearer t'), 'match');
		assert.deepEqual(h.executed, [[COLOR_SCHEME_COMMAND]]);
		assert.deepEqual(h.messages, []);
	});

	it('remembers the setting\'s scheme and offers a reload on a mismatch', async () => {
		const h = harness('light', 'gitea-dark');
		assert.equal(await h.confirmation.onSession('Bearer t'), 'updated');
		assert.deepEqual(h.executed, [[COLOR_SCHEME_COMMAND], [CONFIRM_COLOR_SCHEME_COMMAND, 'dark']]);
		assert.equal(h.messages.length, 1);
		assert.match(h.messages[0], /dark/);
	});

	it('checks once per load, but retries after the setting could not be read', async () => {
		const h = harness('light', 'gitea-dark');
		await h.confirmation.onSession('Bearer t');
		assert.equal(await h.confirmation.onSession('Bearer t'), 'match');
		assert.equal(h.calls.length, 1);
		const failed = harness('light', undefined);
		assert.equal(await failed.confirmation.onSession('Bearer t'), 'unknown');
		await failed.confirmation.onSession('Bearer t');
		assert.equal(failed.calls.length, 2);
	});
});
