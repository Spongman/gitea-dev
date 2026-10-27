import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { PersistentSecretStorage, secretScope } from '../packages/editor-host/src/secret-storage.js';

const SECRET = 'tok-0123456789abcdef-PLAINTEXT';

function setup(scope = 'http://gitea.test/git') {
  const indexedDB = new IDBFactory();
  const logs: string[] = [];
  const make = (overrides: Record<string, unknown> = {}) =>
    new PersistentSecretStorage({ scope, indexedDB: indexedDB as unknown as IDBFactory, log: m => logs.push(m), ...overrides });
  return { indexedDB, logs, make };
}

async function rawDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open('gitea-web-ide-secrets', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rawAll(factory: IDBFactory, store: string): Promise<{ keys: IDBValidKey[]; values: any[] }> {
  const db = await rawDb(factory);
  const os = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([os.getAllKeys(), os.getAll()].map(r =>
    new Promise<any>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); })));
  db.close();
  return { keys, values };
}

async function rawWrite(factory: IDBFactory, store: string, fn: (os: IDBObjectStore) => void) {
  const db = await rawDb(factory);
  const tx = db.transaction(store, 'readwrite');
  fn(tx.objectStore(store));
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}

describe('PersistentSecretStorage', () => {
  it('reports type persisted and survives a new instance on the same database', async () => {
    const { make } = setup();
    const a = make();
    assert.equal(a.type, 'persisted');
    await a.set('pat', SECRET);
    assert.equal(await make().get('pat'), SECRET);
    assert.equal(await make().get('missing'), undefined);
  });

  it('stores no plaintext and uses a fresh 12-byte IV per write', async () => {
    const { indexedDB, make } = setup();
    const store = make();
    await store.set('pat', SECRET);
    const first = (await rawAll(indexedDB, 'secrets')).values[0];
    await store.set('pat', SECRET);
    const second = (await rawAll(indexedDB, 'secrets')).values[0];
    assert.equal(first.iv.byteLength, 12);
    assert.equal(second.iv.byteLength, 12);
    assert.notDeepEqual([...first.iv], [...second.iv]);
    assert.notDeepEqual([...new Uint8Array(first.data)], [...new Uint8Array(second.data)]);
    const dump = Buffer.concat([Buffer.from(second.iv), Buffer.from(second.data)]);
    assert.equal(dump.includes(Buffer.from(SECRET)), false);
    assert.equal(dump.toString('latin1').includes('PLAINTEXT'), false);
  });

  it('keeps a non-extractable AES-GCM 256 CryptoKey in the same database', async () => {
    const { indexedDB, make } = setup();
    await make().set('pat', SECRET);
    const { values } = await rawAll(indexedDB, 'keys');
    assert.equal(values.length, 1);
    const key: CryptoKey = values[0];
    assert.equal(key.extractable, false);
    assert.deepEqual(key.algorithm, { name: 'AES-GCM', length: 256 });
    assert.deepEqual([...key.usages].sort(), ['decrypt', 'encrypt']);
    await assert.rejects(crypto.subtle.exportKey('raw', key));
  });

  it('creates one key when instances start concurrently', async () => {
    const { indexedDB, make } = setup();
    const [a, b] = [make(), make()];
    await Promise.all([a.set('x', 'from-a'), b.set('y', 'from-b')]);
    assert.equal((await rawAll(indexedDB, 'keys')).values.length, 1);
    assert.equal(await make().get('x'), 'from-a');
    assert.equal(await make().get('y'), 'from-b');
  });

  it('scopes records per instance and lists only the scope keys', async () => {
    const { make } = setup();
    const a = make({ scope: secretScope('http://gitea.test/a/') });
    const b = make({ scope: secretScope('http://gitea.test/b') });
    await a.set('pat', 'A');
    await b.set('pat', 'B');
    await b.set('other', 'B2');
    assert.equal(await a.get('pat'), 'A');
    assert.equal(await b.get('pat'), 'B');
    assert.deepEqual((await a.keys()).sort(), ['pat']);
    assert.deepEqual((await b.keys()).sort(), ['other', 'pat']);
    await a.delete('pat');
    assert.equal(await a.get('pat'), undefined);
    assert.equal(await b.get('pat'), 'B');
  });

  it('derives the scope from origin and sub-path', () => {
    assert.equal(secretScope('https://git.example.com/git/'), 'https://git.example.com/git');
    assert.equal(secretScope('http://127.0.0.1:8081'), 'http://127.0.0.1:8081');
    assert.equal(secretScope(undefined), '');
    assert.equal(secretScope('not a url'), '');
  });

  it('delete removes the record and keys reflects it', async () => {
    const { indexedDB, make } = setup();
    const store = make();
    await store.set('pat', SECRET);
    assert.deepEqual(await store.keys(), ['pat']);
    await store.delete('pat');
    assert.deepEqual(await store.keys(), []);
    assert.equal((await rawAll(indexedDB, 'secrets')).keys.length, 0);
  });

  it('applies concurrent writes in call order', async () => {
    const { make } = setup();
    const store = make();
    await Promise.all([store.set('k', '1'), store.set('k', '2'), store.delete('k'), store.set('k', '3'), store.set('k', '4')]);
    assert.equal(await make().get('k'), '4');
    await Promise.all([store.set('k', '5'), store.delete('k')]);
    assert.equal(await make().get('k'), undefined);
  });

  it('deletes a tampered record, treats it as missing and logs no value', async () => {
    const { indexedDB, logs, make } = setup();
    const store = make();
    await store.set('pat', SECRET);
    const { keys, values } = await rawAll(indexedDB, 'secrets');
    const bytes = new Uint8Array(values[0].data);
    bytes[0] ^= 0xff;
    await rawWrite(indexedDB, 'secrets', os => { os.put({ iv: values[0].iv, data: bytes.buffer }, keys[0]); });
    assert.equal(await store.get('pat'), undefined);
    assert.equal((await rawAll(indexedDB, 'secrets')).keys.length, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs.join('\n').includes(SECRET), false);
  });

  it('rejects a record moved to another key name', async () => {
    const { indexedDB, make } = setup();
    const store = make();
    await store.set('a', SECRET);
    const { keys, values } = await rawAll(indexedDB, 'secrets');
    await rawWrite(indexedDB, 'secrets', os => { os.put(values[0], [(keys[0] as string[])[0], 'b']); });
    assert.equal(await store.get('b'), undefined);
    assert.equal(await store.get('a'), SECRET);
  });

  it('treats records as missing and deletes them when the key was lost', async () => {
    const { indexedDB, make } = setup();
    await make().set('pat', SECRET);
    await rawWrite(indexedDB, 'keys', os => { os.clear(); });
    const fresh = make();
    assert.equal(await fresh.get('pat'), undefined);
    assert.equal((await rawAll(indexedDB, 'secrets')).keys.length, 0);
    await fresh.set('pat', 'new');
    assert.equal(await make().get('pat'), 'new');
  });

  it('falls back to memory when IndexedDB is unavailable', async () => {
    const logs: string[] = [];
    const store = new PersistentSecretStorage({ scope: 's', indexedDB: undefined, log: m => logs.push(m) });
    // Node has no global indexedDB, so this models a browser without it.
    assert.equal(store.type, 'in-memory');
    await store.set('pat', SECRET);
    assert.equal(await store.get('pat'), SECRET);
    assert.deepEqual(await store.keys(), ['pat']);
    await store.delete('pat');
    assert.equal(await store.get('pat'), undefined);
  });

  it('falls back to memory when open fails or SubtleCrypto fails', async () => {
    const { indexedDB, logs, make } = setup();
    const broken = { open: () => { throw new Error('SecurityError'); } } as unknown as IDBFactory;
    const a = make({ indexedDB: broken });
    await a.set('pat', SECRET);
    assert.equal(await a.get('pat'), SECRET);
    assert.equal(a.type, 'in-memory');
    const subtle = { generateKey: async () => { throw new Error('no crypto'); } } as unknown as SubtleCrypto;
    const b = make({ indexedDB, subtle });
    await b.set('pat', SECRET);
    assert.equal(await b.get('pat'), SECRET);
    assert.equal(b.type, 'in-memory');
    assert.equal(logs.join('\n').includes(SECRET), false);
  });

  it('keeps a value in memory when a single write fails', async () => {
    const { logs, make } = setup();
    let failEncrypt = false;
    const real = crypto.subtle;
    const subtle = new Proxy(real, {
      get: (target, prop) => prop === 'encrypt' && failEncrypt
        ? async () => { throw new Error('boom'); }
        : (target as any)[prop].bind(target),
    });
    const store = make({ subtle });
    await store.set('pat', 'old');
    failEncrypt = true;
    await store.set('pat', SECRET);
    assert.equal(await store.get('pat'), SECRET);
    assert.equal(logs.join('\n').includes(SECRET), false);
  });
});
