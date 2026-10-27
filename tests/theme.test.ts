import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { colorSchemeOf, giteaTheme, rememberConfirmedScheme, startupColorScheme, themeDefaults } from '../packages/editor-host/src/theme.js';

const page = (theme: string) => `<!DOCTYPE html>\n<html lang="en-US" data-theme="${theme}">\n<head></head><body>${'x'.repeat(200_000)}</body></html>`;

function fakeFetch(body: string | Error, status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		if (body instanceof Error) throw body;
		return new Response(body, { status });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function memoryStorage() {
	const items = new Map<string, string>();
	return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

describe('colorSchemeOf', () => {
	it('maps Gitea theme names to light, dark or auto', () => {
		assert.equal(colorSchemeOf('gitea-dark'), 'dark');
		assert.equal(colorSchemeOf('gitea-light'), 'light');
		assert.equal(colorSchemeOf('gitea-auto'), 'auto');
		assert.equal(colorSchemeOf('arc-green'), 'auto');
		assert.equal(colorSchemeOf(undefined), 'auto');
	});
});

describe('themeDefaults', () => {
	it('selects the workbench default themes, or follows the OS for auto', () => {
		assert.deepEqual(themeDefaults('dark'), { 'workbench.colorTheme': 'Dark 2026' });
		assert.deepEqual(themeDefaults('light'), { 'workbench.colorTheme': 'Light 2026' });
		assert.deepEqual(themeDefaults('auto'), { 'window.autoDetectColorScheme': true });
	});
});

describe('giteaTheme', () => {
	it('reads data-theme from a cheap Gitea page (the 404 page, which renders the base template) with the session cookie', async () => {
		const { impl, calls } = fakeFetch(page('gitea-dark'), 404);
		assert.equal(await giteaTheme('https://git.example.com/gitea', impl), 'gitea-dark');
		assert.equal(calls[0].url, 'https://git.example.com/gitea/-/gitea-dev-theme-probe');
		assert.equal(calls[0].init?.credentials, 'same-origin');
		// Without it Gitea answers a bare "Not found." that has no theme.
		assert.equal(new Headers(calls[0].init?.headers).get('accept'), 'text/html');
	});

	it('still reads the theme when the probe path answers 200', async () => {
		assert.equal(await giteaTheme('https://git.example.com/', fakeFetch(page('gitea-light'), 200).impl), 'gitea-light');
	});

	it('returns undefined for an error page or a page without the attribute', async () => {
		assert.equal(await giteaTheme('https://git.example.com/', fakeFetch(page('gitea-dark'), 500).impl), undefined);
		assert.equal(await giteaTheme('https://git.example.com/', fakeFetch('<html lang="en"><body></body></html>').impl), undefined);
	});
});

describe('startupColorScheme', () => {
	it('uses the live theme and remembers it', async () => {
		const storage = memoryStorage();
		assert.equal(await startupColorScheme('https://git.example.com/', storage, fakeFetch(page('gitea-light')).impl), 'light');
		assert.equal(storage.getItem('gitea-dev:color-scheme'), 'light');
	});

	it('prefers a scheme confirmed through the API over the page, without fetching the page', async () => {
		const storage = memoryStorage();
		assert.equal(rememberConfirmedScheme(storage, 'dark'), true);
		const { impl, calls } = fakeFetch(page('gitea-light'));
		assert.equal(await startupColorScheme('https://git.example.com/', storage, impl), 'dark');
		assert.equal(calls.length, 0);
		assert.equal(rememberConfirmedScheme(storage, 'purple'), false, 'rejects values that are not a scheme');
	});

	it('falls back to the last scheme seen, then to auto, when Gitea cannot be read', async () => {
		const storage = memoryStorage();
		const offline = fakeFetch(new TypeError('Failed to fetch')).impl;
		assert.equal(await startupColorScheme('https://git.example.com/', storage, offline), 'auto');
		storage.setItem('gitea-dev:color-scheme', 'dark');
		assert.equal(await startupColorScheme('https://git.example.com/', storage, offline), 'dark');
	});
});
