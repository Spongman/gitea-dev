import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DEFAULT_INTERVAL_SECONDS,
	MIN_INTERVAL_SECONDS,
	RemoteWatcher,
	clampInterval,
	type RemoteStatus,
	type RemoteWatcherDeps,
} from '../packages/gitea-vscode-web/src/remote.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

class FakeTimers {
	pending: Array<{ id: number; callback: () => void; ms: number }> = [];
	#next = 1;

	set(callback: () => void, ms: number) {
		const id = this.#next++;
		this.pending.push({ id, callback, ms });
		return id;
	}

	clear(handle: unknown) {
		this.pending = this.pending.filter((timer) => timer.id !== handle);
	}

	/** Runs the oldest pending timer, as its delay elapsing would. */
	async fire(): Promise<void> {
		const timer = this.pending.shift();
		assert.ok(timer, 'no timer pending');
		timer.callback();
		await settle();
	}
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides: Partial<RemoteWatcherDeps> = {}) {
	const timers = new FakeTimers();
	const state = {
		base: A,
		head: A as string | undefined,
		incoming: 2 as number | undefined,
		focused: true,
		enabled: true,
		now: 1_000_000,
		heads: 0,
		counts: [] as string[],
		failNext: undefined as Error | undefined,
		gate: undefined as Promise<void> | undefined,
		changes: [] as Array<RemoteStatus | undefined>,
	};
	const watcher = new RemoteWatcher({
		session: {
			get baseCommit() {
				return state.base;
			},
			remoteHead: async () => {
				state.heads++;
				if (state.failNext) throw state.failNext;
				await state.gate;
				return state.head;
			},
			countIncoming: async (head: string) => {
				state.counts.push(head);
				return state.incoming;
			},
		},
		enabled: () => state.enabled,
		intervalSeconds: () => DEFAULT_INTERVAL_SECONDS,
		isFocused: () => state.focused,
		onChange: (status) => state.changes.push(status),
		timers,
		now: () => state.now,
		...overrides,
	});
	return { watcher, timers, state };
}

describe('clampInterval', () => {
	it('defaults to 60 seconds and never goes under 15', () => {
		assert.equal(clampInterval(undefined), 60);
		assert.equal(clampInterval('x'), 60);
		assert.equal(clampInterval(5), MIN_INTERVAL_SECONDS);
		assert.equal(clampInterval(120), 120);
	});
});

describe('RemoteWatcher polling', () => {
	it('waits one interval before the first request', async () => {
		const { watcher, timers, state } = harness();
		watcher.start();
		assert.equal(state.heads, 0);
		assert.deepEqual(timers.pending.map((t) => t.ms), [60_000]);
		watcher.stop();
		assert.equal(timers.pending.length, 0);
	});

	it('polls only while the window is focused, and keeps its schedule while unfocused', async () => {
		const { watcher, timers, state } = harness();
		watcher.start();
		state.focused = false;
		await timers.fire();
		assert.equal(state.heads, 0);
		assert.equal(timers.pending.length, 1);
		state.focused = true;
		await timers.fire();
		assert.equal(state.heads, 1);
	});

	it('makes no request when auto fetch is disabled', async () => {
		const { watcher, timers, state } = harness();
		watcher.start();
		state.enabled = false;
		await timers.fire();
		assert.equal(state.heads, 0);
	});

	it('uses the minimum interval when the setting is lower', () => {
		const { watcher, timers } = harness({ intervalSeconds: () => 3 });
		watcher.start();
		assert.deepEqual(timers.pending.map((t) => t.ms), [15_000]);
	});

	it('does not poll on focus before an interval has passed, and does after', async () => {
		const { watcher, state } = harness();
		watcher.start();
		watcher.focusGained();
		await settle();
		assert.equal(state.heads, 0);
		state.now += 61_000;
		watcher.focusGained();
		await settle();
		assert.equal(state.heads, 1);
	});

	it('backs off after failures and recovers on success', async () => {
		const logs: string[] = [];
		const { watcher, timers, state } = harness({ log: (m) => logs.push(m) });
		watcher.start();
		state.failNext = new Error('offline');
		await timers.fire();
		assert.equal(logs.length, 1);
		assert.match(logs[0], /offline/);
		assert.deepEqual(timers.pending.map((t) => t.ms), [120_000]);
		await timers.fire();
		assert.deepEqual(timers.pending.map((t) => t.ms), [240_000]);
		state.failNext = undefined;
		await timers.fire();
		assert.deepEqual(timers.pending.map((t) => t.ms), [60_000]);
	});
});

describe('RemoteWatcher status', () => {
	it('reports nothing while the remote head equals the base', async () => {
		const { watcher, state } = harness();
		assert.equal(await watcher.check(), undefined);
		assert.deepEqual(state.changes, []);
		assert.equal(state.counts.length, 0);
	});

	it('reports a newer head with its incoming count', async () => {
		const { watcher, state } = harness();
		state.head = B;
		assert.deepEqual(await watcher.check(), { head: B, incoming: 2 });
		assert.deepEqual(state.changes, [{ head: B, incoming: 2 }]);
		assert.deepEqual(watcher.status, { head: B, incoming: 2 });
	});

	it('compares once per new head, not per poll, and notifies once', async () => {
		const { watcher, state } = harness();
		state.head = B;
		await watcher.check();
		await watcher.check();
		await watcher.check();
		assert.deepEqual(state.counts, [B]);
		assert.equal(state.changes.length, 1);
		state.head = C;
		await watcher.check();
		assert.deepEqual(state.counts, [B, C]);
		assert.equal(state.changes.length, 2);
	});

	it('keeps an unknown count as unknown', async () => {
		const { watcher, state } = harness();
		state.head = B;
		state.incoming = undefined;
		assert.deepEqual(await watcher.check(), { head: B, incoming: undefined });
	});

	it('clears the status when the base moves to the remote head', async () => {
		const { watcher, state } = harness();
		state.head = B;
		await watcher.check();
		state.base = B;
		watcher.baseMoved();
		assert.equal(watcher.status, undefined);
		assert.deepEqual(state.changes, [{ head: B, incoming: 2 }, undefined]);
	});

	it('does not report a head that the base reached while the request was in flight', async () => {
		const { watcher, state } = harness();
		state.head = B;
		const original = state.counts;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const watcherWithGate = new RemoteWatcher({
			session: {
				get baseCommit() {
					return state.base;
				},
				remoteHead: async () => state.head,
				countIncoming: async (head: string) => {
					original.push(head);
					await gate;
					return 1;
				},
			},
			enabled: () => true,
			intervalSeconds: () => 60,
			isFocused: () => true,
			onChange: (status) => state.changes.push(status),
		});
		const pending = watcherWithGate.check();
		await settle();
		state.base = B;
		release();
		assert.equal(await pending, undefined);
		assert.deepEqual(state.changes, []);
		assert.equal(watcher.status, undefined);
	});

	it('drops a cached result that the base overtook while the head was being read', async () => {
		const { watcher, state } = harness();
		state.head = B;
		await watcher.check();
		let release!: () => void;
		state.gate = new Promise<void>((resolve) => (release = resolve));
		const pending = watcher.check();
		await settle();
		state.base = B;
		state.gate = undefined;
		release();
		assert.equal(await pending, undefined);
		assert.equal(watcher.status, undefined);
	});

	it('has nothing to report for a tag or deleted branch', async () => {
		const { watcher, state } = harness();
		state.head = undefined;
		assert.equal(await watcher.check(), undefined);
		assert.equal(state.counts.length, 0);
	});
});

describe('RemoteWatcher restart', () => {
	it('keeps one timer chain when restarted while a poll is in flight', async () => {
		const { watcher, timers, state } = harness();
		let release!: () => void;
		state.gate = new Promise<void>((resolve) => (release = resolve));
		watcher.start();
		await timers.fire();
		assert.equal(state.heads, 1);
		watcher.restart();
		release();
		await settle();
		await settle();
		assert.equal(timers.pending.length, 1);
	});
});
