// Disposable Gitea process fixture for integration tests.
// Runs the pinned official binary (see scripts/test-gitea.mjs) against a temp
// SQLite database. Credentials are random, held in memory, and redacted from
// every error message and log excerpt.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore untyped .mjs module
import * as toolsModule from "../../scripts/test-gitea.mjs";

const tools = toolsModule as unknown as { ensureGiteaBinary(): Promise<string>; GITEA_VERSION: string };
const ensureGiteaBinary = tools.ensureGiteaBinary;
export const GITEA_VERSION: string = tools.GITEA_VERSION;

interface UserSpec {
  name: string;
  admin?: boolean;
  /** label -> scopes; every label gets its own access token. */
  tokens?: Record<string, string[]>;
}

export interface GiteaUser {
  name: string;
  tokens: Record<string, string>;
  /** Random login password; non-enumerable so logging or serializing the record cannot leak it. Use GiteaFixture.password(). */
  readonly password: string;
}

interface OAuthApp {
  name: string;
  clientId: string;
  /** Present only for confidential clients. */
  clientSecret?: string;
  redirectUris: string[];
}

export const REPO_CUSTOM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../gitea/custom");

interface StartOptions {
  /** Serve through a local reverse proxy under this prefix (e.g. "/git"). */
  subPath?: string;
  /** Defaults to DEFAULT_USERS; browser tests can pass a smaller set. */
  users?: UserSpec[];
  /** Prepare $GITEA_CUSTOM before start: true = copy this repo's gitea/custom, string = copy that directory, function = populate it. */
  custom?: boolean | string | ((customDir: string) => Promise<void>);
  /** Fixed public port; default is a free random port. Not combined with subPath. */
  port?: number;
  /** Serve over HTTPS with this key and certificate (PEM), through a TLS-terminating proxy. */
  https?: { key: string; cert: string };
  /** Appended to app.ini, e.g. "[actions]\nENABLED = false". */
  extraIni?: string;
  /** Enables Gitea's built-in LFS server (off by default). */
  lfs?: boolean;
}

export interface SeededRefs {
  /** Head commit of the default branch (main). */
  head: string;
  branch: string;
  slashBranch: string;
  tag: string;
  slashTag: string;
  /** Full commit id of the first commit with the seeded files. */
  commit: string;
}

interface ApiResult<T = unknown> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
}

export const DEFAULT_USERS: UserSpec[] = [
  { name: "admin", admin: true, tokens: { full: ["all"] } },
  { name: "owner", tokens: { full: ["all"], readonly: ["read:repository", "read:user"] } },
  { name: "writer", tokens: { full: ["all"] } },
  { name: "reader", tokens: { full: ["all"] } },
  { name: "outsider", tokens: { full: ["all"] } },
];

const secrets = new Set<string>();

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join("***");
  }
  return out;
}

function registerSecret(secret: string): string {
  secrets.add(secret);
  return secret;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function tail(file: string, lines = 40): string {
  try {
    return redact(readFileSync(file, "utf8").split("\n").slice(-lines).join("\n"));
  } catch {
    return "(no log)";
  }
}

/** Reverse proxy to Gitea: under `prefix`, and over TLS when `tls` is given. */
function startProxy(upstreamPort: number, prefix: string, tls?: { key: string; cert: string }, port = 0): Promise<{ server: http.Server; port: number }> {
  const handler: http.RequestListener = (req, res) => {
    const url = req.url ?? "/";
    if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("outside sub-path");
      return;
    }
    const stripped = url.slice(prefix.length) || "/";
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: stripped.startsWith("/") ? stripped : `/${stripped}`,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };
  const server = tls ? https.createServer(tls, handler) as unknown as http.Server : http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

export class GiteaFixture {
  readonly users = new Map<string, GiteaUser>();
  private stopped = false;

  constructor(
    /** Base URL clients must use, including any sub-path, no trailing slash. */
    readonly baseUrl: string,
    /** Direct Gitea origin, bypassing the proxy. */
    readonly directUrl: string,
    readonly subPath: string,
    private readonly proc: ChildProcess,
    private readonly proxy: http.Server | undefined,
    private readonly workDir: string,
    readonly logFile: string,
    /** $GITEA_CUSTOM for this instance. */
    readonly customDir: string,
  ) {}

  /** Redacted contents of the Gitea server log (warnings and errors only). */
  logText(): string {
    try {
      return redact(readFileSync(this.logFile, "utf8"));
    } catch {
      return "";
    }
  }

  /** Anonymous or token-authenticated GET of a web (non-API) path, relative to baseUrl. */
  async web(webPath: string, user?: { name: string; label?: string }): Promise<{ status: number; text: string; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (user) {
      headers.authorization = `token ${this.token(user.name, user.label)}`;
    }
    const res = await fetch(`${this.baseUrl}${webPath}`, { headers, redirect: "manual" });
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  /**
   * Public repo `owner/name` with main, a branch, a slash branch, a tag, a slash
   * tag and a distinct first commit. Names are valid git refs.
   */
  async seedRefs(owner: string, name: string, opts: { private?: boolean } = {}): Promise<SeededRefs> {
    await this.createRepo(owner, name, opts);
    const api = { name: owner };
    const commit = await this.commitFiles(owner, name, "main", "seed", [
      { operation: "create", path: "dir/hello.txt", content: "hello\n" },
      { operation: "create", path: "bin/blob.dat", content: new Uint8Array([0, 1, 2, 253, 254, 255]) },
    ]);
    const branch = "dev";
    const slashBranch = "feature/x-y";
    const tag = "v1.0";
    const slashTag = "rel/v1";
    for (const b of [branch, slashBranch]) {
      await this.apiOk(api, "POST", `/repos/${owner}/${name}/branches`, { new_branch_name: b, old_ref_name: "main" });
    }
    for (const t of [tag, slashTag]) {
      await this.apiOk(api, "POST", `/repos/${owner}/${name}/tags`, { tag_name: t, target: commit });
    }
    const head = await this.commitFiles(owner, name, "main", "after tags", [{ operation: "create", path: "later.txt", content: "later\n" }]);
    return { head, branch, slashBranch, tag, slashTag, commit };
  }

  token(user: string, label = "full"): string {
    const token = this.users.get(user)?.tokens[label];
    if (!token) {
      throw new Error(`no token '${label}' for user '${user}'`);
    }
    return token;
  }

  /** Login password of a fixture user, for browser sign-in tests only. */
  password(user: string): string {
    const record = this.users.get(user);
    if (!record) {
      throw new Error(`no fixture user '${user}'`);
    }
    return record.password;
  }

  /**
   * Registers an OAuth2 application for `user` through the public
   * /user/applications/oauth2 endpoint. Defaults to a public (PKCE) client
   * with skip_secondary_authorization, as the editor app is registered.
   */
  async createOAuthApp(
    user: { name: string; label?: string },
    app: { name: string; redirectUris: string[]; confidential?: boolean; skipSecondaryAuthorization?: boolean },
  ): Promise<OAuthApp> {
    const skip = app.skipSecondaryAuthorization ?? true;
    const created = await this.apiOk<{ client_id: string; client_secret?: string; redirect_uris: string[]; confidential_client: boolean; skip_secondary_authorization?: boolean }>(
      user,
      "POST",
      "/user/applications/oauth2",
      { name: app.name, redirect_uris: app.redirectUris, confidential_client: app.confidential ?? false, skip_secondary_authorization: skip },
    );
    if (created.skip_secondary_authorization !== skip) {
      throw new Error(`Gitea did not apply skip_secondary_authorization=${skip}`);
    }
    if (created.client_secret) {
      registerSecret(created.client_secret);
    }
    // Gitea 1.24.6 also returns a secret for public clients; it is not exposed because PKCE clients never use it.
    const secret = created.confidential_client ? created.client_secret || undefined : undefined;
    return { name: app.name, clientId: created.client_id, clientSecret: secret, redirectUris: created.redirect_uris };
  }

  /** Raw API call to `<baseUrl>/api/v1<path>`; `user` selects a token, null is anonymous. */
  async api<T = any>(
    user: { name: string; label?: string } | null,
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (user) {
      headers.authorization = `token ${this.token(user.name, user.label)}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.baseUrl}/api/v1${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json: json as T, text, headers: res.headers };
  }

  /** Same as api() but throws on non-2xx. */
  async apiOk<T = any>(user: { name: string; label?: string } | null, method: string, apiPath: string, body?: unknown): Promise<T> {
    const res = await this.api<T>(user, method, apiPath, body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(redact(`${method} ${apiPath} -> HTTP ${res.status}: ${res.text.slice(0, 500)}`));
    }
    return res.json;
  }

  async createRepo(owner: string, name: string, opts: { private?: boolean; defaultBranch?: string } = {}): Promise<void> {
    await this.apiOk({ name: owner }, "POST", "/user/repos", {
      name,
      private: opts.private ?? false,
      auto_init: true,
      default_branch: opts.defaultBranch ?? "main",
      readme: "Default",
    });
  }

  /** One commit via the contents API; returns the new commit sha. */
  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: Array<{ operation: "create" | "update" | "delete" | "rename"; path: string; content?: Uint8Array | string; sha?: string; from_path?: string }>,
  ): Promise<string> {
    const res = await this.apiOk<{ commit: { sha: string } }>({ name: owner }, "POST", `/repos/${owner}/${repo}/contents`, {
      message,
      branch,
      files: files.map((f) => ({
        ...f,
        content: f.content === undefined ? undefined : Buffer.from(f.content).toString("base64"),
      })),
    });
    return res.commit.sha;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await new Promise<void>((resolve) => (this.proxy ? this.proxy.close(() => resolve()) : resolve()));
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => this.proc.once("exit", () => resolve()));
      this.proc.kill("SIGTERM");
      const killer = setTimeout(() => this.proc.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(killer);
    }
    rmSync(this.workDir, { recursive: true, force: true });
  }
}

function runCli(binary: string, common: string[], env: NodeJS.ProcessEnv, args: string[], what: string): string {
  const res = spawnSync(binary, [...args, ...common], { env, encoding: "utf8" });
  if (res.status !== 0) {
    // args and stdout are deliberately omitted: they can carry credentials.
    throw new Error(redact(`gitea ${what} failed (exit ${res.status}): ${res.stderr.split("\n").slice(-8).join("\n")}`));
  }
  return res.stdout;
}

async function waitReady(url: string, proc: ChildProcess, logFile: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`gitea exited early (code ${proc.exitCode}):\n${tail(logFile)}`);
    }
    try {
      const res = await fetch(`${url}/api/healthz`);
      if (res.status === 200) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`gitea not ready within 60s:\n${tail(logFile)}`);
}

function requireGit(): void {
  const res = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error("integration tests need `git` on PATH (Gitea requires it); not found");
  }
}

export async function startGitea(options: StartOptions = {}): Promise<GiteaFixture> {
  requireGit();
  const binary = await ensureGiteaBinary();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "gitea-it-"));
  const subPath = options.subPath ? `/${options.subPath.replace(/^\/+|\/+$/g, "")}` : "";
  let fixture: GiteaFixture | undefined;
  let proc: ChildProcess | undefined;
  let proxy: http.Server | undefined;
  try {
    const giteaPort = options.https ? await freePort() : options.port ?? (await freePort());
    let publicPort = giteaPort;
    let proxyServer: http.Server | undefined;
    if (subPath || options.https) {
      const p = await startProxy(giteaPort, subPath, options.https, options.https ? options.port : undefined);
      proxyServer = proxy = p.server;
      publicPort = p.port;
    }
    const directUrl = `http://127.0.0.1:${giteaPort}`;
    const baseUrl = `${options.https ? "https" : "http"}://127.0.0.1:${publicPort}${subPath}`;

    await mkdir(path.join(workDir, "conf"), { recursive: true });
    await mkdir(path.join(workDir, "home"), { recursive: true });
    const ini = path.join(workDir, "conf", "app.ini");
    const secret = () => randomBytes(32).toString("base64url");
    await writeFile(
      ini,
      `APP_NAME = gitea-it
RUN_MODE = prod
WORK_PATH = ${workDir}

[database]
DB_TYPE = sqlite3
PATH = ${workDir}/data/gitea.db

[repository]
ROOT = ${workDir}/repos

[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${giteaPort}
DOMAIN = 127.0.0.1
ROOT_URL = ${baseUrl}/
DISABLE_SSH = true
START_SSH_SERVER = false
OFFLINE_MODE = true
LFS_START_SERVER = ${options.lfs === true}
LFS_JWT_SECRET = ${secret()}

[security]
INSTALL_LOCK = true
SECRET_KEY = ${secret()}
INTERNAL_TOKEN = ${secret()}
PASSWORD_HASH_ALGO = pbkdf2

[oauth2]
JWT_SECRET = ${secret()}

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = false

[indexer]
REPO_INDEXER_ENABLED = false

[mailer]
ENABLED = false

[log]
MODE = console
LEVEL = Warn

[other]
SHOW_FOOTER_VERSION = false

${options.extraIni ?? ""}
`,
    );

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: path.join(workDir, "home"),
      GITEA_WORK_DIR: workDir,
      LANG: "C.UTF-8",
    };
    const customDir = path.join(workDir, "custom");
    await mkdir(customDir, { recursive: true });
    if (typeof options.custom === "function") {
      await options.custom(customDir);
    } else if (options.custom) {
      await cp(options.custom === true ? REPO_CUSTOM_DIR : path.resolve(options.custom), customDir, { recursive: true });
    }
    const common = ["--config", ini, "--work-path", workDir, "--custom-path", customDir];

    runCli(binary, common, env, ["migrate"], "migrate");

    const users = new Map<string, GiteaUser>();
    for (const spec of options.users ?? DEFAULT_USERS) {
      const password = registerSecret(randomBytes(24).toString("base64url"));
      const create = ["admin", "user", "create", "--username", spec.name, "--email", `${spec.name}@example.invalid`, "--password", password, "--must-change-password=false"];
      if (spec.admin) {
        create.push("--admin");
      }
      runCli(binary, common, env, create, `create user ${spec.name}`);
      const user = { name: spec.name, tokens: {} } as GiteaUser;
      Object.defineProperty(user, "password", { value: password, enumerable: false });
      for (const [label, scopes] of Object.entries(spec.tokens ?? { full: ["all"] })) {
        const out = runCli(
          binary,
          common,
          env,
          ["admin", "user", "generate-access-token", "--username", spec.name, "--token-name", label, "--scopes", scopes.join(","), "--raw"],
          `token ${spec.name}/${label}`,
        );
        user.tokens[label] = registerSecret(out.trim());
      }
      users.set(spec.name, user);
    }

    const logFile = path.join(workDir, "gitea.log");
    const logFd = openSync(logFile, "a");
    proc = spawn(binary, ["web", ...common], { env, stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    await waitReady(directUrl, proc, logFile);

    fixture = new GiteaFixture(baseUrl, directUrl, subPath, proc, proxyServer, workDir, logFile, customDir);
    for (const [name, user] of users) {
      fixture.users.set(name, user);
    }
    return fixture;
  } catch (err) {
    if (fixture) {
      await fixture.stop();
    } else {
      proc?.kill("SIGKILL");
      proxy?.close();
      rmSync(workDir, { recursive: true, force: true });
    }
    throw err;
  }
}
