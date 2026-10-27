import { RepositoryError, isRepositoryError } from '../errors.js';
import { readLimited } from '../http.js';
import { normalizeInstance } from '../path.js';
import type { AuthProvider } from '../types.js';
import { Redacted, constantTimeEqual } from './redact.js';
import { MemorySecretStore, type SecretStore } from './store.js';

const AUTHORIZE_PATH = '/login/oauth/authorize';
const TOKEN_PATH = '/login/oauth/access_token';
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 30_000;
const ERROR_CODE = /^[a-z_]{1,40}$/;
/** OAuth errors that mean the grant itself is gone, not that the server had a bad moment. */
const GRANT_REJECTED = new Set(['invalid_grant', 'invalid_client']);

export interface OAuthPkceOptions {
	instance: string;
	/** Public client id of the OAuth application registered on the instance. */
	clientId: string;
	/** Registered redirect URI; the callback must land on exactly this origin and path. */
	redirectUri: string;
	/** Token storage, for example VS Code secret storage. */
	secrets: SecretStore;
	/** Short-lived pending-authorization storage; defaults to memory. */
	session?: SecretStore;
	fetch?: typeof fetch;
	/** Random bytes source; defaults to crypto.getRandomValues. */
	random?: (length: number) => Uint8Array;
	now?: () => number;
}

interface StoredTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

interface PendingAuthorization {
	state: string;
	verifier: string;
	createdAt: number;
}

export class OAuthError extends RepositoryError {
	/** OAuth `error` code reported by the server or callback, when well formed. */
	readonly reason: string | undefined;

	constructor(message: string, reason?: string, status?: number) {
		super('unauthenticated', message, { status });
		this.reason = reason !== undefined && ERROR_CODE.test(reason) ? reason : undefined;
	}
}

function isGrantRejected(error: unknown): boolean {
	return error instanceof OAuthError && (error.status === 400 || error.status === 401) && error.reason !== undefined && GRANT_REJECTED.has(error.reason);
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function defaultRandom(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

/** OAuth2 Authorization Code with PKCE (S256) as a public client; no client secret. */
export class OAuthPkceAuth extends Redacted implements AuthProvider {
	protected readonly label = 'OAuthPkceAuth';
	readonly #instance: string;
	readonly #clientId: string;
	readonly #redirect: URL;
	readonly #secrets: SecretStore;
	readonly #session: SecretStore;
	readonly #fetch: typeof fetch;
	readonly #random: (length: number) => Uint8Array;
	readonly #now: () => number;
	readonly #tokenKey: string;
	readonly #pendingKey: string;
	#tokens: StoredTokens | undefined;
	#loaded = false;
	#refreshing: Promise<StoredTokens> | undefined;

	constructor(options: OAuthPkceOptions) {
		super();
		this.#instance = normalizeInstance(options.instance);
		if (typeof options.clientId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(options.clientId)) {
			throw new RepositoryError('invalid-argument', 'Invalid OAuth client id');
		}
		this.#clientId = options.clientId;
		try {
			this.#redirect = new URL(options.redirectUri);
		} catch {
			throw new RepositoryError('invalid-argument', 'Invalid redirect URI');
		}
		if ((this.#redirect.protocol !== 'https:' && this.#redirect.protocol !== 'http:') || this.#redirect.hash !== '') {
			throw new RepositoryError('invalid-argument', 'The redirect URI must be http(s) without a fragment');
		}
		const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
		if (typeof fetchImpl !== 'function') {
			throw new RepositoryError('invalid-argument', 'No fetch implementation available');
		}
		this.#fetch = fetchImpl;
		this.#secrets = options.secrets;
		this.#session = options.session ?? new MemorySecretStore();
		this.#random = options.random ?? defaultRandom;
		this.#now = options.now ?? Date.now;
		const prefix = `gitea-dev:oauth:${encodeURIComponent(this.#instance)}:${encodeURIComponent(this.#clientId)}`;
		this.#tokenKey = `${prefix}:tokens`;
		this.#pendingKey = `${prefix}:pending`;
	}

	async isSignedIn(): Promise<boolean> {
		return (await this.#load()) !== undefined;
	}

	/** Starts a login: stores the verifier and state, returns the URL to open. */
	async beginAuthorization(): Promise<{ url: string; state: string }> {
		const verifier = base64Url(this.#random(32));
		const state = base64Url(this.#random(24));
		const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
		const pending: PendingAuthorization = { state, verifier, createdAt: this.#now() };
		await this.#session.set(this.#pendingKey, JSON.stringify(pending));
		const url = new URL(`${this.#instance}${AUTHORIZE_PATH}`);
		url.searchParams.set('client_id', this.#clientId);
		url.searchParams.set('redirect_uri', this.#redirect.href);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		return { url: url.href, state };
	}

	/** Finishes a login from the redirect URL the browser landed on. */
	async completeAuthorization(callback: string | URL): Promise<void> {
		const pending = await this.#takePending();
		let url: URL;
		try {
			url = new URL(callback);
		} catch {
			throw new OAuthError('The callback is not a valid URL');
		}
		if (url.origin !== this.#redirect.origin || url.pathname !== this.#redirect.pathname) {
			throw new OAuthError('The callback does not match the registered redirect URI');
		}
		const state = url.searchParams.get('state');
		if (state === null || !constantTimeEqual(state, pending.state)) {
			throw new OAuthError('The callback state does not match');
		}
		const error = url.searchParams.get('error');
		if (error !== null) {
			throw new OAuthError('The authorization server denied the request', error);
		}
		const code = url.searchParams.get('code');
		if (code === null || code === '') {
			throw new OAuthError('The callback has no authorization code');
		}
		const tokens = await this.#requestTokens({
			grant_type: 'authorization_code',
			client_id: this.#clientId,
			code,
			redirect_uri: this.#redirect.href,
			code_verifier: pending.verifier,
		});
		await this.#save(tokens);
	}

	async headers(): Promise<Record<string, string>> {
		let tokens = await this.#load();
		if (tokens === undefined) {
			return {};
		}
		if (tokens.expiresAt !== undefined && tokens.expiresAt - REFRESH_SKEW_MS <= this.#now()) {
			tokens = await this.#refresh(tokens);
		}
		return { Authorization: `Bearer ${tokens.accessToken}` };
	}

	/** Forgets tokens locally; Gitea has no revocation endpoint, grants are revoked in user settings. */
	async logout(): Promise<void> {
		this.#tokens = undefined;
		this.#loaded = true;
		await Promise.all([this.#secrets.delete(this.#tokenKey), this.#session.delete(this.#pendingKey)]);
	}

	async #takePending(): Promise<PendingAuthorization> {
		const raw = await this.#session.get(this.#pendingKey);
		await this.#session.delete(this.#pendingKey);
		let pending: PendingAuthorization | undefined;
		try {
			pending = raw === undefined ? undefined : (JSON.parse(raw) as PendingAuthorization);
		} catch {
			pending = undefined;
		}
		if (pending === undefined || typeof pending.state !== 'string' || typeof pending.verifier !== 'string' || typeof pending.createdAt !== 'number') {
			throw new OAuthError('No authorization is pending');
		}
		if (this.#now() - pending.createdAt > PENDING_TTL_MS) {
			throw new OAuthError('The pending authorization expired');
		}
		return pending;
	}

	async #load(): Promise<StoredTokens | undefined> {
		if (!this.#loaded) {
			const raw = await this.#secrets.get(this.#tokenKey);
			try {
				const parsed = raw === undefined ? undefined : (JSON.parse(raw) as StoredTokens);
				this.#tokens = parsed !== undefined && typeof parsed.accessToken === 'string' ? parsed : undefined;
			} catch {
				this.#tokens = undefined;
			}
			this.#loaded = true;
		}
		return this.#tokens;
	}

	async #save(tokens: StoredTokens): Promise<void> {
		this.#tokens = tokens;
		this.#loaded = true;
		await this.#secrets.set(this.#tokenKey, JSON.stringify(tokens));
	}

	#refresh(current: StoredTokens): Promise<StoredTokens> {
		this.#refreshing ??= this.#doRefresh(current).finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #doRefresh(current: StoredTokens): Promise<StoredTokens> {
		if (current.refreshToken === undefined) {
			await this.logout();
			throw new OAuthError('The access token expired and cannot be refreshed');
		}
		try {
			const next = await this.#requestTokens({ grant_type: 'refresh_token', client_id: this.#clientId, refresh_token: current.refreshToken });
			next.refreshToken ??= current.refreshToken;
			await this.#save(next);
			return next;
		} catch (error) {
			if (isGrantRejected(error)) {
				await this.logout();
			}
			throw error;
		}
	}

	async #requestTokens(body: Record<string, string>): Promise<StoredTokens> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		let response: Response;
		let bytes: Uint8Array;
		try {
			response = await this.#fetch(`${this.#instance}${TOKEN_PATH}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify(body),
				credentials: 'omit',
				redirect: 'error',
				cache: 'no-store',
				signal: controller.signal,
			});
			bytes = await readLimited(response, RESPONSE_LIMIT).catch((error: unknown) => {
				if (isRepositoryError(error) && error.code === 'file-too-large') {
					return new Uint8Array(0);
				}
				throw error;
			});
		} catch {
			throw new RepositoryError('network', 'The token request failed');
		} finally {
			clearTimeout(timer);
		}
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		} catch {
			data = {};
		}
		if (response.status >= 500) {
			throw new RepositoryError('unavailable', 'The token endpoint is unavailable', { status: response.status });
		}
		if (response.status !== 200) {
			throw new OAuthError('The token request was rejected', typeof data.error === 'string' ? data.error : undefined, response.status);
		}
		const access = data.access_token;
		const refresh = data.refresh_token;
		const expiresIn = data.expires_in;
		if (typeof access !== 'string' || access === '' || (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer')) {
			throw new OAuthError('The token response is malformed');
		}
		const tokens: StoredTokens = { accessToken: access };
		if (typeof refresh === 'string' && refresh !== '') {
			tokens.refreshToken = refresh;
		}
		if (typeof expiresIn === 'number' && expiresIn > 0) {
			tokens.expiresAt = this.#now() + expiresIn * 1000;
		}
		return tokens;
	}
}
