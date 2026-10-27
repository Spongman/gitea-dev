import { readFile } from 'node:fs/promises';
import { AssetError, type AssetPin } from './types.js';

interface PinOptions {
	// file:// URLs are for tests and offline imports only; production is https.
	allowFileUrls?: boolean;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const PIN_KEYS = new Set(['version', 'commit', 'url', 'sha256']);

const bad = (message: string): never => {
	throw new AssetError('bad-pin', message);
};

export function parsePin(value: unknown, options: PinOptions = {}): AssetPin {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return bad('pin must be an object');
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!PIN_KEYS.has(key)) bad(`unknown pin field "${key}"`);
	}
	const { version, commit, url, sha256 } = record;
	if (typeof version !== 'string' || !VERSION_RE.test(version)) {
		return bad('pin.version must be an explicit semver (no "latest")');
	}
	if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
		return bad('pin.commit must be 40 lowercase hex chars');
	}
	if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
		return bad('pin.sha256 must be 64 hex chars');
	}
	if (typeof url !== 'string') return bad('pin.url must be a string');
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return bad('pin.url is not a valid URL');
	}
	if (parsed.username || parsed.password) bad('pin.url must not embed credentials');
	if (parsed.protocol === 'file:') {
		if (!options.allowFileUrls) bad('file:// pin.url requires allowFileUrls');
	} else if (parsed.protocol !== 'https:') {
		bad('pin.url must be https');
	}
	return { version, commit, url, sha256: sha256.toLowerCase() };
}

export async function loadPin(path: string, options: PinOptions = {}): Promise<AssetPin> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		throw new AssetError('bad-pin', `cannot read pin file ${path}`, { cause: error });
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new AssetError('bad-pin', `pin file ${path} is not valid JSON`, { cause: error });
	}
	return parsePin(json, options);
}
