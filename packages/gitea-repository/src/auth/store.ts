/**
 * Injectable storage for secrets and short-lived session state. In VS Code adapt
 * ExtensionContext.secrets (get/store/delete); in tests use MemorySecretStore.
 */
export interface SecretStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
	readonly #items = new Map<string, string>();

	async get(key: string): Promise<string | undefined> {
		return this.#items.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.#items.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.#items.delete(key);
	}
}
