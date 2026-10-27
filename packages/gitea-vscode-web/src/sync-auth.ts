import type * as vscode from 'vscode';

/** Must match contributes.authentication in the extension manifest and the host's sync config. */
export const SYNC_PROVIDER_ID = 'gitea';
const SYNC_PROVIDER_LABEL = 'Gitea';
/** Gitea token scopes the sync store needs: read:user (also GET /api/v1/user) and write:user. */
export const SYNC_SCOPES: readonly string[] = ['read:user', 'write:user'];

const TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type SessionsChange = vscode.AuthenticationProviderAuthenticationSessionsChangeEvent;

interface Emitter<T> {
	readonly event: vscode.Event<T>;
	fire(value: T): void;
	dispose(): void;
}

export interface SyncAuthDeps {
	/** Gitea instance URL; the same origin and path the repository sessions use. */
	instance: string;
	/**
	 * Current credential headers for the instance, as AuthProvider.headers(): `Authorization:
	 * token <pat>` or `Bearer <oauth>`, empty when signed out. Must load stored credentials
	 * first (AuthRegistry.restore) so sign-in works before any repository session opens.
	 */
	headers(): Promise<Record<string, string>>;
	/** Runs the existing interactive flow; true when credentials are now present. */
	signIn(): Promise<boolean>;
	/** Drops the instance credentials (AuthRegistry.signOut). */
	signOut(): Promise<void>;
	/** Fires after any sign-in, sign-out or token replacement, whoever caused it. */
	onDidChangeCredentials: vscode.Event<void>;
	/** Called when the provider newly holds a session, whether from a sign-in or restored credentials; `authorization` is the credential's own header value. */
	onSession?(session: vscode.AuthenticationSession, authorization: string): void;
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

/** The slice of the `vscode` module this file uses, so tests can supply a fake. */
export interface SyncAuthApi {
	authentication: Pick<typeof vscode.authentication, 'registerAuthenticationProvider'>;
	EventEmitter: new <T>() => Emitter<T>;
	commands: Pick<typeof vscode.commands, 'executeCommand'>;
}

/** Extracts the raw token from `token <t>` or `Bearer <t>`; undefined when absent or malformed. */
export function tokenFromHeaders(headers: Record<string, string>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== 'authorization') continue;
		const match = /^(?:token|bearer) (\S+)$/i.exec(value);
		return match && TOKEN.test(match[1]) ? match[1] : undefined;
	}
	return undefined;
}

class Rejected extends Error {}

/**
 * Request to the instance's REST API with the credential's own Authorization header value
 * (`token <pat>` or `Bearer <oauth>`), the form Gitea already accepted for it. No cookies, no redirects.
 */
export function giteaRequest(
	instance: string,
	path: string,
	authorization: string,
	init: { method?: string; body?: string; fetcher?: typeof fetch } = {},
): Promise<Response> {
	const fetcher = init.fetcher ?? ((input, options) => fetch(input, options));
	return fetcher(`${instance.replace(/\/+$/, '')}/api/v1${path}`, {
		method: init.method ?? 'GET',
		headers: { Authorization: authorization, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
		body: init.body,
		credentials: 'omit',
		redirect: 'error',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

interface Current {
	token: string;
	authorization: string;
	session: vscode.AuthenticationSession;
}

/**
 * Gitea account for native Settings Sync. The session's accessToken is the instance PAT or
 * OAuth access token, held in memory only; the account id is the numeric Gitea user id.
 */
export class GiteaAuthenticationProvider implements vscode.AuthenticationProvider {
	readonly onDidChangeSessions: vscode.Event<SessionsChange>;
	readonly #deps: SyncAuthDeps;
	readonly #emitter: Emitter<SessionsChange>;
	readonly #fetch: typeof fetch;
	#current: Current | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	#signingIn: Promise<vscode.AuthenticationSession> | undefined;

	constructor(deps: SyncAuthDeps, emitter: Emitter<SessionsChange>) {
		this.#deps = deps;
		this.#emitter = emitter;
		this.#fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
		this.onDidChangeSessions = emitter.event;
	}

	/** Only tokens for the scopes Settings Sync asked for are handed out. */
	#scopesAllowed(scopes: readonly string[] | undefined): boolean {
		return scopes === undefined || scopes.every((scope) => SYNC_SCOPES.includes(scope));
	}

	/** Serialized so overlapping calls validate one token once and fire one event. */
	#reconcile(): Promise<vscode.AuthenticationSession | undefined> {
		const run = this.#queue.then(() => this.#doReconcile());
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #doReconcile(): Promise<vscode.AuthenticationSession | undefined> {
		const previous = this.#current;
		let token: string | undefined;
		let authorization: string | undefined;
		try {
			const headers = await this.#deps.headers();
			token = tokenFromHeaders(headers);
			authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
		} catch {
			// Not knowing the credentials is not the same as having none: keep the session.
			this.#deps.log?.('Could not read the Gitea credentials.');
			return previous?.session;
		}
		let next: Current | undefined;
		if (token !== undefined && previous?.token === token) {
			next = previous;
		} else if (token !== undefined && authorization !== undefined) {
			try {
				next = { token, authorization, session: await this.#lookup(token, authorization) };
			} catch (error) {
				if (!(error instanceof Rejected)) {
					// A transient failure must not sign the user out of Settings Sync.
					this.#deps.log?.('Could not reach Gitea to validate the sign-in token.');
					return previous?.session;
				}
				this.#deps.log?.('Gitea rejected the sign-in token.');
				next = undefined;
			}
		}
		this.#current = next;
		if (next && previous?.session.id !== next.session.id) this.#deps.onSession?.(next.session, next.authorization);
		if (previous?.session.id !== next?.session.id) {
			// A different account is a removal plus an addition, not a change.
			this.#emitter.fire({
				added: next ? [next.session] : undefined,
				removed: previous ? [previous.session] : undefined,
				changed: undefined,
			});
		} else if (previous && next && previous.token !== next.token) {
			this.#emitter.fire({ added: undefined, removed: undefined, changed: [next.session] });
		}
		return next?.session;
	}

	/** `authorization` is the instance credential's own header, the form Gitea already accepted for it. */
	async #lookup(token: string, authorization: string): Promise<vscode.AuthenticationSession> {
		let res: Response;
		try {
			res = await giteaRequest(this.#deps.instance, '/user', authorization, { fetcher: this.#fetch });
		} catch {
			throw new Error('network');
		}
		if (res.status === 401 || res.status === 403) {
			await res.body?.cancel().catch(() => undefined);
			throw new Rejected();
		}
		const text = res.ok ? await res.text() : '';
		if (!res.ok || text.length > RESPONSE_LIMIT) throw new Error('unexpected response');
		const user = JSON.parse(text) as { id?: unknown; login?: unknown };
		if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('unexpected response');
		const login = typeof user.login === 'string' && user.login !== '' ? user.login : `user ${user.id}`;
		return {
			id: `${SYNC_PROVIDER_ID}:${user.id}`,
			accessToken: token,
			account: { id: String(user.id), label: login },
			// Gitea does not report a token's scopes, so these are claimed, not checked: the token may be broader (see README, Settings Sync).
			scopes: [...SYNC_SCOPES],
		};
	}

	async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const session = await this.#reconcile();
		return session && this.#scopesAllowed(scopes) ? [session] : [];
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		if (!this.#scopesAllowed(scopes)) throw new Error('Gitea sign-in only provides Settings Sync access.');
		this.#signingIn ??= this.#createSession().finally(() => {
			this.#signingIn = undefined;
		});
		return this.#signingIn;
	}

	async #createSession(): Promise<vscode.AuthenticationSession> {
		// Credentials the user already gave this editor are reused; nothing is prompted twice.
		let session = await this.#reconcile();
		if (!session) {
			if (!(await this.#deps.signIn())) throw new Error('Gitea sign-in was cancelled.');
			session = await this.#reconcile();
		}
		if (!session) throw new Error('Gitea did not accept the sign-in token.');
		return session;
	}

	async removeSession(sessionId: string): Promise<void> {
		if (this.#current?.session.id !== sessionId) return;
		// One credential serves both the repository and Settings Sync, so this signs out of both.
		await this.#deps.signOut();
		await this.#reconcile();
	}

	/** Re-reads the credentials; called when they may have changed. */
	async refresh(): Promise<void> {
		await this.#reconcile();
	}

	dispose(): void {
		this.#emitter.dispose();
		this.#current = undefined;
	}
}

/**
 * Signs in through the extension's existing commands: OAuth when the host configures it,
 * otherwise the personal access token prompt. Both resolve the instance from the open
 * workspace folder, so no repository session is needed.
 */
export function signInWithCommands(commands: SyncAuthApi['commands']): () => Promise<boolean> {
	return async () => {
		const oauth = await commands.executeCommand('giteaHost.authConfiguration').then((value) => value, () => undefined);
		const result = await commands.executeCommand<{ ok?: boolean } | undefined>(oauth ? 'gitea.signInOAuth' : 'gitea.signIn');
		return result?.ok === true;
	};
}

/**
 * Registers the 'gitea' authentication provider. Returns the provider (for tests and for
 * calling refresh) and a disposable that unregisters it.
 */
export function registerSyncAuthentication(
	api: SyncAuthApi,
	deps: SyncAuthDeps,
): { provider: GiteaAuthenticationProvider; dispose(): void } {
	const provider = new GiteaAuthenticationProvider(deps, new api.EventEmitter<SessionsChange>());
	const registration = api.authentication.registerAuthenticationProvider(SYNC_PROVIDER_ID, SYNC_PROVIDER_LABEL, provider, {
		supportsMultipleAccounts: false,
	});
	const subscription = deps.onDidChangeCredentials(() => {
		void provider.refresh();
	});
	return {
		provider,
		dispose() {
			subscription.dispose();
			registration.dispose();
			provider.dispose();
		},
	};
}
