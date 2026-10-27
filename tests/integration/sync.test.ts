// Settings Sync store against a disposable Gitea v1.24.6: the service worker's sync handler over the
// real user Actions variables API. Expectations follow the VS Code user-data-sync protocol (the pinned
// userDataSyncStoreService.ts) and the Gitea API (swagger: /user/actions/variables), not the implementation.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { handleSync } from "../../packages/editor-host/src/sync-handler.ts";
import { PREFIX, StoreError, SyncStore } from "../../packages/editor-host/src/sync-store.ts";
import { GiteaVariables } from "../../packages/editor-host/src/sync-variables.ts";
import { probeVariables } from "../../packages/gitea-vscode-web/src/sync-auto.ts";
import { GITEA_VERSION, GiteaFixture, startGitea } from "../helpers/gitea.ts";

const OWNER = { name: "owner" };
const BASE = "/assets/gitea-dev/sync/";
const V1 = `${BASE}v1/`;
const VARIABLES = "/user/actions/variables";

interface Variable { name: string; data: string }

function webLoginWith(base: string, user: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const absorb = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return (async () => {
    const form = await fetch(`${base}/user/login`);
    absorb(form);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await form.text())?.[1];
    assert.ok(csrf, "no _csrf field on the login page");
    const res = await fetch(`${base}/user/login`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, user_name: user, password }),
    });
    absorb(res);
    assert.ok([302, 303].includes(res.status), `login HTTP ${res.status}`);
    return header();
  })();
}

/** Authorization-code flow with PKCE, as the editor does it; returns an OAuth access token. */
async function oauthToken(fx: GiteaFixture): Promise<string> {
  const redirect = "http://127.0.0.1:5173/callback";
  const app = await fx.createOAuthApp(OWNER, { name: "sync-oauth", redirectUris: [redirect] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookie = await webLoginWith(fx.baseUrl, "owner", fx.password("owner"));
  const params = new URLSearchParams({
    client_id: app.clientId, redirect_uri: redirect, response_type: "code", state: "s",
    code_challenge: challenge, code_challenge_method: "S256",
  });
  let authorize = await fetch(`${fx.baseUrl}/login/oauth/authorize?${params}`, { headers: { cookie }, redirect: "manual" });
  if (authorize.status === 200) {
    // First use: the consent page. Submit its grant form like the Authorize button does.
    const html = await authorize.text();
    const form = /<form[^>]*action="[^"]*\/login\/oauth\/grant"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1];
    assert.ok(form, "no grant form on the consent page");
    const fields = new URLSearchParams();
    for (const input of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]*)"/.exec(input[0])?.[1];
      if (name) fields.set(name, (/value="([^"]*)"/.exec(input[0])?.[1] ?? "").replace(/&amp;/g, "&"));
    }
    fields.set("granted", "true");
    authorize = await fetch(`${fx.baseUrl}/login/oauth/grant`, {
      method: "POST", redirect: "manual", body: fields,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  }
  assert.ok([302, 303].includes(authorize.status), `authorize HTTP ${authorize.status}`);
  const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(code, "no authorization code");
  const token = await fetch(`${fx.baseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code, redirect_uri: redirect, code_verifier: verifier }),
  });
  const json = (await token.json()) as { access_token?: string };
  assert.ok(json.access_token, "no access token");
  return json.access_token;
}

class Client {
  constructor(private readonly fx: GiteaFixture, private readonly token: string, readonly limits = {}) {}

  send(method: string, path: string, init: { body?: string; headers?: Record<string, string>; ifMatch?: string } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...init.headers };
    if (init.ifMatch !== undefined) headers["if-match"] = init.ifMatch;
    return handleSync(new Request(`${this.fx.directUrl}${path}`, { method, headers, body: init.body }), {
      instance: this.fx.baseUrl, basePath: BASE, limits: this.limits,
    });
  }

  async write(resource: string, body: string, ifMatch: string | undefined, collection?: string) {
    const prefix = collection ? `${V1}collection/${collection}/resource` : `${V1}resource`;
    const res = await this.send("POST", `${prefix}/${resource}`, { body, headers: { "content-type": "text/plain" }, ifMatch });
    return { status: res.status, ref: res.headers.get("etag") ?? undefined, text: await res.text() };
  }

  async read(resource: string) {
    const res = await this.send("GET", `${V1}resource/${resource}/latest`);
    return { status: res.status, ref: res.headers.get("etag") ?? undefined, text: await res.text() };
  }

  async manifest() {
    const res = await this.send("GET", `${V1}manifest`);
    const text = await res.text();
    return { status: res.status, etag: res.headers.get("etag") ?? undefined, body: res.status === 200 ? JSON.parse(text) : undefined, text };
  }

  async clear() {
    assert.equal((await this.send("DELETE", `${V1}collection`)).status, 204);
    assert.equal((await this.send("DELETE", `${V1}resource`)).status, 204);
  }
}

const list = async (fx: GiteaFixture, label = "full"): Promise<Variable[]> => {
  const all: Variable[] = [];
  for (let page = 1; ; page++) {
    const rows = await fx.apiOk<Variable[]>({ ...OWNER, label }, "GET", `${VARIABLES}?page=${page}&limit=50`);
    all.push(...rows);
    if (rows.length < 50) return all;
  }
};
const syncVariables = async (fx: GiteaFixture) => (await list(fx)).filter((v) => v.name.startsWith(PREFIX));

describe(`Settings Sync store on Gitea ${GITEA_VERSION}`, () => {
  let fx: GiteaFixture;
  let owner: Client;

  before(async () => {
    fx = await startGitea({
      users: [
        { name: "owner", tokens: { full: ["all"], read: ["read:user"], write: ["write:user"], rw: ["read:user", "write:user"], repo: ["write:repository"] } },
        { name: "other", tokens: { full: ["all"] } },
      ],
    });
    owner = new Client(fx, fx.token("owner"));
  });
  after(async () => fx?.stop());

  it("accepts a personal access token as Authorization: Bearer on the variables API", async () => {
    const res = await fetch(`${fx.baseUrl}/api/v1${VARIABLES}`, { headers: { authorization: `Bearer ${fx.token("owner")}` } });
    assert.equal(res.status, 200);
    assert.equal(await probeVariables(fx.baseUrl, `Bearer ${fx.token("owner")}`), "ok");
    assert.deepEqual(await syncVariables(fx), [], "the probe left nothing behind");
  });

  it("round trip: first sync, conditional writes, manifest, history, collections and reset, in the client's request shapes", async () => {
    assert.equal((await owner.manifest()).status, 204);
    assert.equal((await owner.read("settings")).status, 204);
    const first = await owner.write("settings", '{"settings":"{\\"editor.fontSize\\":21}"}', "0");
    assert.equal(first.status, 200);
    assert.ok(first.ref);
    const manifest = await owner.manifest();
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.latest.settings, first.ref);
    assert.deepEqual(await owner.read("settings"), { status: 200, ref: first.ref, text: '{"settings":"{\\"editor.fontSize\\":21}"}' });
    assert.equal((await owner.write("settings", "stale", "0")).status, 412);
    const second = await owner.write("settings", "second", first.ref);
    assert.equal(second.status, 200);
    const history = await owner.send("GET", `${V1}resource/settings`);
    const refs = (await history.json() as { url: string }[]).map((h) => h.url.split("/").pop());
    assert.deepEqual(refs, [second.ref, first.ref]);
    const old = await owner.send("GET", `${V1}resource/settings/${first.ref}`);
    assert.equal((await old.text()).includes("editor.fontSize"), true);
    const collection = await (await owner.send("POST", `${V1}collection`, { headers: { "content-type": "text/plain" } })).text();
    assert.equal((await owner.write("keybindings", "kb", "0", collection)).status, 200);
    assert.ok((await owner.manifest()).body.collections[collection].latest.keybindings);
    await owner.clear();
    assert.equal((await owner.manifest()).status, 204);
    assert.equal((await owner.write("settings", "stale", second.ref)).status, 412);
    assert.deepEqual((await syncVariables(fx)).filter((v) => v.name.startsWith(`${PREFIX}B`)), [], "no chunk variable is left");
  });

  it("chunks a resource over the 64 KiB variable limit and reads it back byte for byte", async () => {
    // The limit that makes chunking necessary.
    const asVariable = (value: string) => fx.api({ ...OWNER }, "POST", `${VARIABLES}/ZZ_LIMIT_PROBE`, { value });
    assert.equal((await asVariable("a".repeat(65_536))).status, 204);
    await fx.apiOk({ ...OWNER }, "DELETE", `${VARIABLES}/ZZ_LIMIT_PROBE`);
    const tooLong = await asVariable("a".repeat(70_000));
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.text, /data too long/);

    const big = randomBytes(400_000).toString("base64");
    const written = await owner.write("globalState", big, "0");
    assert.equal(written.status, 200);
    const chunks = (await syncVariables(fx)).filter((v) => v.name.startsWith(`${PREFIX}B`));
    assert.ok(chunks.length >= 6, `expected several chunks, got ${chunks.length}`);
    assert.ok(chunks.every((v) => v.data.length <= 60_000), "each chunk is below the limit");
    assert.ok(chunks.every((v) => /^[A-Za-z0-9_-]+$/.test(v.data)), "chunks are base64url text");
    const read = await owner.read("globalState");
    assert.equal(read.text, big);
    assert.equal(read.ref, written.ref);
    await owner.clear();
  });

  it("torn write: a connection lost between chunks or before the manifest leaves the previous version intact", async () => {
    const first = await owner.write("globalState", randomBytes(150_000).toString("base64"), "0");
    assert.equal(first.status, 200);
    const before = await owner.manifest();
    const content = (await owner.read("globalState")).text;
    const chunkNames = async () => (await syncVariables(fx)).filter((v) => v.name.startsWith(`${PREFIX}B`)).map((v) => v.name);
    const referenced = new Set(await chunkNames());
    const direct = (fail: (method: string, name: string, count: number) => boolean) => {
      let count = 0;
      const fetcher: typeof fetch = async (input, init) => {
        const name = String(input).split("/").pop()!;
        if (init?.method === "POST" && fail(init.method, name, ++count)) throw new TypeError("connection lost");
        return fetch(input, init);
      };
      return new SyncStore({ variables: new GiteaVariables(fx.baseUrl, `Bearer ${fx.token("owner")}`, fetcher) });
    };
    const drop = [
      direct((_, name, count) => name.startsWith(`${PREFIX}B`) && count === 2),
      direct((_, name) => name.startsWith(`${PREFIX}M`)),
    ];
    for (const store of drop) {
      await assert.rejects(store.write(undefined, "globalState", randomBytes(150_000).toString("base64"), { ifMatch: [first.ref!] }));
      assert.equal((await owner.manifest()).etag, before.etag, "the manifest did not change");
      assert.equal((await owner.read("globalState")).text, content, "readers still get the previous version");
    }
    const orphans = (await chunkNames()).filter((name) => !referenced.has(name));
    assert.ok(orphans.length > 0, "a manifest that could not be created leaves its chunks unreferenced (the outcome was unknown, so they stay)");
    assert.equal((await owner.write("globalState", "next", first.ref)).status, 200, "the client's retry works");
    try {
      await owner.clear();
      assert.deepEqual((await chunkNames()).sort(), [...orphans].sort(), "fresh orphans may be a write in progress, so a clear keeps them for an hour");
    } finally {
      for (const name of orphans) await fx.api(OWNER, "DELETE", `${VARIABLES}/${name}`);
    }
  });

  it("a read that overlaps a write sees one complete version", async () => {
    const first = await owner.write("globalState", randomBytes(200_000).toString("base64"), "0");
    const old = (await owner.read("globalState")).text;
    const next = randomBytes(200_000).toString("base64");
    let reads = 0;
    const seen: string[] = [];
    const reader = new SyncStore({ variables: new GiteaVariables(fx.baseUrl, `Bearer ${fx.token("owner")}`) });
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).includes(`/${PREFIX}B`) && reads++ > 0) seen.push((await reader.readLatest(undefined, "globalState"))!.content);
      return fetch(input, init);
    };
    const writer = new SyncStore({ variables: new GiteaVariables(fx.baseUrl, `Bearer ${fx.token("owner")}`, fetcher) });
    await writer.write(undefined, "globalState", next, { ifMatch: [first.ref!] });
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((content) => content === old), "reads during the upload got the old version");
    assert.equal((await owner.read("globalState")).text, next);
    await owner.clear();
  });

  it("two devices racing with the same If-Match: Gitea's 409 on create lets exactly one win", async () => {
    const base = await owner.write("settings", "base", "0");
    const store = () => new SyncStore({ variables: new GiteaVariables(fx.baseUrl, `Bearer ${fx.token("owner")}`) });
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => store().write(undefined, "settings", `from-${i}`, { ifMatch: [base.ref!] })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof StoreError && r.reason.status === 412);
    assert.match((await owner.read("settings")).text, /^from-\d$/);
    await owner.clear();
  });

  it("history is pruned together with its chunks", async () => {
    const small = new Client(fx, fx.token("owner"), { maxVersions: 2 });
    let ref = "0";
    for (let i = 0; i < 5; i++) ref = (await small.write("settings", `v${i}`, ref)).ref!;
    assert.equal((await syncVariables(fx)).filter((v) => v.name.startsWith(`${PREFIX}B`)).length, 2);
    await small.clear();
  });

  it("each Gitea user has a separate store, and a clear leaves other variables alone", async () => {
    const other = new Client(fx, fx.token("other"));
    await owner.write("settings", "owner data", "0");
    assert.equal((await other.manifest()).status, 204);
    await other.write("settings", "other data", "0");
    assert.equal((await owner.read("settings")).text, "owner data");
    await fx.apiOk(OWNER, "POST", `${VARIABLES}/MY_OWN_VARIABLE`, { value: "mine" });
    await owner.clear();
    assert.equal((await fx.apiOk<Variable>(OWNER, "GET", `${VARIABLES}/MY_OWN_VARIABLE`)).data, "mine");
    assert.equal((await other.read("settings")).text, "other data");
    await other.clear();
    await fx.apiOk(OWNER, "DELETE", `${VARIABLES}/MY_OWN_VARIABLE`);
  });

  it("nothing readable remains in the variables: payloads are gzip, tokens are never stored", async () => {
    await owner.write("settings", '{"marker":"hello-marker"}', "0");
    const stored = await syncVariables(fx);
    assert.ok(stored.length >= 2);
    for (const v of stored) assert.ok(!v.data.includes("hello-marker") && !v.data.includes(fx.token("owner")));
    const chunk = stored.find((v) => v.name.startsWith(`${PREFIX}B`))!;
    assert.equal(gunzipSync(Buffer.from(chunk.data, "base64url")).toString(), '{"marker":"hello-marker"}');
    assert.ok(!fx.logText().includes(fx.token("owner")));
    await owner.clear();
  });

  describe("token scopes", () => {
    const tokens = { full: "all", rw: "read:user + write:user", read: "read:user", write: "write:user", repo: "write:repository" };

    it("reads need read:user or write:user and writes need write:user; sync needs write:user", async () => {
      await owner.write("settings", "x", "0");
      const status = async (label: string) => {
        const client = new Client(fx, fx.token("owner", label));
        const read = (await client.read("settings")).status;
        const write = (await client.write("settings", "y", undefined)).status;
        return { read, write, probe: await probeVariables(fx.baseUrl, `Bearer ${fx.token("owner", label)}`) };
      };
      assert.deepEqual(await status("full"), { read: 200, write: 200, probe: "ok" }, tokens.full);
      assert.deepEqual(await status("rw"), { read: 200, write: 200, probe: "ok" }, tokens.rw);
      assert.deepEqual(await status("read"), { read: 200, write: 403, probe: "scope" }, tokens.read);
      assert.deepEqual(await status("write"), { read: 200, write: 200, probe: "ok" }, `${tokens.write}: Gitea lets write:user read too`);
      assert.deepEqual(await status("repo"), { read: 403, write: 403, probe: "scope" }, tokens.repo);
      await owner.clear();
    });

    it("an OAuth access token from the editor's PKCE flow can sync", async () => {
      const client = new Client(fx, await oauthToken(fx));
      assert.equal((await client.write("settings", "from oauth", "0")).status, 200);
      assert.equal((await client.read("settings")).text, "from oauth");
      assert.equal((await owner.read("settings")).text, "from oauth", "the same Gitea user, the same store");
      await owner.clear();
    });

    it("an unknown or revoked token gets 401", async () => {
      const res = await new Client(fx, "0123456789abcdef0123456789abcdef01234567").send("GET", `${V1}manifest`);
      assert.equal(res.status, 401);
    });
  });

  describe("Gitea rules the store depends on", () => {
    const post = (name: string, value: string) => fx.api(OWNER, "POST", `${VARIABLES}/${name}`, { value });

    it("names are upper-cased, limited to letters, digits and underscore, and GITEA_ and GITHUB_ are reserved", async () => {
      assert.equal((await post("webide_sync_lower", "v")).status, 204);
      assert.ok((await list(fx)).some((v) => v.name === "WEBIDE_SYNC_LOWER"), "stored upper-case");
      await fx.apiOk(OWNER, "DELETE", `${VARIABLES}/WEBIDE_SYNC_LOWER`);
      for (const bad of ["1ABC", "A-B", "A.B", "GITEA_X", "GITHUB_X"]) assert.equal((await post(bad, "v")).status, 400, bad);
      assert.equal((await post(`${PREFIX}M1`, "v")).status, 204, "the sync prefix is allowed");
      await fx.apiOk(OWNER, "DELETE", `${VARIABLES}/${PREFIX}M1`);
    });

    it("there is no practical limit on the number of variables", async () => {
      for (let i = 0; i < 300; i++) assert.equal((await post(`ZZ_COUNT_${i}`, "v")).status, 204, `variable ${i}`);
      assert.equal((await list(fx)).filter((v) => v.name.startsWith("ZZ_COUNT_")).length, 300);
      for (let i = 0; i < 300; i++) await fx.apiOk(OWNER, "DELETE", `${VARIABLES}/ZZ_COUNT_${i}`);
    });

    it("a duplicate create is 409, which is what makes create a compare-and-swap", async () => {
      assert.equal((await post("ZZ_CAS", "1")).status, 204);
      assert.equal((await post("ZZ_CAS", "2")).status, 409);
      assert.equal((await fx.apiOk<Variable>(OWNER, "GET", `${VARIABLES}/ZZ_CAS`)).data, "1");
      await fx.apiOk(OWNER, "DELETE", `${VARIABLES}/ZZ_CAS`);
    });
  });

  describe("visibility", () => {
    it("with Actions enabled the variables show on the user's settings page", async () => {
      await owner.write("settings", "visible", "0");
      const cookie = await webLoginWith(fx.baseUrl, "owner", fx.password("owner"));
      const page = await fetch(`${fx.baseUrl}/user/settings/actions/variables`, { headers: { cookie } });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /WEBIDE_SYNC_B/);
      await owner.clear();
    });

    it("with Actions disabled the store works and the settings page does not exist", async () => {
      const off = await startGitea({ users: [{ name: "owner", tokens: { full: ["all"] } }], extraIni: "[actions]\nENABLED = false" });
      try {
        const client = new Client(off, off.token("owner"));
        assert.equal((await client.write("settings", "invisible", "0")).status, 200);
        assert.equal((await client.read("settings")).text, "invisible");
        assert.ok((await off.apiOk<Variable[]>(OWNER, "GET", `${VARIABLES}`)).length >= 2, "the variables exist");
        const cookie = await webLoginWith(off.baseUrl, "owner", off.password("owner"));
        for (const path of ["/user/settings/actions/variables", "/user/settings/actions"]) {
          assert.equal((await fetch(`${off.baseUrl}${path}`, { headers: { cookie }, redirect: "manual" })).status, 404, path);
        }
        await client.clear();
      } finally {
        await off.stop();
      }
    });
  });
});
