/** Workbench secretStorageProvider shape (IWorkbenchConstructionOptions.secretStorageProvider). */
interface SecretStorageProvider {
  readonly type: 'in-memory' | 'persisted';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

interface SecretStorageOptions {
  /** Partitions records per Gitea instance; see `secretScope`. */
  scope?: string;
  indexedDB?: IDBFactory;
  subtle?: SubtleCrypto;
  log?: (message: string) => void;
}

const DB_NAME = 'gitea-web-ide-secrets';
const KEYS = 'keys';
const SECRETS = 'secrets';
const KEY_ID = 'aes-gcm-v1';

interface SecretRecord { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }
interface Context { db: IDBDatabase; key: CryptoKey }

/** Origin plus sub-path of the Gitea instance; empty when unknown. */
export function secretScope(instance: string | undefined): string {
  try {
    const url = new URL(instance ?? '');
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const environment = <T>(read: () => T | undefined) => { try { return read(); } catch { return undefined; } };

/**
 * AES-GCM encrypted secrets in IndexedDB. The key is a non-extractable CryptoKey
 * kept in the same database. Falls back to memory when storage or crypto fail.
 */
export class PersistentSecretStorage implements SecretStorageProvider {
  readonly #scope: string;
  readonly #idb: IDBFactory | undefined;
  readonly #subtle: SubtleCrypto | undefined;
  readonly #log: (message: string) => void;
  readonly #memory = new Map<string, string>();
  #context: Promise<Context | undefined> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #persisted: boolean;

  constructor(options: SecretStorageOptions = {}) {
    this.#scope = options.scope ?? '';
    this.#idb = options.indexedDB ?? environment(() => globalThis.indexedDB);
    this.#subtle = options.subtle ?? environment(() => globalThis.crypto.subtle);
    this.#log = options.log ?? (message => console.warn(`[secret-storage] ${message}`));
    this.#persisted = !!(this.#idb && this.#subtle);
  }

  get type(): 'in-memory' | 'persisted' { return this.#persisted ? 'persisted' : 'in-memory'; }

  get(key: string): Promise<string | undefined> {
    return this.#run(async () => {
      const local = this.#memory.get(key);
      if (local !== undefined) return local;
      const context = await this.#open();
      if (!context) return undefined;
      try {
        const record: SecretRecord | undefined = await request(
          context.db.transaction(SECRETS).objectStore(SECRETS).get([this.#scope, key]));
        if (!record) return undefined;
        try { return await this.#decrypt(context, key, record); } catch {
          this.#log(`Discarding unreadable secret "${key}".`);
          await this.#remove(context, key);
          return undefined;
        }
      } catch (error) {
        this.#fail('read', error);
        return undefined;
      }
    });
  }

  set(key: string, value: string): Promise<void> {
    return this.#run(async () => {
      const context = await this.#open();
      if (context) {
        try {
          const record = await this.#encrypt(context, key, value);
          const tx = context.db.transaction(SECRETS, 'readwrite');
          tx.objectStore(SECRETS).put(record, [this.#scope, key]);
          await complete(tx);
          this.#memory.delete(key);
          return;
        } catch (error) { this.#fail('write', error); }
      }
      this.#memory.set(key, value);
    });
  }

  delete(key: string): Promise<void> {
    return this.#run(async () => {
      this.#memory.delete(key);
      const context = await this.#open();
      if (!context) return;
      try { await this.#remove(context, key); } catch (error) {
        this.#fail('delete', error);
        throw error;
      }
    });
  }

  keys(): Promise<string[]> {
    return this.#run(async () => {
      const names = new Set(this.#memory.keys());
      const context = await this.#open();
      if (context) {
        try {
          const stored: IDBValidKey[] = await request(
            context.db.transaction(SECRETS).objectStore(SECRETS).getAllKeys());
          for (const id of stored) {
            if (Array.isArray(id) && id[0] === this.#scope && typeof id[1] === 'string') names.add(id[1]);
          }
        } catch (error) { this.#fail('list', error); }
      }
      return [...names];
    });
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #fail(action: string, error: unknown) {
    this.#log(`Secret ${action} failed (${error instanceof Error ? error.name : 'error'}).`);
  }

  #open(): Promise<Context | undefined> {
    return this.#context ??= this.#initialize();
  }

  async #initialize(): Promise<Context | undefined> {
    try {
      if (!this.#idb || !this.#subtle) throw new Error('unavailable');
      const idb = this.#idb;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(KEYS);
          req.result.createObjectStore(SECRETS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => reject(req.error ?? new Error('blocked'));
      });
      return { db, key: await this.#loadKey(db, this.#subtle) };
    } catch (error) {
      this.#persisted = false;
      this.#log(`Secret storage unavailable, using memory (${error instanceof Error ? error.message : 'error'}).`);
      return undefined;
    }
  }

  /** Reads the key, creating it once; a concurrent tab's key wins. */
  async #loadKey(db: IDBDatabase, subtle: SubtleCrypto): Promise<CryptoKey> {
    const read = (): Promise<CryptoKey | undefined> =>
      request(db.transaction(KEYS).objectStore(KEYS).get(KEY_ID));
    const existing = await read();
    if (existing) return existing;
    const fresh = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      const tx = db.transaction(KEYS, 'readwrite');
      tx.objectStore(KEYS).add(fresh, KEY_ID);
      await complete(tx);
      return fresh;
    } catch (error) {
      const winner = await read();
      if (winner) return winner;
      throw error;
    }
  }

  #additionalData(key: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify([this.#scope, key]));
  }

  async #encrypt({ key: cryptoKey }: Context, key: string, value: string): Promise<SecretRecord> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await this.#subtle!.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.#additionalData(key) }, cryptoKey, new TextEncoder().encode(value));
    return { iv, data };
  }

  async #decrypt({ key: cryptoKey }: Context, key: string, record: SecretRecord): Promise<string> {
    const plain = await this.#subtle!.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: this.#additionalData(key) }, cryptoKey, record.data);
    return new TextDecoder().decode(plain);
  }

  async #remove(context: Context, key: string) {
    const tx = context.db.transaction(SECRETS, 'readwrite');
    tx.objectStore(SECRETS).delete([this.#scope, key]);
    await complete(tx);
  }
}
