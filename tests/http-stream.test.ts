// GiteaHttp.stream: status mapping, size caps, a per-chunk idle timeout instead of a total
// timeout, and abort handling.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RepositoryError } from '../packages/gitea-repository/src/errors.js';
import { DEFAULT_LIMITS, GiteaHttp, type StreamRequest } from '../packages/gitea-repository/src/http.js';
import type { AuthProvider } from '../packages/gitea-repository/src/types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bytes = (text: string) => new TextEncoder().encode(text);

interface Call {
	url: string;
	init: RequestInit;
}

type Step = Uint8Array | number | 'stall';

/** A body that, like fetch, errors when the request signal aborts. Numbers are delays in ms. */
function body(signal: AbortSignal | null | undefined, steps: Step[], events: { cancelled: boolean } = { cancelled: false }): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const step = steps[i++];
				if (step === undefined) {
					controller.close();
					return;
				}
				if (typeof step === 'number') {
					await sleep(step);
					continue;
				}
				if (step === 'stall') {
					await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
					controller.error(new DOMException('aborted', 'AbortError'));
					return;
				}
				controller.enqueue(step);
				return;
			}
		},
		cancel() {
			events.cancelled = true;
		},
	}, { highWaterMark: 0 });
}

function harness(respond: (call: Call) => Response | Promise<Response>, auth?: AuthProvider, limits = DEFAULT_LIMITS) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init: init as RequestInit };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return { http: new GiteaHttp('https://git.example/sub/api/v1', fetchImpl, auth, limits), calls };
}

const request = (extra: Partial<StreamRequest> = {}): StreamRequest => ({ path: '/repos/o/r/archive/abc.tar.gz', maxBytes: 1024 * 1024, idleTimeoutMs: 1000, ...extra });

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return text;
		}
		text += new TextDecoder().decode(value);
	}
}

async function rejects(promise: Promise<unknown>, code: RepositoryError['code']): Promise<RepositoryError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
		assert.equal(error.code, code, error.message);
		return error;
	}
	assert.fail('expected rejection');
}

describe('GiteaHttp.stream', () => {
	it('streams the body in order and sends a same-origin-safe GET with auth headers', async () => {
		const auth: AuthProvider = { headers: async () => ({ Authorization: 'token secret' }) };
		const { http, calls } = harness((call) => new Response(body(call.init.signal, [bytes('ab'), bytes('cd'), bytes('ef')]), { status: 200 }), auth);
		const stream = await http.stream(request({ query: { rev: 'x y' } }));
		assert.equal(await readAll(stream), 'abcdef');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, 'https://git.example/sub/api/v1/repos/o/r/archive/abc.tar.gz?rev=x+y');
		assert.equal(calls[0].init.method, 'GET');
		assert.equal(calls[0].init.redirect, 'error');
		assert.equal(calls[0].init.credentials, 'omit');
		assert.equal(calls[0].init.cache, 'no-store');
		assert.deepEqual(calls[0].init.headers, { Authorization: 'token secret', Accept: '*/*' });
	});

	it('uses the auth provider credentials mode', async () => {
		const auth: AuthProvider = { headers: async () => ({}), credentials: 'same-origin' };
		const { http, calls } = harness(() => new Response('ok'), auth);
		await readAll(await http.stream(request()));
		assert.equal(calls[0].init.credentials, 'same-origin');
	});

	it('maps error statuses before returning a stream', async () => {
		for (const [status, code] of [[404, 'not-found'], [401, 'unauthenticated'], [403, 'forbidden'], [429, 'rate-limited'], [503, 'unavailable']] as const) {
			const { http } = harness(() => new Response(JSON.stringify({ message: 'nope' }), { status }));
			const error = await rejects(http.stream(request()), code);
			assert.equal(error.status, status);
		}
		const { http } = harness(() => new Response('{}', { status: 404 }));
		const mapped = await rejects(http.stream(request(), (status) => new RepositoryError('unsupported', `custom ${status}`)), 'unsupported');
		assert.equal(mapped.message, 'custom 404');
	});

	it('does not retry', async () => {
		const { http, calls } = harness(() => new Response('{}', { status: 503 }));
		await rejects(http.stream(request()), 'unavailable');
		assert.equal(calls.length, 1);
	});

	it('rejects a declared length over the cap without reading the body', async () => {
		const events = { cancelled: false };
		const { http } = harness((call) => new Response(body(call.init.signal, [bytes('x')], events), { status: 200, headers: { 'content-length': '5000' } }));
		await rejects(http.stream(request({ maxBytes: 100 })), 'file-too-large');
		assert.equal(events.cancelled, true);
	});

	it('fails with file-too-large when the body outgrows the cap, and cancels upstream', async () => {
		const events = { cancelled: false };
		const { http } = harness((call) => new Response(body(call.init.signal, [bytes('x'.repeat(60)), bytes('y'.repeat(60)), bytes('z')], events), { status: 200 }));
		const stream = await http.stream(request({ maxBytes: 100 }));
		await rejects(readAll(stream), 'file-too-large');
		assert.equal(events.cancelled, true);
	});

	it('times out a stalled body per chunk and reports a network error', async () => {
		let signal: AbortSignal | null | undefined;
		const { http } = harness((call) => {
			signal = call.init.signal;
			return new Response(body(call.init.signal, [bytes('first'), 'stall']), { status: 200 });
		});
		const stream = await http.stream(request({ idleTimeoutMs: 40 }));
		const reader = stream.getReader();
		assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
		const started = Date.now();
		await rejects(reader.read(), 'network');
		assert.ok(Date.now() - started < 1000);
		assert.equal(signal?.aborted, true);
	});

	it('times out even when the underlying body ignores the abort signal', async () => {
		const { http } = harness(() => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }, { highWaterMark: 0 }), { status: 200 }));
		const stream = await http.stream(request({ idleTimeoutMs: 30 }));
		await rejects(readAll(stream), 'network');
	});

	it('has no total timeout: a long body with steady chunks completes', async () => {
		const steps: Step[] = [];
		for (let i = 0; i < 10; i++) {
			steps.push(15, bytes('x'));
		}
		const { http } = harness((call) => new Response(body(call.init.signal, steps), { status: 200 }), undefined, { ...DEFAULT_LIMITS, timeoutMs: 50 });
		const started = Date.now();
		assert.equal((await readAll(await http.stream(request({ idleTimeoutMs: 100 })))).length, 10);
		assert.ok(Date.now() - started > 100, 'the body outlasted the 50 ms per-attempt timeout');
	});

	it('does not charge consumer think time to the idle timer', async () => {
		const { http } = harness((call) => new Response(body(call.init.signal, [bytes('a'), bytes('b')]), { status: 200 }));
		const reader = (await http.stream(request({ idleTimeoutMs: 30 }))).getReader();
		await reader.read();
		await sleep(120);
		assert.equal(new TextDecoder().decode((await reader.read()).value), 'b');
	});

	it('times out waiting for the response head with the start timeout', async () => {
		const { http } = harness((call) => new Promise<Response>((_, reject) => call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
		const started = Date.now();
		const error = await rejects(http.stream(request({ startTimeoutMs: 40 })), 'network');
		assert.match(error.message, /timed out/);
		assert.ok(Date.now() - started < 1000);
	});

	it('waits longer than the per-attempt timeout for the head when startTimeoutMs allows', async () => {
		const { http } = harness(async (call) => {
			await sleep(80);
			return new Response(body(call.init.signal, [bytes('late')]), { status: 200 });
		}, undefined, { ...DEFAULT_LIMITS, timeoutMs: 20 });
		assert.equal(await readAll(await http.stream(request({ startTimeoutMs: 1000 }))), 'late');
	});

	it('aborts through the caller signal, before and during the body', async () => {
		const before = new AbortController();
		before.abort();
		const first = harness(() => new Response('x'));
		await rejects(first.http.stream(request({ signal: before.signal })), 'aborted');
		assert.equal(first.calls.length, 0);

		const during = new AbortController();
		const { http } = harness((call) => new Response(body(call.init.signal, [bytes('a'), 'stall']), { status: 200 }));
		const reader = (await http.stream(request({ signal: during.signal }))).getReader();
		await reader.read();
		const pending = reader.read();
		during.abort();
		await rejects(pending, 'aborted');
	});

	it('aborts a request still waiting for the response head when the caller signal fires', async () => {
		let signal: AbortSignal | null | undefined;
		const { http } = harness((call) => {
			signal = call.init.signal;
			return new Promise<Response>((_, reject) => call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
		});
		const controller = new AbortController();
		const pending = http.stream(request({ signal: controller.signal, startTimeoutMs: 5000 }));
		await sleep(10);
		const started = Date.now();
		controller.abort();
		await rejects(pending, 'aborted');
		assert.ok(Date.now() - started < 1000, 'the abort must not wait for the start timeout');
		assert.equal(signal?.aborted, true);
	});

	it('aborts the request when the consumer cancels the stream', async () => {
		let signal: AbortSignal | null | undefined;
		const events = { cancelled: false };
		const { http } = harness((call) => {
			signal = call.init.signal;
			return new Response(body(call.init.signal, [bytes('a'), bytes('b')], events), { status: 200 });
		});
		const stream = await http.stream(request());
		await stream.cancel();
		assert.equal(signal?.aborted, true);
		assert.equal(events.cancelled, true);
	});

	it('reports a failing auth provider as unauthenticated and sends nothing', async () => {
		const { http, calls } = harness(() => new Response('x'), {
			headers: async () => {
				throw new Error('boom');
			},
		});
		await rejects(http.stream(request()), 'unauthenticated');
		assert.equal(calls.length, 0);
	});

	it('maps a transport failure to a network error', async () => {
		const { http } = harness(() => {
			throw new TypeError('fetch failed');
		});
		await rejects(http.stream(request()), 'network');
	});

	it('returns an empty stream for a bodiless success', async () => {
		const { http } = harness(() => new Response(null, { status: 200 }));
		assert.equal(await readAll(await http.stream(request())), '');
	});
});

/** A body that, like fetch, errors on abort, even while it waits between chunks. */
function liveBody(signal: AbortSignal | null | undefined, steps: Step[]): ReadableStream<Uint8Array> {
	const aborted = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
	aborted.catch(() => undefined);
	let i = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const step = steps[i++];
				if (step === undefined) {
					controller.close();
					return;
				}
				if (typeof step === 'number') {
					await Promise.race([sleep(step), aborted]);
					continue;
				}
				if (step === 'stall') {
					await new Promise<void>(() => undefined);
				}
				controller.enqueue(step as Uint8Array);
				return;
			}
		},
	}, { highWaterMark: 0 });
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T> => Promise.race([promise, sleep(ms).then(() => assert.fail(`still pending after ${ms} ms`))]);

describe('GiteaHttp.bytes and json timeouts', () => {
	const limits = { ...DEFAULT_LIMITS, timeoutMs: 50, maxRetries: 0 };
	const get = (http: GiteaHttp) => http.bytes({ method: 'GET', path: '/x', maxBytes: 1024 * 1024, retry: false });

	it('F1: the per-attempt timeout covers the response head, not a body that keeps arriving', async () => {
		const steps: Step[] = [];
		for (let i = 0; i < 10; i++) {
			steps.push(15, bytes('x'));
		}
		const { http } = harness((call) => new Response(liveBody(call.init.signal, steps), { status: 200 }), undefined, limits);
		const started = Date.now();
		assert.equal((await within(get(http), 2000)).length, 10);
		assert.ok(Date.now() - started > 100, 'the body outlasted the 50 ms per-attempt timeout');
	});

	it('F1: a body that stalls between chunks fails with a network timeout', async () => {
		const { http } = harness(() => new Response(liveBody(undefined, [bytes('a'), 'stall']), { status: 200 }), undefined, limits);
		const error = await rejects(within(get(http), 1000), 'network');
		assert.match(error.message, /timed out/);
	});

	it('F1: a stalled error body is bounded and still maps the status', async () => {
		const { http } = harness(() => new Response(liveBody(undefined, ['stall']), { status: 500 }), undefined, limits);
		await rejects(within(get(http), 1000), 'unavailable');
	});

	it('F8: stream() bounds an error body that stalls', async () => {
		const { http } = harness(() => new Response(liveBody(undefined, ['stall']), { status: 500 }));
		await rejects(within(http.stream(request({ idleTimeoutMs: 40 })), 1000), 'unavailable');
	});
});

describe('GiteaHttp Retry-After', () => {
	const limits = { ...DEFAULT_LIMITS, maxRetries: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 50 };
	const get = (http: GiteaHttp) => http.json({ method: 'GET', path: '/x', retry: true });

	it('F11: a Retry-After above the delay cap fails with rate-limited and the delay', async () => {
		const { http, calls } = harness(() => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }), undefined, limits);
		const error = await rejects(get(http), 'rate-limited');
		assert.equal(error.retryAfterMs, 3_600_000);
		assert.equal(calls.length, 1, 'no retry that would come back early');
	});

	it('F11: a Retry-After within the cap is honored and retried', async () => {
		let n = 0;
		const { http, calls } = harness(() => (n++ === 0 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : new Response('{"ok":true}', { status: 200 })), undefined, limits);
		assert.deepEqual(await get(http), { ok: true });
		assert.equal(calls.length, 2);
	});
});
