import type { Session } from './session.js';

export const MIN_INTERVAL_SECONDS = 15;
export const DEFAULT_INTERVAL_SECONDS = 60;
const MAX_BACKOFF_STEPS = 4;

/** Set only while the remote branch is ahead of the session base. */
export interface RemoteStatus {
	head: string;
	/** Commits the remote has beyond the base; undefined when unknown or too many to count. */
	incoming: number | undefined;
}

interface Timers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface RemoteWatcherDeps {
	session: Pick<Session, 'baseCommit' | 'remoteHead' | 'countIncoming'>;
	enabled(): boolean;
	/** Poll interval in seconds; values under the minimum are raised to it. */
	intervalSeconds(): number;
	isFocused(): boolean;
	onChange(status: RemoteStatus | undefined): void;
	log?(message: string): void;
	timers?: Timers;
	now?(): number;
}

export function clampInterval(seconds: unknown): number {
	const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_INTERVAL_SECONDS;
	return Math.max(MIN_INTERVAL_SECONDS, value);
}

/**
 * Polls the remote branch head while the window is focused. One request per poll; the
 * unpaged compare call runs once per new remote head, never per poll.
 */
export class RemoteWatcher {
	readonly #deps: RemoteWatcherDeps;
	readonly #timers: Timers;
	readonly #now: () => number;
	#handle: unknown;
	#running = false;
	/** Bumped by every start, so a tick from before a restart does not schedule a second chain. */
	#generation = 0;
	#status: RemoteStatus | undefined;
	#lastHead: string | undefined;
	#counted: { base: string; head: string; incoming: number | undefined } | undefined;
	#lastCheck = Number.NEGATIVE_INFINITY;
	#failures = 0;
	#inflight: Promise<RemoteStatus | undefined> | undefined;

	constructor(deps: RemoteWatcherDeps) {
		this.#deps = deps;
		this.#timers = deps.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as never) };
		this.#now = deps.now ?? Date.now;
	}

	get status(): RemoteStatus | undefined {
		return this.#status;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#generation++;
		this.#lastCheck = this.#now();
		this.#schedule();
	}

	stop(): void {
		this.#running = false;
		if (this.#handle !== undefined) this.#timers.clear(this.#handle);
		this.#handle = undefined;
	}

	/** Call when settings change: re-times the loop. */
	restart(): void {
		this.stop();
		this.start();
	}

	/** Call when the window gains focus: polls at once if the last poll is older than the interval. */
	focusGained(): void {
		if (!this.#running) return;
		if (this.#now() - this.#lastCheck >= this.#interval()) void this.#poll();
	}

	/** Call after the session base moved (refresh or commit). */
	baseMoved(): void {
		if (this.#status !== undefined && this.#lastHead === this.#deps.session.baseCommit) this.#set(undefined);
	}

	/** One poll; ignores focus and the enabled setting. */
	check(): Promise<RemoteStatus | undefined> {
		this.#inflight ??= this.#run().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	#interval(): number {
		return clampInterval(this.#deps.intervalSeconds()) * 1000;
	}

	#schedule(): void {
		const delay = this.#interval() * 2 ** Math.min(this.#failures, MAX_BACKOFF_STEPS);
		this.#handle = this.#timers.set(() => void this.#tick(), delay);
	}

	async #tick(): Promise<void> {
		const generation = this.#generation;
		if (!this.#running) return;
		if (this.#deps.isFocused()) await this.#poll();
		if (this.#running && generation === this.#generation) this.#schedule();
	}

	async #poll(): Promise<void> {
		if (!this.#deps.enabled()) return;
		try {
			await this.check();
			this.#failures = 0;
		} catch (error) {
			this.#failures += 1;
			this.#deps.log?.(`remote check failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #run(): Promise<RemoteStatus | undefined> {
		const { session } = this.#deps;
		this.#lastCheck = this.#now();
		const base = session.baseCommit;
		const head = await session.remoteHead();
		if (session.baseCommit !== base) return this.#run();
		this.#lastHead = head;
		if (head === undefined || head === base) {
			this.#set(undefined);
			return undefined;
		}
		if (this.#counted?.base !== base || this.#counted.head !== head) {
			const incoming = await session.countIncoming(head);
			if (session.baseCommit !== base) return this.#run();
			this.#counted = { base, head, incoming };
		}
		const next = { head, incoming: this.#counted?.incoming };
		this.#set(next);
		return next;
	}

	#set(next: RemoteStatus | undefined): void {
		const prev = this.#status;
		if (prev?.head === next?.head && prev?.incoming === next?.incoming) return;
		this.#status = next;
		this.#deps.onChange(next);
	}
}
