import { RepositoryError } from '../errors.js';
import { readLimited } from '../http.js';
import { normalizeInstance } from '../path.js';
import type { AuthProvider } from '../types.js';

export const SESSION_BRIDGE_VERSION = 1;
export const DEFAULT_BRIDGE_DESCRIPTOR_PATH = '/-/web-ide/session';
const CSRF_HEADER = 'X-Csrf-Token';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DESCRIPTOR_LIMIT = 16 * 1024;

export interface SessionBridgeDescriptor {
	version: 1;
	/** Per-session CSRF token for mutations; not an API credential. */
	csrfToken: string;
	/** Seconds the descriptor stays valid. */
	expiresIn?: number;
}

export interface SessionBridgeOptions {
	instance: string;
	fetch?: typeof fetch;
	/** Path of the bridge descriptor endpoint below the instance. */
	descriptorPath?: string;
	now?: () => number;
}

/** The server does not implement the session bridge; no fallback is attempted. */
export class SessionBridgeUnavailableError extends RepositoryError {
	constructor(reason: string) {
		super('unsupported', `Gitea session bridge unavailable: ${reason}`);
	}
}

/**
 * Contract for the session bridge (docs/session-bridge.md). Stock Gitea v1.24.6
 * has no such endpoint, so against it this provider fails with
 * SessionBridgeUnavailableError. It never substitutes another credential.
 */
export class GiteaSessionBridgeAuth implements AuthProvider {
	readonly credentials = 'same-origin';
	readonly #url: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#cached: { csrfToken: string; expiresAt: number } | undefined;
	#probing: Promise<string> | undefined;

	constructor(options: SessionBridgeOptions) {
		const path = options.descriptorPath ?? DEFAULT_BRIDGE_DESCRIPTOR_PATH;
		if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('..')) {
			throw new RepositoryError('invalid-argument', 'Invalid bridge descriptor path');
		}
		this.#url = `${normalizeInstance(options.instance)}${path}`;
		const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
		if (typeof fetchImpl !== 'function') {
			throw new RepositoryError('invalid-argument', 'No fetch implementation available');
		}
		this.#fetch = fetchImpl;
		this.#now = options.now ?? Date.now;
	}

	async headers(): Promise<Record<string, string>> {
		if (this.#cached !== undefined && this.#cached.expiresAt > this.#now()) {
			return { [CSRF_HEADER]: this.#cached.csrfToken };
		}
		this.#probing ??= this.#probe().finally(() => {
			this.#probing = undefined;
		});
		return { [CSRF_HEADER]: await this.#probing };
	}

	/** Drops the cached CSRF token, for example after a 403 from a mutation. */
	invalidate(): void {
		this.#cached = undefined;
	}

	/** Only forgets the CSRF token; the Gitea web session is ended in Gitea itself. */
	async logout(): Promise<void> {
		this.#cached = undefined;
	}

	async #probe(): Promise<string> {
		let response: Response;
		try {
			response = await this.#fetch(this.#url, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				credentials: 'same-origin',
				redirect: 'error',
				cache: 'no-store',
			});
		} catch {
			throw new SessionBridgeUnavailableError('descriptor request failed');
		}
		if (response.status === 401 || response.status === 403) {
			throw new RepositoryError('unauthenticated', 'Not signed in to Gitea', { status: response.status });
		}
		if (response.status !== 200) {
			throw new SessionBridgeUnavailableError(`descriptor endpoint answered ${response.status}`);
		}
		const descriptor = await this.#parse(response);
		const ttl = descriptor.expiresIn === undefined ? DEFAULT_TTL_MS : Math.min(descriptor.expiresIn * 1000, DEFAULT_TTL_MS);
		this.#cached = { csrfToken: descriptor.csrfToken, expiresAt: this.#now() + ttl };
		return descriptor.csrfToken;
	}

	async #parse(response: Response): Promise<SessionBridgeDescriptor> {
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(await readLimited(response, DESCRIPTOR_LIMIT)));
		} catch {
			throw new SessionBridgeUnavailableError('descriptor is not valid JSON');
		}
		const descriptor = value as Partial<SessionBridgeDescriptor> | null;
		const valid =
			descriptor !== null &&
			typeof descriptor === 'object' &&
			descriptor.version === SESSION_BRIDGE_VERSION &&
			typeof descriptor.csrfToken === 'string' &&
			/^[\x21-\x7e]{16,512}$/.test(descriptor.csrfToken) &&
			(descriptor.expiresIn === undefined || (typeof descriptor.expiresIn === 'number' && descriptor.expiresIn > 0));
		if (!valid) {
			throw new SessionBridgeUnavailableError('descriptor does not match contract version 1');
		}
		return descriptor as SessionBridgeDescriptor;
	}
}
