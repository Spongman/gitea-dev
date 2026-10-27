// Fake of Gitea's user Actions variables API (/api/v1/user/actions/variables), modeled on what
// the integration tests observed on 1.24.6 and 28.2.0 (tests/integration/sync.test.ts).

interface FakeToken { user: string; scopes: ('read:user' | 'write:user' | 'all')[]; }

interface FakeCall { method: string; name: string | undefined; token: string; headers: Headers; credentials?: string; redirect?: string; }

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_CHARS = 65_536;

export class FakeGitea {
  readonly tokens = new Map<string, FakeToken>();
  /** user -> name -> data */
  readonly data = new Map<string, Map<string, string>>();
  readonly calls: FakeCall[] = [];
  /** Longest value ever accepted, in characters. */
  maxValueSeen = 0;
  /** 1.24.6 answers 204 to a create, 28.2.0 answers 201. */
  createStatus: 201 | 204 = 204;
  /** An older Gitea: the routes do not exist. */
  unsupported = false;
  /** Runs before each call is served; throw to fail the request, or await to interleave other work. */
  before?: (call: FakeCall) => Promise<void> | void;

  constructor(readonly instance: string) {}

  addToken(token: string, user: string, scopes: FakeToken['scopes'] = ['all']) {
    this.tokens.set(token, { user, scopes });
  }

  vars(user: string): Map<string, string> {
    let vars = this.data.get(user);
    if (!vars) this.data.set(user, vars = new Map());
    return vars;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const base = `${new URL(this.instance).pathname.replace(/\/$/, '')}/api/v1/user/actions/variables`;
    if (!url.pathname.startsWith(base)) return new Response('not this fake', { status: 599 });
    const name = url.pathname.slice(base.length + 1) || undefined;
    const token = /^(?:Bearer|token) (\S+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? '';
    const call: FakeCall = { method, name, token, headers, credentials: init?.credentials, redirect: init?.redirect };
    this.calls.push(call);
    await this.before?.(call);
    const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (this.unsupported) return new Response('404 page not found', { status: 404 });
    const who = this.tokens.get(token);
    if (!who) return json(401, { message: 'token is required' });
    const write = method !== 'GET';
    // Verified on 1.24.6 and 28.2.0: write:user also reads.
    const needs = write ? ['write:user'] : ['read:user', 'write:user'];
    if (!who.scopes.includes('all') && !needs.some(scope => who.scopes.includes(scope as 'write:user'))) {
      return json(403, { message: `token does not have at least one of required scope(s), required=[${needs.join(', ')}]` });
    }
    const vars = this.vars(who.user);
    if (name === undefined) {
      if (method !== 'GET') return json(405);
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), 50);
      return json(200, [...vars].slice((page - 1) * limit, page * limit).map(([n, data]) => ({ owner_id: 1, repo_id: 0, name: n, data, description: '' })));
    }
    const upper = name.toUpperCase();
    const missing = () => json(404, { message: 'variable not found' });
    if (method === 'GET') return vars.has(upper) ? json(200, { owner_id: 1, repo_id: 0, name: upper, data: vars.get(upper), description: '' }) : missing();
    if (method === 'DELETE') return vars.delete(upper) ? json(204) : missing();
    if (method !== 'POST' && method !== 'PUT') return json(405);
    const value = (JSON.parse(String(init?.body)) as { value?: string }).value;
    if (!NAME.test(upper) || /^(GITEA_|GITHUB_|CI)/.test(upper)) return json(400, { message: 'invalid secret name' });
    if (!value) return json(422, { message: '[Value]: Required' });
    if ([...value].length > MAX_CHARS) return json(400, { message: 'data too long' });
    if (method === 'POST') {
      if (vars.has(upper)) return json(409, { message: `variable name ${upper} already exists` });
      this.maxValueSeen = Math.max(this.maxValueSeen, value.length);
      vars.set(upper, value);
      return json(this.createStatus);
    }
    if (!vars.has(upper)) return missing();
    this.maxValueSeen = Math.max(this.maxValueSeen, value.length);
    vars.set(upper, value);
    return json(204);
  }) as typeof fetch;
}
