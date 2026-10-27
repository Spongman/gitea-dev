// Fixture contract used by browser tests: user passwords and OAuth applications.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GiteaFixture, redact, startGitea } from "../helpers/gitea.ts";

const OWNER = { name: "owner" };

function basic(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

/** Signs in through the web form; returns a Cookie header value. */
async function webLoginWith(base: string, user: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const absorb = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
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
  assert.match(res.headers.get("location") ?? "", /^(\/|http)/);
  assert.ok(jar.has("gitea_incredible") || jar.has("i_like_gitea"), "no session cookie");
  return header();
}

describe("Gitea fixture credentials and OAuth application", () => {
  let fx: GiteaFixture;

  const webLogin = (user: string, password: string) => webLoginWith(fx.baseUrl, user, password);

  before(async () => {
    fx = await startGitea({ users: [{ name: "owner", tokens: { full: ["all"] } }, { name: "other", tokens: { full: ["all"] } }] });
  });
  after(async () => fx?.stop());

  it("creates a distinct random password per user that really logs in", async () => {
    const owner = fx.password("owner");
    const other = fx.password("other");
    assert.ok(owner.length >= 24 && other.length >= 24);
    assert.notEqual(owner, other);
    const ok = await fetch(`${fx.baseUrl}/api/v1/user`, { headers: basic("owner", owner) });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { login: string }).login, "owner");
    assert.equal((await fetch(`${fx.baseUrl}/api/v1/user`, { headers: basic("owner", other) })).status, 401);
    assert.equal((await fetch(`${fx.baseUrl}/api/v1/user`, { headers: basic("owner", `${owner}x`) })).status, 401);
  });

  it("keeps passwords and tokens out of serialized records, errors and redacted text", () => {
    const user = fx.users.get("owner");
    assert.ok(user);
    const owner = fx.password("owner");
    const token = fx.token("owner");
    assert.equal(Object.keys(user).includes("password"), false);
    assert.equal(JSON.stringify(user).includes(owner), false);
    const redacted = redact(`p=${owner} t=${token}`);
    assert.equal(redacted.includes(owner) || redacted.includes(token), false);
    assert.equal(fx.logText().includes(owner) || fx.logText().includes(token), false);
    assert.throws(() => fx.password("nobody"), /no fixture user 'nobody'/);
  });

  it("registers a public OAuth application that Gitea's authorize endpoint accepts", async () => {
    const redirect = "http://127.0.0.1:5173/callback";
    const app = await fx.createOAuthApp(OWNER, { name: "gitea-dev-ide", redirectUris: [redirect] });
    assert.ok(app.clientId.length > 0);
    assert.equal(app.clientSecret, undefined);
    assert.deepEqual(app.redirectUris, [redirect]);
    const listed = await fx.apiOk<Array<{ client_id: string; name: string; confidential_client: boolean }>>(OWNER, "GET", "/user/applications/oauth2");
    const mine = listed.find((a) => a.client_id === app.clientId);
    assert.ok(mine);
    assert.equal(mine.confidential_client, false);

    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirect,
      response_type: "code",
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const anon = await fetch(`${fx.baseUrl}/login/oauth/authorize?${params}`, { redirect: "manual" });
    assert.ok([302, 303].includes(anon.status), `HTTP ${anon.status}`);
    assert.match(anon.headers.get("location") ?? "", /\/user\/login/);

    const cookie = await webLogin("owner", fx.password("owner"));
    const page = await fetch(`${fx.baseUrl}/login/oauth/authorize?${params}`, { headers: { cookie }, redirect: "manual" });
    const html = await page.text();
    assert.equal(page.status, 200, html.slice(0, 300));
    assert.match(html, /gitea-dev-ide/);

    const bad = new URLSearchParams(params);
    bad.set("client_id", "00000000-0000-0000-0000-000000000000");
    const unknown = await fetch(`${fx.baseUrl}/login/oauth/authorize?${bad}`, { headers: { cookie }, redirect: "manual" });
    assert.doesNotMatch(await unknown.text(), /gitea-dev-ide/);

    bad.set("client_id", app.clientId);
    bad.set("redirect_uri", "http://127.0.0.1:5173/other");
    const wrongRedirect = await fetch(`${fx.baseUrl}/login/oauth/authorize?${bad}`, { headers: { cookie }, redirect: "manual" });
    assert.notEqual(wrongRedirect.status, 200, "an unregistered redirect_uri must not reach the consent page");
  });

  it("registers a confidential application and redacts its secret", async () => {
    const app = await fx.createOAuthApp(OWNER, { name: "confidential", redirectUris: ["http://127.0.0.1:5173/cb"], confidential: true });
    assert.ok(app.clientSecret && app.clientSecret.length > 0);
    assert.equal(redact(`secret=${app.clientSecret}`).includes(app.clientSecret), false);
  });
});
