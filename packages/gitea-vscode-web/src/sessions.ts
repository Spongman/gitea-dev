import type { AuthRegistry, OAuthConfiguration } from './auth.js';
import { descriptorIdentity, identityForUri, parseDescriptor, queryForUri } from './descriptor.js';
import type { OverlayChannel } from './overlay.js';
import { Session, type RefsFactory, type RepositoryFactory } from './session.js';
import type { OverlayStorage } from './storage.js';
import { messageOf } from './util.js';

interface SessionRegistryOptions {
	storage: OverlayStorage;
	auth: AuthRegistry;
	createRepository?: RepositoryFactory;
	createRefs?: RefsFactory;
	/** Host-provided OAuth settings, when the host supports OAuth. */
	oauthConfiguration?: () => Promise<OAuthConfiguration | undefined>;
	log?: (message: string) => void;
	channel?: OverlayChannel;
}

/** Lazily opens one Session per repository ref found in URI queries. */
export class SessionRegistry {
	readonly #options: SessionRegistryOptions;
	readonly #pending = new Map<string, Promise<Session>>();
	readonly #open = new Map<string, Session>();
	readonly #listeners = new Set<(session: Session) => void>();
	#failure: unknown;

	constructor(options: SessionRegistryOptions) {
		this.#options = options;
	}

	onDidOpen(listener: (session: Session) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Sessions that finished opening. */
	get sessions(): Session[] {
		return [...this.#open.values()];
	}

	get lastFailure(): unknown {
		return this.#failure;
	}

	/** Resolves when every session requested so far has settled. */
	async settled(): Promise<void> {
		await Promise.allSettled([...this.#pending.values()]);
	}

	/** Like resolve, without parsing the descriptor again for a session already opening or open. */
	resolveUri(uri: { authority: string; query: string }): Promise<Session> {
		return this.#pending.get(identityForUri(uri)) ?? this.resolve(queryForUri(uri));
	}

	resolve(query: string): Promise<Session> {
		const descriptor = parseDescriptor(query);
		const identity = descriptorIdentity(descriptor);
		let pending = this.#pending.get(identity);
		if (!pending) {
			pending = this.#start(descriptor, identity);
			this.#pending.set(identity, pending);
			pending.catch((error: unknown) => {
				this.#failure = error;
				this.#pending.delete(identity);
			});
		}
		return pending;
	}

	async #start(descriptor: ReturnType<typeof parseDescriptor>, identity: string): Promise<Session> {
		const { auth, storage, createRepository, createRefs, channel } = this.#options;
		let oauth: OAuthConfiguration | undefined;
		try {
			oauth = await this.#options.oauthConfiguration?.();
		} catch {
			oauth = undefined;
		}
		await auth.restore(descriptor.instance, oauth);
		const session = await Session.open(descriptor, {
			storage,
			auth: auth.forInstance(descriptor.instance),
			createRepository,
			createRefs,
			channel,
		});
		this.#open.set(identity, session);
		this.#failure = undefined;
		this.#options.log?.(`opened ${descriptor.owner}/${descriptor.repository}@${descriptor.ref} base=${session.baseCommit}`);
		for (const listener of [...this.#listeners]) {
			// A failing listener must not fail the open, which would open the session again.
			try {
				listener(session);
			} catch (error) {
				this.#options.log?.(`session listener failed: ${messageOf(error)}`);
			}
		}
		return session;
	}
}
