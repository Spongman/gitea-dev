import { overlayIdentity } from './overlay.js';
import { decodeWorkspaceAuthority, encodeWorkspaceAuthority } from '../../gitea-repository/src/workspace-uri.js';

export type RefKind = 'branch' | 'tag' | 'commit';

export interface Descriptor {
	instance: string;
	owner: string;
	repository: string;
	ref: string;
	refKind?: RefKind;
	/** Hint that can only restrict: 'readonly' disables local edits. */
	mode?: 'readonly' | 'readwrite';
}

export const SCHEME = 'gitea-vfs';
export const BASE_SCHEME = 'gitea-base';
const AUTHORITY = 'repository';

export function descriptorAuthority(descriptor: Descriptor): string {
	return encodeWorkspaceAuthority(descriptor);
}

export function queryForUri(uri: { authority: string; query: string }): string {
	if (uri.authority === AUTHORITY && uri.query) return uri.query;
	if (uri.query) throw new Error('Workspace identity must be in its authority.');
	return decodeWorkspaceAuthority(uri.authority);
}

const KEYS = new Set(['instance', 'owner', 'repository', 'ref', 'refKind', 'mode']);
const CREDENTIAL_KEY = /token|password|passwd|secret|credential|auth|bearer|apikey|api_key/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX = 255;

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || value === '') throw new Error(`Launch descriptor: ${field} is required.`);
	if (value.length > MAX || CONTROL.test(value)) throw new Error(`Launch descriptor: ${field} is invalid.`);
	return value;
}

function parseInstance(value: unknown): string {
	const raw = text(value, 'instance');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Launch descriptor: instance is not a URL.');
	}
	const secure = url.protocol === 'https:';
	if (!secure && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
		throw new Error('Launch descriptor: instance must be https, or http on loopback.');
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error('Launch descriptor: instance must not carry credentials, query or fragment.');
	}
	return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Parses the JSON query of a gitea-vfs URI. Rejects anything credential-like. */
export function parseDescriptor(query: string): Descriptor {
	let json = query;
	if (!json.startsWith('{')) {
		try {
			json = decodeURIComponent(json);
		} catch {
			throw new Error('Launch descriptor: invalid encoding.');
		}
	}
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Error('Launch descriptor: not valid JSON.');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Launch descriptor: expected an object.');
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (CREDENTIAL_KEY.test(key)) throw new Error('Launch descriptor must not contain credentials.');
	}
	for (const key of Object.keys(record)) if (!KEYS.has(key)) delete record[key];
	const descriptor: Descriptor = {
		instance: parseInstance(record.instance),
		owner: text(record.owner, 'owner'),
		repository: text(record.repository, 'repository'),
		ref: text(record.ref, 'ref'),
	};
	if (descriptor.owner.includes('/') || descriptor.repository.includes('/')) {
		throw new Error('Launch descriptor: owner and repository must not contain "/".');
	}
	const { refKind, mode } = record;
	if (refKind !== undefined) {
		if (refKind !== 'branch' && refKind !== 'tag' && refKind !== 'commit') {
			throw new Error('Launch descriptor: refKind must be branch, tag or commit.');
		}
		descriptor.refKind = refKind;
	}
	if (mode !== undefined) {
		if (mode !== 'readonly' && mode !== 'readwrite') {
			throw new Error('Launch descriptor: mode must be readonly or readwrite.');
		}
		descriptor.mode = mode;
	}
	return descriptor;
}

/** Stable key for a repository ref, independent of hints. */
export function descriptorIdentity(descriptor: Descriptor): string {
	return overlayIdentity({ ...descriptor, ref: repositoryRef(descriptor) });
}

const identities = new Map<string, string>();
const MAX_IDENTITIES = 64;

/** descriptorIdentity of a workspace URI, cached: decorations and file calls ask for every file. */
export function identityForUri(uri: { authority: string; query: string }): string {
	const key = `${uri.authority}?${uri.query}`;
	let identity = identities.get(key);
	if (identity === undefined) {
		identity = descriptorIdentity(parseDescriptor(queryForUri(uri)));
		if (identities.size >= MAX_IDENTITIES) identities.clear();
		identities.set(key, identity);
	}
	return identity;
}

/** Ref string for the repository client; prefixes force the ref kind. */
export function repositoryRef(descriptor: Descriptor): string {
	const { ref, refKind } = descriptor;
	if (ref.startsWith('refs/')) return ref;
	if (refKind === 'branch') return `refs/heads/${ref}`;
	if (refKind === 'tag') return `refs/tags/${ref}`;
	return ref;
}
