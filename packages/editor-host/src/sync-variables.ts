// The signed-in user's Gitea Actions variables as a key/value store:
// /api/v1/user/actions/variables[/{name}]. Behavior verified on 1.24.6 and 28.2.0 (docs/settings-sync.md).

/**
 * unauthorized: Gitea 401. forbidden: 403 (token scope). unsupported: the endpoint is missing.
 * unavailable: network, timeout, 429 or 5xx. rejected: Gitea refused the name or value.
 */
type VariablesFailure = 'unauthorized' | 'forbidden' | 'unsupported' | 'unavailable' | 'rejected';

export class VariablesError extends Error {
  constructor(readonly kind: VariablesFailure, message: string) { super(message); }
}

export interface Variables {
  /** Undefined when the variable does not exist. */
  get(name: string): Promise<string | undefined>;
  /** False when the name is taken: creation is the compare-and-swap primitive. */
  create(name: string, value: string): Promise<boolean>;
  /** Creates or replaces. */
  set(name: string, value: string): Promise<void>;
  /** Idempotent. */
  remove(name: string): Promise<void>;
  /** Names starting with `prefix`; reads every variable, so use sparingly. */
  names(prefix: string): Promise<string[]>;
}

const PAGE = 50;
const MAX_PAGES = 400;

export class GiteaVariables implements Variables {
  private readonly base: string;

  constructor(
    instance: string,
    private readonly authorization: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 15_000,
  ) {
    this.base = `${instance.replace(/\/+$/, '')}/api/v1/user/actions/variables`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.authorization, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new VariablesError('unavailable', 'Gitea is unreachable'); }
    const text = await res.text().catch(() => '');
    const { status } = res;
    if (status === 401) throw new VariablesError('unauthorized', 'Gitea rejected the token');
    if (status === 403) throw new VariablesError('forbidden', 'The token lacks the read:user or write:user scope');
    if (status === 429 || status >= 500) throw new VariablesError('unavailable', `Gitea answered ${status}`);
    if (status === 405 || (status === 404 && !/variable not found/i.test(text))) {
      throw new VariablesError('unsupported', 'This Gitea has no user Actions variables API (Gitea 1.24 or later is required)');
    }
    if (status === 400 || status === 422) throw new VariablesError('rejected', `Gitea refused the variable: ${text.slice(0, 120)}`);
    return { status, text };
  }

  async get(name: string): Promise<string | undefined> {
    const { status, text } = await this.call('GET', `/${name}`);
    if (status === 404) return undefined;
    if (status !== 200) throw new VariablesError('unavailable', `Gitea answered ${status}`);
    try {
      const data = (JSON.parse(text) as { data?: unknown }).data;
      if (typeof data === 'string') return data;
    } catch { /* fall through */ }
    throw new VariablesError('unavailable', 'Gitea sent an unreadable variable');
  }

  async create(name: string, value: string): Promise<boolean> {
    const { status } = await this.call('POST', `/${name}`, { value });
    if (status === 409) return false;
    if (status < 200 || status > 299) throw new VariablesError('unavailable', `Gitea answered ${status}`);
    return true;
  }

  async set(name: string, value: string): Promise<void> {
    const { status } = await this.call('PUT', `/${name}`, { value });
    if (status === 404) {
      // Created meanwhile by another writer: update it once more, and give up if it vanished again.
      if (await this.create(name, value)) return;
      const again = await this.call('PUT', `/${name}`, { value });
      if (again.status < 200 || again.status > 299) throw new VariablesError('unavailable', `Gitea answered ${again.status}`);
      return;
    }
    if (status < 200 || status > 299) throw new VariablesError('unavailable', `Gitea answered ${status}`);
  }

  async remove(name: string): Promise<void> {
    const { status } = await this.call('DELETE', `/${name}`);
    if (status !== 404 && (status < 200 || status > 299)) throw new VariablesError('unavailable', `Gitea answered ${status}`);
  }

  async names(prefix: string): Promise<string[]> {
    const found: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { status, text } = await this.call('GET', `?page=${page}&limit=${PAGE}`);
      let list: unknown;
      try { list = JSON.parse(text); } catch { list = undefined; }
      if (status !== 200 || !Array.isArray(list)) throw new VariablesError('unavailable', 'Gitea sent an unreadable variable list');
      for (const item of list) if (typeof item?.name === 'string' && item.name.startsWith(prefix)) found.push(item.name);
      if (list.length < PAGE) break;
    }
    return found;
  }
}
