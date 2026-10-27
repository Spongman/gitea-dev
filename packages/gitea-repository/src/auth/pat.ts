import { RepositoryError } from '../errors.js';
import type { AuthProvider } from '../types.js';
import { Redacted } from './redact.js';

const TOKEN_PATTERN = /^[\x21-\x7e]{8,4096}$/;

/** Holds a user-supplied token in memory only; never persisted or serialized. */
export class PersonalAccessTokenAuth extends Redacted implements AuthProvider {
	protected readonly label = 'PersonalAccessTokenAuth';
	#token: string | undefined;

	constructor(token?: string) {
		super();
		if (token !== undefined) {
			this.setToken(token);
		}
	}

	setToken(token: string): void {
		if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
			throw new RepositoryError('invalid-argument', 'The token has an invalid format');
		}
		this.#token = token;
	}

	async headers(): Promise<Record<string, string>> {
		return this.#token === undefined ? {} : { Authorization: `token ${this.#token}` };
	}

	async logout(): Promise<void> {
		this.#token = undefined;
	}
}
