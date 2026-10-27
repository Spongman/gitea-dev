import { RepositoryError, abortError, isRepositoryError } from './errors.js';
import type { AuthProvider, RepositoryLimits } from './types.js';

export const DEFAULT_LIMITS: RepositoryLimits = {
	timeoutMs: 30_000,
	maxRetries: 2,
	retryBaseDelayMs: 250,
	retryMaxDelayMs: 5_000,
	cacheBytes: 64 * 1024 * 1024,
	cacheEntries: 2_000,
	maxDirectoryEntries: 50_000,
	maxTreeEntries: 100_000,
	maxCommitChanges: 1_000,
	maxJsonBytes: 16 * 1024 * 1024,
	maxCommitBytes: 100 * 1024 * 1024,
};

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const FORBIDDEN_AUTH_HEADERS = new Set(['cookie', 'host', 'content-length', 'content-type', 'accept']);
const ERROR_BODY_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 300;

interface HttpRequest {
	method: 'GET' | 'POST';
	/** Already-encoded path below the API base, starting with '/'. */
	path: string;
	query?: Record<string, string | number>;
	body?: unknown;
	signal?: AbortSignal;
	/** Response size cap in bytes. */
	maxBytes: number;
	/** Retry transient failures; only for idempotent reads. */
	retry: boolean;
	accept: 'json' | 'bytes';
}

export interface StreamRequest {
	/** Already-encoded path below the API base, starting with '/'. */
	path: string;
	query?: Record<string, string | number>;
	signal?: AbortSignal;
	/** Cap on bytes read from the body. */
	maxBytes: number;
	/** Wait for the response head; defaults to the per-attempt timeout. */
	startTimeoutMs?: number;
	/** Longest gap between body chunks. */
	idleTimeoutMs: number;
}

export type StatusMapper =(status: number, message: string) => RepositoryError | undefined;

function sanitizeMessage(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MESSAGE_LIMIT);
}

function defaultStatusError(status: number, message: string): RepositoryError {
	const detail = message === '' ? '' : `: ${message}`;
	const options = { status };
	if (status === 401) {
		return new RepositoryError('unauthenticated', `Authentication required or rejected${detail}`, options);
	}
	if (status === 403) {
		return new RepositoryError('forbidden', `Permission denied${detail}`, options);
	}
	if (status === 404) {
		return new RepositoryError('not-found', `Not found${detail}`, options);
	}
	if (status === 409) {
		return new RepositoryError('conflict', `Conflict${detail}`, options);
	}
	if (status === 423) {
		return new RepositoryError('archived', `Repository is archived or locked${detail}`, options);
	}
	if (status === 429) {
		return new RepositoryError('rate-limited', `Rate limited${detail}`, options);
	}
	if (status >= 500) {
		return new RepositoryError('unavailable', `Server error ${status}${detail}`, options);
	}
	return new RepositoryError('invalid-argument', `Request rejected with status ${status}${detail}`, options);
}

/** Longest gap allowed between body chunks. */
interface BodyIdle {
	ms: number;
	/** Called when the gap is exceeded; should abort the request. */
	onIdle: () => void;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, idle: BodyIdle | undefined): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (idle === undefined) {
		return reader.read();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stalled = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			idle.onIdle();
			reject(new Error('stalled'));
		}, idle.ms);
	});
	try {
		return await Promise.race([reader.read(), stalled]);
	} finally {
		clearTimeout(timer);
	}
}

/** Reads a body of at most `max` bytes; with `idle`, a gap between chunks over `idle.ms` fails the read. */
export async function readLimited(response: Response, max: number, idle?: BodyIdle): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > max) {
		await response.body?.cancel().catch(() => undefined);
		throw new RepositoryError('file-too-large', 'Response exceeds the size limit');
	}
	if (response.body === null) {
		return new Uint8Array(0);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try {
			chunk = await readChunk(reader, idle);
		} catch (error) {
			reader.cancel().catch(() => undefined);
			throw error;
		}
		if (chunk.done) {
			break;
		}
		total += chunk.value.length;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			throw new RepositoryError('file-too-large', 'Response exceeds the size limit');
		}
		chunks.push(chunk.value);
	}
	if (chunks.length === 1) {
		return chunks[0];
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get('retry-after');
	if (value === null) {
		return undefined;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export class GiteaHttp {
	constructor(
		private readonly apiBase: string,
		private readonly fetchImpl: typeof fetch,
		private readonly auth: AuthProvider | undefined,
		private readonly limits: RepositoryLimits,
	) {}

	async json<T>(request: Omit<HttpRequest, 'accept' | 'maxBytes'> & { maxBytes?: number }, mapStatus?: StatusMapper): Promise<T> {
		const bytes = await this.request({ ...request, accept: 'json', maxBytes: request.maxBytes ?? this.limits.maxJsonBytes }, mapStatus);
		try {
			return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as T;
		} catch {
			throw new RepositoryError('protocol', 'Server returned malformed JSON');
		}
	}

	bytes(request: Omit<HttpRequest, 'accept'>, mapStatus?: StatusMapper): Promise<Uint8Array> {
		return this.request({ ...request, accept: 'bytes' }, mapStatus);
	}

	/**
	 * GET whose body is handed over as a stream. `startTimeoutMs` bounds the wait for the
	 * response head; afterwards each chunk must arrive within `idleTimeoutMs`. Not retried.
	 */
	async stream(request: StreamRequest, mapStatus?: StatusMapper): Promise<ReadableStream<Uint8Array>> {
		const auth = await this.authHeaders();
		const controller = new AbortController();
		let timedOut = false;
		const abort = () => controller.abort();
		const timer = setTimeout(() => {
			timedOut = true;
			abort();
		}, request.startTimeoutMs ?? this.limits.timeoutMs);
		if (request.signal?.aborted) {
			clearTimeout(timer);
			throw abortError();
		}
		request.signal?.addEventListener('abort', abort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			request.signal?.removeEventListener('abort', abort);
		};
		const failure = (error: unknown) => this.transportError(error, { ...request, method: 'GET', retry: false, accept: 'bytes' }, timedOut);
		let response: Response;
		try {
			try {
				response = await this.fetchImpl(this.url({ ...request, method: 'GET', retry: false, accept: 'bytes' }), {
					method: 'GET',
					headers: { ...auth, Accept: '*/*' },
					signal: controller.signal,
					credentials: this.auth?.credentials ?? 'omit',
					redirect: 'error',
					cache: 'no-store',
				});
			} catch (error) {
				throw failure(error);
			}
			clearTimeout(timer);
			if (response.status < 200 || response.status >= 300) {
				const message = await this.errorMessage(response, { ms: request.idleTimeoutMs, onIdle: abort });
				throw mapStatus?.(response.status, message) ?? defaultStatusError(response.status, message);
			}
			const declared = Number(response.headers.get('content-length'));
			if (Number.isFinite(declared) && declared > request.maxBytes) {
				await response.body?.cancel().catch(() => undefined);
				throw new RepositoryError('file-too-large', 'Response exceeds the size limit');
			}
		} catch (error) {
			cleanup();
			throw error;
		}
		if (response.body === null) {
			cleanup();
			return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
		}
		const reader = response.body.getReader();
		let total = 0;
		let idled = false;
		const aborted = new Promise<never>((_, reject) => {
			request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		});
		aborted.catch(() => undefined);
		return new ReadableStream<Uint8Array>({
			async pull(out) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const stalled = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						idled = true;
						abort();
						reject(new Error('stalled'));
					}, request.idleTimeoutMs);
				});
				stalled.catch(() => undefined);
				try {
					const { done, value } = await Promise.race([reader.read(), stalled, aborted]);
					if (done) {
						cleanup();
						out.close();
						return;
					}
					total += value.length;
					if (total > request.maxBytes) {
						abort();
						throw new RepositoryError('file-too-large', 'Response exceeds the size limit');
					}
					out.enqueue(value);
				} catch (error) {
					cleanup();
					reader.cancel().catch(() => undefined);
					if (isRepositoryError(error)) {
						throw error;
					}
					if (request.signal?.aborted) {
						throw abortError();
					}
					throw new RepositoryError('network', idled ? 'The download stalled' : 'The download failed');
				} finally {
					clearTimeout(timer);
				}
			},
			cancel() {
				cleanup();
				abort();
				return reader.cancel().catch(() => undefined);
			},
		}, { highWaterMark: 0 });
	}

	private async authHeaders(): Promise<Record<string, string>> {
		if (this.auth === undefined) {
			return {};
		}
		let headers: unknown;
		try {
			headers = await this.auth.headers();
		} catch (error) {
			if (isRepositoryError(error)) {
				throw error;
			}
			throw new RepositoryError('unauthenticated', 'The authentication provider failed');
		}
		const result: Record<string, string> = {};
		for (const [name, value] of Object.entries((headers ?? {}) as Record<string, unknown>)) {
			if (typeof value !== 'string' || FORBIDDEN_AUTH_HEADERS.has(name.toLowerCase())) {
				throw new RepositoryError('invalid-argument', 'The authentication provider returned an unusable header');
			}
			result[name] = value;
		}
		return result;
	}

	private url(request: HttpRequest): string {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(request.query ?? {})) {
			query.set(key, String(value));
		}
		const text = query.toString();
		return `${this.apiBase}${request.path}${text === '' ? '' : `?${text}`}`;
	}

	private async request(request: HttpRequest, mapStatus: StatusMapper | undefined): Promise<Uint8Array> {
		const maxAttempts = request.retry ? this.limits.maxRetries + 1 : 1;
		const url = this.url(request);
		for (let attempt = 1; ; attempt++) {
			if (request.signal?.aborted) {
				throw abortError();
			}
			const outcome = await this.attempt(request, url, mapStatus);
			if (outcome.kind === 'ok') {
				return outcome.bytes;
			}
			const { retryAfter } = outcome;
			if (attempt >= maxAttempts || (retryAfter !== undefined && retryAfter > this.limits.retryMaxDelayMs)) {
				throw retryAfter === undefined ? outcome.error : new RepositoryError(outcome.error.code, outcome.error.message, { status: outcome.error.status, retryAfterMs: retryAfter });
			}
			const backoff = Math.min(this.limits.retryMaxDelayMs, this.limits.retryBaseDelayMs * 2 ** (attempt - 1));
			await sleep(retryAfter ?? backoff * (0.5 + Math.random() / 2), request.signal);
		}
	}

	/** Runs one attempt; returns a retryable failure or throws a final one. */
	private async attempt(
		request: HttpRequest,
		url: string,
		mapStatus: StatusMapper | undefined,
	): Promise<{ kind: 'ok'; bytes: Uint8Array } | { kind: 'retry'; error: RepositoryError; retryAfter?: number }> {
		const auth = await this.authHeaders();
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.limits.timeoutMs);
		const onAbort = () => controller.abort();
		const idle: BodyIdle = {
			ms: this.limits.timeoutMs,
			onIdle: () => {
				timedOut = true;
				controller.abort();
			},
		};
		request.signal?.addEventListener('abort', onAbort, { once: true });
		try {
			const headers: Record<string, string> = { ...auth, Accept: request.accept === 'json' ? 'application/json' : '*/*' };
			if (request.body !== undefined) {
				headers['Content-Type'] = 'application/json';
			}
			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method: request.method,
					headers,
					body: request.body === undefined ? undefined : JSON.stringify(request.body),
					signal: controller.signal,
					credentials: this.auth?.credentials ?? 'omit',
					redirect: 'error',
					cache: 'no-store',
				});
			} catch (error) {
				throw this.transportError(error, request, timedOut);
			}
			clearTimeout(timer);
			if (response.status >= 200 && response.status < 300) {
				try {
					return { kind: 'ok', bytes: await readLimited(response, request.maxBytes, idle) };
				} catch (error) {
					throw this.transportError(error, request, timedOut);
				}
			}
			const message = await this.errorMessage(response, idle);
			const error = mapStatus?.(response.status, message) ?? defaultStatusError(response.status, message);
			if (request.retry && RETRYABLE_STATUS.has(response.status)) {
				return { kind: 'retry', error, retryAfter: retryAfterMs(response) };
			}
			throw error;
		} catch (error) {
			if (request.retry && isRepositoryError(error) && error.code === 'network') {
				return { kind: 'retry', error };
			}
			throw error;
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener('abort', onAbort);
		}
	}

	private transportError(error: unknown, request: HttpRequest, timedOut: boolean): RepositoryError {
		if (isRepositoryError(error)) {
			return error;
		}
		if (request.signal?.aborted) {
			return abortError();
		}
		if (timedOut) {
			return new RepositoryError('network', 'The request timed out');
		}
		return new RepositoryError('network', 'The request failed');
	}

	private async errorMessage(response: Response, idle: BodyIdle): Promise<string> {
		try {
			const bytes = await readLimited(response, ERROR_BODY_LIMIT, idle);
			const text = new TextDecoder('utf-8').decode(bytes);
			try {
				const parsed = JSON.parse(text) as { message?: unknown };
				return typeof parsed.message === 'string' ? sanitizeMessage(parsed.message) : '';
			} catch {
				return '';
			}
		} catch {
			return '';
		}
	}
}
