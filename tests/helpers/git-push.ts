// Pushes arbitrary git content (symlinks, submodules, LFS pointers) to a fixture
// repository over HTTP with plain `git`, which the contents API cannot do.
// Credentials travel in the environment only, never in argv, URLs or logs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./gitea.ts";

/** What the helpers need of a Gitea: a GiteaFixture, or a bare origin and token for a server started elsewhere. */
interface GitTarget {
  readonly baseUrl: string;
  token(user: string): string;
}

interface GitRun {
  /** Runs git in the working copy; throws with redacted stderr on failure; returns trimmed stdout. */
  (...args: string[]): string;
  readonly dir: string;
}

function gitEnv(fixture: GitTarget, user: string, home: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`${user}:${fixture.token(user)}`).toString("base64");
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_AUTHOR_NAME: user,
    GIT_AUTHOR_EMAIL: `${user}@example.invalid`,
    GIT_COMMITTER_NAME: user,
    GIT_COMMITTER_EMAIL: `${user}@example.invalid`,
  };
}

/**
 * Clones `owner/repo`, lets `populate` change the working copy, commits and pushes `branch`.
 * Returns the new head commit id.
 */
export async function pushWithGit(
  fixture: GitTarget,
  owner: string,
  repo: string,
  message: string,
  populate: (git: GitRun) => void | Promise<void>,
  branch = "main",
): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "gitea-push-"));
  try {
    const env = gitEnv(fixture, owner, root);
    const dir = path.join(root, "work");
    const git: GitRun = Object.assign(
      (...args: string[]) => {
        const res = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd: git.dir, env, encoding: "utf8" });
        if (res.status !== 0) {
          throw new Error(redact(`git ${args[0]} failed (exit ${res.status}): ${res.stderr.split("\n").slice(-6).join("\n")}`));
        }
        return res.stdout.trim();
      },
      { dir: root },
    );
    git("clone", "--quiet", "--branch", branch, `${fixture.baseUrl}/${owner}/${repo}.git`, dir);
    Object.defineProperty(git, "dir", { value: dir });
    await populate(git);
    // Keeps index entries `populate` added without a worktree path (gitlinks).
    git("add", "--ignore-removal", ".");
    git("commit", "--quiet", "-m", message);
    git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return git("rev-parse", "HEAD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface LfsObject {
  oid: string;
  size: number;
  /** The Git LFS pointer file text for the object. */
  pointer: string;
}

export function lfsPointerFor(content: Uint8Array): LfsObject {
  const oid = createHash("sha256").update(content).digest("hex");
  return { oid, size: content.length, pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n` };
}

/**
 * Uploads an LFS object through the LFS batch API (git-lfs is not required on PATH):
 * POST info/lfs/objects/batch, PUT to the returned upload action, then the verify action.
 */
async function uploadLfsObject(fixture: GitTarget, owner: string, repo: string, content: Uint8Array): Promise<LfsObject> {
  const object = lfsPointerFor(content);
  const auth = `Basic ${Buffer.from(`${owner}:${fixture.token(owner)}`).toString("base64")}`;
  const lfsType = "application/vnd.git-lfs+json";
  const batch = await fetch(`${fixture.baseUrl}/${owner}/${repo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { authorization: auth, accept: lfsType, "content-type": lfsType },
    body: JSON.stringify({ operation: "upload", transfers: ["basic"], objects: [{ oid: object.oid, size: object.size }] }),
  });
  const text = await batch.text();
  if (batch.status !== 200) {
    throw new Error(redact(`LFS batch failed: HTTP ${batch.status}: ${text.slice(0, 300)}`));
  }
  const entry = (JSON.parse(text) as { objects: Array<{ error?: { message: string }; actions?: Record<string, { href: string; header?: Record<string, string> }> }> }).objects[0];
  if (entry.error) {
    throw new Error(redact(`LFS batch object error: ${entry.error.message}`));
  }
  // No actions means the server already has the object.
  for (const name of ["upload", "verify"] as const) {
    const action = entry.actions?.[name];
    if (!action) {
      continue;
    }
    const res = await fetch(action.href, {
      method: name === "upload" ? "PUT" : "POST",
      headers: { ...action.header, ...(name === "upload" ? { "content-type": "application/octet-stream" } : { accept: lfsType, "content-type": lfsType }) },
      body: name === "upload" ? (content as BodyInit) : JSON.stringify({ oid: object.oid, size: object.size }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(redact(`LFS ${name} failed: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`));
    }
  }
  return object;
}

export const SPECIAL_LFS_OBJECT = "real lfs needle\n".repeat(8);
const SPECIAL_LFS_LARGE = "L".repeat(400);
export const SPECIAL_SUBMODULE_COMMIT = "a".repeat(40);

interface SpecialRepo {
  head: string;
  /** Pointer file text of data.bin, large.bin and missing.bin (whose object is never uploaded). */
  pointers: { data: string; large: string; missing: string };
}

/**
 * Pushes to an existing repository: LFS files data.bin (object SPECIAL_LFS_OBJECT), large.bin
 * (SPECIAL_LFS_LARGE) and missing.bin (no object), docs/notes.txt, symlinks to a file, to a
 * directory, dangling, escaping ("../../etc/passwd"), absolute and relative-up, and a submodule
 * "sub" at SPECIAL_SUBMODULE_COMMIT. Needs Gitea's LFS server on.
 */
export async function pushSpecialFiles(target: GitTarget, owner: string, repo: string, branch = "main"): Promise<SpecialRepo> {
  const data = await uploadLfsObject(target, owner, repo, new TextEncoder().encode(SPECIAL_LFS_OBJECT));
  const large = await uploadLfsObject(target, owner, repo, new TextEncoder().encode(SPECIAL_LFS_LARGE));
  const missing = lfsPointerFor(new TextEncoder().encode("never uploaded\n"));
  const head = await pushWithGit(
    target,
    owner,
    repo,
    "special files",
    (git) => {
      const put = (name: string, text: string) => {
        mkdirSync(path.dirname(path.join(git.dir, name)), { recursive: true });
        writeFileSync(path.join(git.dir, name), text);
      };
      const link = (name: string, to: string) => symlinkSync(to, path.join(git.dir, name));
      put(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      put("data.bin", data.pointer);
      put("large.bin", large.pointer);
      put("missing.bin", missing.pointer);
      put("docs/notes.txt", "plain needle\n");
      put(".gitmodules", '[submodule "sub"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n');
      link("link-file", "docs/notes.txt");
      link("link-dir", "docs");
      link("link-dangling", "nowhere/missing");
      link("link-escape", "../../etc/passwd");
      link("link-abs", "/etc/passwd");
      link("docs/up", "../README.md");
      git("update-index", "--add", "--cacheinfo", `160000,${SPECIAL_SUBMODULE_COMMIT},sub`);
    },
    branch,
  );
  return { head, pointers: { data: data.pointer, large: large.pointer, missing: missing.pointer } };
}
