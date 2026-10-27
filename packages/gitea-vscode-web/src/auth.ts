import {
	MemorySecretStore,
	OAuthError,
	OAuthPkceAuth,
	PersonalAccessTokenAuth,
	type AuthProvider,
	type SecretStore,
} from '../../gitea-repository/src/index.js';

export interface OAuthConfiguration {
	clientId: string;
	redirectUri: string;
}

type AuthKind = 'pat' | 'oauth';

/**
 * Sign-in without UI through the Gitea web session and an already granted OAuth app: loads the
 * authorize URL invisibly and resolves the callback URL, or undefined.
 */
export type SilentAuthorize = (url: string) => Promise<string | undefined>;

/** Falls back to memory when the primary secret store throws; never logs values. */
export class FallbackSecrets implements SecretStore {
	readonly #primary: SecretStore;
	readonly #memory = new Map<string, string>();
	#degraded = false;

	constructor(primary: SecretStore) {
		this.#primary = primary;
	}

	get degraded(): boolean {
		return this.#degraded;
	}

	async get(key: string): Promise<string | undefined> {
		const local = this.#memory.get(key);
		if (local !== undefined) return local;
		try {
			return await this.#primary.get(key);
		} catch {
			this.#degraded = true;
			return undefined;
		}
	}

	async set(key: string, value: string): Promise<void> {
		try {
			await this.#primary.set(key, value);
			this.#memory.delete(key);
		} catch {
			this.#degraded = true;
			this.#memory.set(key, value);
		}
	}

	async delete(key: string): Promise<void> {
		this.#memory.delete(key);
		try {
			await this.#primary.delete(key);
		} catch {
			this.#degraded = true;
		}
	}
}

/** Per-instance credential holder; repositories keep one stable reference to it. */
class InstanceAuth implements AuthProvider {
	readonly credentials = 'omit' as const;
	readonly pat = new PersonalAccessTokenAuth();
	oauth: OAuthPkceAuth | undefined;
	kind: AuthKind | undefined;
	/** The one silent attempt made on restore. */
	silent: Promise<boolean> | undefined;
	/** Silent re-authorization after a rejected refresh; set by AuthRegistry. */
	renew: (() => Promise<boolean>) | undefined;
	/** Bumped by sign-out; a silent sign-in started before it must not apply. */
	generation = 0;
	#renewal: { from: OAuthPkceAuth; done: Promise<boolean> } | undefined;

	async headers(): Promise<Record<string, string>> {
		if (this.kind === 'pat') return this.pat.headers();
		if (this.kind === 'oauth' && this.oauth) {
			const current = this.oauth;
			try {
				return await current.headers();
			} catch (error) {
				if (!(error instanceof OAuthError) || !this.renew) throw error;
				// One attempt per rejected provider; concurrent callers share it.
				if (this.#renewal?.from !== current) this.#renewal = { from: current, done: this.renew() };
				if (!(await this.#renewal.done) || this.oauth === current) throw error;
				return this.oauth.headers();
			}
		}
		return {};
	}

	async logout(): Promise<void> {
		this.kind = undefined;
		await this.pat.logout();
		await this.oauth?.logout();
	}
}

export class AuthRegistry {
	readonly #secrets: SecretStore;
	/** OAuth tokens stay in memory; the Gitea session restores them silently. */
	readonly #oauthTokens = new MemorySecretStore();
	readonly #fetch: typeof fetch | undefined;
	readonly #silent: SilentAuthorize | undefined;
	readonly #instances = new Map<string, InstanceAuth>();

	constructor(secrets: SecretStore, fetchImpl?: typeof fetch, silent?: SilentAuthorize) {
		this.#secrets = secrets;
		this.#fetch = fetchImpl;
		this.#silent = silent;
	}

	#entry(instance: string): InstanceAuth {
		let entry = this.#instances.get(instance);
		if (!entry) {
			entry = new InstanceAuth();
			this.#instances.set(instance, entry);
		}
		return entry;
	}

	#patKey(instance: string): string {
		return `gitea-dev:pat:${encodeURIComponent(instance)}`;
	}

	#signedOutKey(instance: string): string {
		return `gitea-dev:signed-out:${encodeURIComponent(instance)}`;
	}

	/** Stable provider to hand to repositories for this instance. */
	forInstance(instance: string): AuthProvider {
		return this.#entry(instance);
	}

	kind(instance: string): AuthKind | undefined {
		return this.#instances.get(instance)?.kind;
	}

	/** Loads stored credentials, if any, for the instance. */
	async restore(instance: string, oauth?: OAuthConfiguration): Promise<void> {
		const entry = this.#entry(instance);
		if (entry.kind !== undefined) return;
		const token = await this.#secrets.get(this.#patKey(instance));
		if (token !== undefined) {
			try {
				entry.pat.setToken(token);
				entry.kind = 'pat';
				return;
			} catch {
				await this.#secrets.delete(this.#patKey(instance));
			}
		}
		if (oauth) {
			const provider = this.#oauth(instance, oauth);
			if (await provider.isSignedIn()) {
				entry.oauth = provider;
				entry.kind = 'oauth';
				entry.renew = () => this.#signInSilent(instance, oauth);
				return;
			}
			// Once per load, and not after an explicit sign-out.
			if (this.#silent && (await this.#secrets.get(this.#signedOutKey(instance))) === undefined) {
				entry.silent ??= this.#signInSilent(instance, oauth);
				await entry.silent;
			}
		}
	}

	#oauth(instance: string, config: OAuthConfiguration): OAuthPkceAuth {
		return new OAuthPkceAuth({
			instance,
			clientId: config.clientId,
			redirectUri: config.redirectUri,
			secrets: this.#oauthTokens,
			fetch: this.#fetch,
		});
	}

	/** Resolves false on any failure; the caller falls back to interactive sign-in. */
	async #signInSilent(instance: string, config: OAuthConfiguration): Promise<boolean> {
		if (!this.#silent) return false;
		const entry = this.#entry(instance);
		const generation = entry.generation;
		try {
			const provider = this.#oauth(instance, config);
			const { url } = await provider.beginAuthorization();
			const callback = await this.#silent(url);
			if (callback === undefined) return false;
			await provider.completeAuthorization(callback);
			if (entry.generation !== generation) {
				await provider.logout();
				return false;
			}
			if (entry.kind !== undefined && entry.kind !== 'oauth') return false;
			entry.oauth = provider;
			entry.kind = 'oauth';
			entry.renew = () => this.#signInSilent(instance, config);
			return true;
		} catch {
			return false;
		}
	}

	async signInPat(instance: string, token: string): Promise<void> {
		const entry = this.#entry(instance);
		entry.pat.setToken(token.trim());
		await this.#secrets.set(this.#patKey(instance), token.trim());
		entry.kind = 'pat';
	}

	/** Runs the PKCE flow; `authorize` opens the URL and returns the callback URL. */
	async signInOAuth(
		instance: string,
		config: OAuthConfiguration,
		authorize: (url: string) => Promise<string>,
	): Promise<void> {
		const entry = this.#entry(instance);
		const provider = this.#oauth(instance, config);
		const { url } = await provider.beginAuthorization();
		await provider.completeAuthorization(await authorize(url));
		entry.oauth = provider;
		entry.kind = 'oauth';
		entry.renew = () => this.#signInSilent(instance, config);
		await this.#secrets.delete(this.#signedOutKey(instance));
	}

	async signOut(instance: string): Promise<void> {
		const entry = this.#entry(instance);
		entry.generation++;
		await entry.logout();
		await this.#secrets.delete(this.#patKey(instance));
		// Not a secret; kept in the persistent store so a reload does not sign in again silently.
		await this.#secrets.set(this.#signedOutKey(instance), '1');
	}
}
