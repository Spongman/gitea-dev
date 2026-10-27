// HttpGiteaRepository against a disposable Gitea v1.24.6 (see docs/testing.md).
// Expectations follow plan.md, not the current implementation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  HttpGiteaRepository,
  PersonalAccessTokenAuth,
  RepositoryError,
  StaleBlobError,
  StaleHeadError,
  type RepositoryChange,
  type RepositoryErrorCode,
} from "../../packages/gitea-repository/src/index.ts";
import { GiteaFixture, type SeededRefs, startGitea } from "../helpers/gitea.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

let fx: GiteaFixture;
const OWNER = { name: "owner" };

type Who = "anon" | "owner" | "writer" | "reader" | "outsider" | "owner-readonly" | string;

function auth(who: Who): PersonalAccessTokenAuth | undefined {
  if (who === "anon") {
    return undefined;
  }
  if (who === "owner-readonly") {
    return new PersonalAccessTokenAuth(fx.token("owner", "readonly"));
  }
  return new PersonalAccessTokenAuth(fx.token(who));
}

function open(
  repository: string,
  ref: string,
  who: Who = "anon",
  extra: { fetch?: typeof fetch; maxFileSize?: number; instance?: string; owner?: string } = {},
): HttpGiteaRepository {
  return new HttpGiteaRepository({
    instance: extra.instance ?? fx.baseUrl,
    owner: extra.owner ?? "owner",
    repository,
    ref,
    auth: auth(who),
    fetch: extra.fetch,
    maxFileSize: extra.maxFileSize,
  });
}

async function failure(promise: Promise<unknown>): Promise<RepositoryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the operation to reject");
}

async function rejectsWith(promise: Promise<unknown>, code: RepositoryErrorCode): Promise<RepositoryError> {
  const error = await failure(promise);
  assert.equal(error.code, code, `${error.name}: ${error.message}`);
  return error;
}

function blobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function head(repo: string, branch: string): Promise<string> {
  const res = await fx.apiOk<{ commit: { id: string } }>(OWNER, "GET", `/repos/owner/${repo}/branches/${encodeURIComponent(branch)}`);
  return res.commit.id;
}

async function parentsOf(repo: string, sha: string): Promise<string[]> {
  const res = await fx.apiOk<{ parents: Array<{ sha: string }> }>(OWNER, "GET", `/repos/owner/${repo}/git/commits/${sha}`);
  return res.parents.map((p) => p.sha);
}

async function messageOf(repo: string, sha: string): Promise<string> {
  const res = await fx.apiOk<{ commit: { message: string } }>(OWNER, "GET", `/repos/owner/${repo}/git/commits/${sha}`);
  return res.commit.message;
}

async function names(repo: HttpGiteaRepository, dir = ""): Promise<string[]> {
  return (await repo.readDirectory(dir)).map((e) => e.name).sort();
}

async function text(repo: HttpGiteaRepository, path: string): Promise<string> {
  return dec.decode((await repo.readFile(path)).content);
}

async function freshRepo(name: string, files: Array<{ path: string; content: Uint8Array | string }> = [], opts: { private?: boolean } = {}): Promise<string> {
  await fx.createRepo("owner", name, opts);
  if (files.length > 0) {
    await fx.commitFiles("owner", name, "main", "seed", files.map((f) => ({ operation: "create" as const, ...f })));
  }
  return head(name, "main");
}

const LOSER_CODES: string[] = ["stale-head", "stale-blob", "commit-outcome-unknown"];
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

describe("HttpGiteaRepository against a live Gitea", { concurrency: false }, () => {
  let refs: SeededRefs;

  before(async () => {
    fx = await startGitea();
    refs = await fx.seedRefs("owner", "pub");
    await fx.createRepo("owner", "priv", { private: true });
    await fx.apiOk(OWNER, "PUT", "/repos/owner/priv/collaborators/reader", { permission: "read" });
    await fx.apiOk(OWNER, "PUT", "/repos/owner/priv/collaborators/writer", { permission: "write" });
  });
  after(async () => fx?.stop());

  describe("public reads", () => {
    it("initializes anonymously with the pinned head, branch and no write access", async () => {
      const state = await open("pub", "main").initialize();
      assert.deepEqual(state, { commit: refs.head, branch: "main", canWrite: false, canBranch: false });
    });

    it("lists directories and reads text and binary files byte for byte", async () => {
      const repo = open("pub", "main");
      await repo.initialize();
      assert.deepEqual(await names(repo), ["README.md", "bin", "dir", "later.txt"]);
      const dir = await repo.getEntry("dir");
      assert.equal(dir.type, "directory");
      const hello = await repo.getEntry("dir/hello.txt");
      assert.deepEqual([hello.type, hello.size, hello.path, hello.name], ["file", 6, "dir/hello.txt", "hello.txt"]);
      assert.equal(await text(repo, "dir/hello.txt"), "hello\n");
      const blob = await repo.readFile("/bin/blob.dat");
      assert.deepEqual([...blob.content], [0, 1, 2, 253, 254, 255]);
      assert.equal(blob.entry.sha, blobSha(blob.content));
      assert.equal((await repo.getEntry("")).type, "directory");
    });

    it("reads paths with spaces, Unicode, percent signs, # ? & + and a literal %2F", async () => {
      await freshRepo("paths");
      const special = ["sp ace/\u00fcn\u00ef \u2603.txt", "100%.txt", "a#b.txt", "q?x.txt", "plus+sign.txt", "amp&eq=.txt", "%2F.txt", "a%2Fb/c.txt"];
      await fx.commitFiles("owner", "paths", "main", "special", special.map((p) => ({ operation: "create" as const, path: p, content: `body of ${p}` })));
      const repo = open("paths", "main");
      await repo.initialize();
      for (const p of special) {
        assert.equal(await text(repo, p), `body of ${p}`, p);
      }
      assert.deepEqual(await names(repo, "a%2Fb"), ["c.txt"]);
      await rejectsWith(repo.getEntry("a/b/c.txt"), "not-found");
    });

    it("maps missing and mistyped paths to domain errors", async () => {
      const repo = open("pub", "main");
      await repo.initialize();
      await rejectsWith(repo.getEntry("nope"), "not-found");
      await rejectsWith(repo.readFile("dir/nope.txt"), "not-found");
      await rejectsWith(repo.readDirectory("dir/hello.txt"), "not-a-directory");
      await rejectsWith(repo.readFile("dir"), "is-a-directory");
      await rejectsWith(repo.getEntry("dir/hello.txt/x"), "not-a-directory");
    });

    it("rejects traversal and .git paths before any request", async () => {
      const urls: string[] = [];
      const spy: typeof fetch = (input, init) => {
        urls.push(String(input));
        return fetch(input, init);
      };
      const repo = open("pub", "main", "anon", { fetch: spy });
      await repo.initialize();
      const before = urls.length;
      for (const bad of ["../x", "dir/../../x", "a//b", "./a", ".git/config", "dir/.GIT/x"]) {
        await rejectsWith(repo.getEntry(bad), "invalid-path");
        await rejectsWith(repo.readFile(bad), "invalid-path");
      }
      assert.equal(urls.length, before);
    });

    it("rejects an empty repository", async () => {
      await fx.apiOk(OWNER, "POST", "/user/repos", { name: "empty", auto_init: false });
      await rejectsWith(open("empty", "main", "owner").initialize(), "empty-repository");
    });

    it("rejects unknown repositories, refs and uninitialized use", async () => {
      await rejectsWith(open("does-not-exist", "main").initialize(), "not-found");
      await rejectsWith(open("pub", "no-such-ref").initialize(), "not-found");
      await rejectsWith(open("pub", "main").getEntry(""), "not-initialized");
    });

    it("honors an aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      await rejectsWith(open("pub", "main").initialize({ signal: controller.signal }), "aborted");
    });

    it("reads a directory with more entries than one tree page", async () => {
      const count = 1100;
      await freshRepo("wide");
      const files = Array.from({ length: count }, (_, i) => ({ operation: "create" as const, path: `d/f${String(i).padStart(4, "0")}.txt`, content: `${i}` }));
      await fx.commitFiles("owner", "wide", "main", "wide", files);
      const repo = open("wide", "main");
      await repo.initialize();
      const entries = await repo.readDirectory("d");
      assert.equal(entries.length, count);
      assert.equal(new Set(entries.map((e) => e.name)).size, count);
    });

    it("reads a file over Gitea's API blob limit through the raw endpoint, hash-checked", async () => {
      const settings = await fx.apiOk<{ default_max_blob_size: number }>(null, "GET", "/settings/api");
      const size = settings.default_max_blob_size + 1024;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = (i * 31) & 255;
      }
      await freshRepo("bigread");
      await fx.commitFiles("owner", "bigread", "main", "big", [{ operation: "create", path: "big dir/\u00fc big.bin", content }]);
      const sha = blobSha(content);
      const blob = await fx.apiOk<{ content: string | null }>(null, "GET", `/repos/owner/bigread/git/blobs/${sha}`);
      assert.equal(blob.content, null, "Gitea should omit blob content over default_max_blob_size");
      const repo = open("bigread", "main");
      await repo.initialize();
      const file = await repo.readFile("big dir/\u00fc big.bin");
      assert.equal(file.content.length, size);
      assert.equal(blobSha(file.content), sha);
    });

    it("enforces maxFileSize on reads", async () => {
      const repo = open("pub", "main", "anon", { maxFileSize: 4 });
      await repo.initialize();
      await rejectsWith(repo.readFile("dir/hello.txt"), "file-too-large");
    });
  });

  describe("refs", () => {
    const cases = (): Array<{ label: string; ref: string; branch: string | null; hasLater: boolean; commit: string }> => [
      { label: "branch", ref: refs.branch, branch: refs.branch, hasLater: false, commit: refs.commit },
      { label: "slash branch", ref: refs.slashBranch, branch: refs.slashBranch, hasLater: false, commit: refs.commit },
      { label: "refs/heads/ prefix", ref: "refs/heads/main", branch: "main", hasLater: true, commit: refs.head },
      { label: "tag", ref: refs.tag, branch: null, hasLater: false, commit: refs.commit },
      { label: "slash tag", ref: refs.slashTag, branch: null, hasLater: false, commit: refs.commit },
      { label: "refs/tags/ prefix", ref: `refs/tags/${refs.tag}`, branch: null, hasLater: false, commit: refs.commit },
      { label: "full commit id", ref: refs.commit, branch: null, hasLater: false, commit: refs.commit },
      { label: "main head commit id", ref: refs.head, branch: null, hasLater: true, commit: refs.head },
    ];

    it("pins every ref kind to the right commit and tree", async () => {
      for (const c of cases()) {
        const repo = open("pub", c.ref);
        const state = await repo.initialize();
        assert.equal(state.commit, c.commit, c.label);
        assert.equal(state.branch, c.branch, c.label);
        assert.equal(state.canWrite, false, `${c.label}: anonymous`);
        assert.equal((await names(repo)).includes("later.txt"), c.hasLater, c.label);
        assert.equal(await text(repo, "dir/hello.txt"), "hello\n", c.label);
      }
    });

    it("grants write only on branches", async () => {
      for (const c of cases()) {
        const state = await open("pub", c.ref, "owner").initialize();
        assert.equal(state.canWrite, c.branch !== null, c.label);
      }
    });

    it("resolves a short commit id to the full id, or rejects it", async () => {
      const short = refs.commit.slice(0, 10);
      const repo = open("pub", short);
      const state = await repo.initialize().catch((e: unknown) => e);
      if (state instanceof RepositoryError) {
        assert.ok(["not-found", "invalid-argument"].includes(state.code), state.code);
      } else {
        assert.equal((state as { commit: string }).commit, refs.commit);
      }
    });

    it("keeps reading the pinned commit after the branch moves, until refreshed", async () => {
      const base = await freshRepo("moving", [{ path: "a.txt", content: "one" }]);
      const repo = open("moving", "main");
      assert.equal((await repo.initialize()).commit, base);
      const moved = await fx.commitFiles("owner", "moving", "main", "move", [{ operation: "create", path: "b.txt", content: "two" }]);
      assert.deepEqual(await names(repo), ["README.md", "a.txt"]);
      await repo.refresh();
      assert.deepEqual(await names(repo), ["README.md", "a.txt", "b.txt"]);
      await repo.refresh(base);
      assert.deepEqual(await names(repo), ["README.md", "a.txt"]);
      await repo.refresh(moved);
      assert.deepEqual(await names(repo), ["README.md", "a.txt", "b.txt"]);
    });

    it("reads a tag and a branch that share a name through the qualified forms", async () => {
      await fx.apiOk(OWNER, "POST", "/repos/owner/pub/branches", { new_branch_name: "shared", old_ref_name: "main" });
      const tagged = await fx.api(OWNER, "POST", "/repos/owner/pub/tags", { tag_name: "shared", target: refs.commit });
      if (tagged.status !== 201) {
        // Gitea refuses the tag; the ambiguity cannot arise through the API.
        assert.ok([409, 422].includes(tagged.status), `unexpected HTTP ${tagged.status}: ${tagged.text}`);
        return;
      }
      const asBranch = await open("pub", "refs/heads/shared").initialize();
      const asTag = await open("pub", "refs/tags/shared").initialize();
      assert.equal(asBranch.branch, "shared");
      assert.equal(asBranch.commit, refs.head);
      assert.equal(asTag.branch, null);
      assert.equal(asTag.commit, refs.commit);
    });
  });

  describe("private repository and permission enforcement", () => {
    it("hides a private repository from anonymous users and non-collaborators", async () => {
      await rejectsWith(open("priv", "main").initialize(), "not-found");
      await rejectsWith(open("priv", "main", "outsider").initialize(), "not-found");
    });

    it("reports an invalid token as unauthenticated without echoing it", async () => {
      const bogus = "0123456789abcdef0123456789abcdef01234567";
      const repo = new HttpGiteaRepository({ instance: fx.baseUrl, owner: "owner", repository: "priv", ref: "main", auth: new PersonalAccessTokenAuth(bogus) });
      const error = await rejectsWith(repo.initialize(), "unauthenticated");
      assert.equal(error.message.includes(bogus), false);
    });

    it("reads a private repository as a read collaborator without write access", async () => {
      const repo = open("priv", "main", "reader");
      const state = await repo.initialize();
      assert.equal(state.canWrite, false);
      assert.deepEqual(await names(repo), ["README.md"]);
      const error = await rejectsWith(repo.commit({ message: "nope", baseCommit: state.commit, changes: [{ path: "x.txt", type: "create", content: enc.encode("x") }] }), "read-only");
      assert.equal(error.status, undefined);
      assert.equal(await head("priv", "main"), state.commit);
    });

    it("grants a write collaborator write access", async () => {
      assert.equal((await open("priv", "main", "writer").initialize()).canWrite, true);
    });

    it("never puts the token in a URL or an error message", async () => {
      const seen: string[] = [];
      const spy: typeof fetch = (input, init) => {
        seen.push(String(input));
        return fetch(input, init);
      };
      const token = fx.token("owner");
      const repo = open("priv", "main", "owner", { fetch: spy });
      await repo.initialize();
      await repo.readDirectory("");
      assert.ok(seen.length > 0);
      assert.equal(seen.some((u) => u.includes(token)), false);
    });

    it("has the server reject writes the client would never send (anonymous, outsider, read collaborator, read-only token)", async () => {
      const body = { message: "x", branch: "main", files: [{ operation: "create", path: "x.txt", content: "eA==" }] };
      assert.equal((await fx.api(null, "POST", "/repos/owner/priv/contents", body)).status, 404);
      assert.equal((await fx.api({ name: "outsider" }, "POST", "/repos/owner/priv/contents", body)).status, 404);
      assert.equal((await fx.api({ name: "reader" }, "POST", "/repos/owner/priv/contents", body)).status, 403);
      assert.equal((await fx.api({ name: "owner", label: "readonly" }, "POST", "/repos/owner/priv/contents", body)).status, 403);
      assert.equal((await fx.api(null, "POST", "/repos/owner/pub/contents", body)).status, 401);
      assert.equal((await fx.api({ name: "outsider" }, "POST", "/repos/owner/pub/contents", body)).status, 403);
    });

    it("lets a read-only-scope token read but fails its commit as forbidden without committing", async () => {
      const base = await head("priv", "main");
      const repo = open("priv", "main", "owner-readonly");
      const state = await repo.initialize();
      assert.deepEqual(await names(repo), ["README.md"]);
      if (state.canWrite) {
        const error = await rejectsWith(repo.commit({ message: "scope", baseCommit: state.commit, changes: [{ path: "scope.txt", type: "create", content: enc.encode("x") }] }), "forbidden");
        assert.equal(error.status, 403);
      }
      assert.equal(await head("priv", "main"), base);
    });
  });

  describe("commit", () => {
    it("creates text and binary files in exactly one commit and reads them back", async () => {
      const base = await freshRepo("c-create");
      const repo = open("c-create", "main", "owner");
      await repo.initialize();
      const result = await repo.commit({
        message: "add files\n\nwith a body",
        baseCommit: base,
        changes: [
          { path: "docs/readme.txt", type: "create", content: enc.encode("h\u00e9llo\n") },
          { path: "bin/all bytes.dat", type: "create", content: ALL_BYTES },
          { path: "empty.txt", type: "create", content: new Uint8Array(0) },
        ],
      });
      assert.deepEqual(await parentsOf("c-create", result.sha), [base]);
      assert.equal(await head("c-create", "main"), result.sha);
      assert.equal((await messageOf("c-create", result.sha)).trim(), "add files\n\nwith a body");
      await repo.refresh(result.sha);
      assert.equal(await text(repo, "docs/readme.txt"), "h\u00e9llo\n");
      assert.deepEqual([...(await repo.readFile("bin/all bytes.dat")).content], [...ALL_BYTES]);
      assert.equal((await repo.readFile("empty.txt")).content.length, 0);
    });

    it("updates, deletes and renames, including binary, in one commit", async () => {
      const original = Uint8Array.from([9, 8, 7, 0, 255]);
      const base = await freshRepo("c-mix", [
        { path: "keep.txt", content: "keep" },
        { path: "edit.txt", content: "before" },
        { path: "gone.txt", content: "bye" },
        { path: "old name.bin", content: original },
        { path: "move/edit.bin", content: ALL_BYTES },
      ]);
      const repo = open("c-mix", "main", "owner");
      await repo.initialize();
      const sha = async (p: string) => (await repo.getEntry(p)).sha;
      const changes: RepositoryChange[] = [
        { path: "edit.txt", type: "update", content: enc.encode("after"), originalSha: await sha("edit.txt") },
        { path: "gone.txt", type: "delete", originalSha: await sha("gone.txt") },
        { path: "new dir/\u00fcn\u00ef.bin", type: "update", previousPath: "old name.bin", originalSha: await sha("old name.bin") },
        { path: "move/renamed.bin", type: "update", previousPath: "move/edit.bin", originalSha: await sha("move/edit.bin"), content: Uint8Array.from([...ALL_BYTES].reverse()) },
        { path: "fresh.bin", type: "create", content: Uint8Array.from([0, 0, 0]) },
      ];
      const result = await repo.commit({ message: "mixed", baseCommit: base, changes });
      assert.deepEqual(await parentsOf("c-mix", result.sha), [base], "one commit on top of base");
      await repo.refresh(result.sha);
      assert.deepEqual(await names(repo), ["README.md", "edit.txt", "fresh.bin", "keep.txt", "move", "new dir"]);
      assert.equal(await text(repo, "edit.txt"), "after");
      assert.equal(await text(repo, "keep.txt"), "keep");
      assert.deepEqual([...(await repo.readFile("new dir/\u00fcn\u00ef.bin")).content], [...original]);
      assert.deepEqual(await names(repo, "move"), ["renamed.bin"]);
      assert.deepEqual([...(await repo.readFile("move/renamed.bin")).content], [...ALL_BYTES].reverse());
      assert.deepEqual([...(await repo.readFile("fresh.bin")).content], [0, 0, 0]);
      await rejectsWith(repo.getEntry("gone.txt"), "not-found");
      await rejectsWith(repo.getEntry("old name.bin"), "not-found");
    });

    it("commits an 11 MiB binary above Gitea's API blob size", async () => {
      const base = await freshRepo("c-big");
      const size = 11 * 1024 * 1024;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = (i * 7) & 255;
      }
      const repo = open("c-big", "main", "owner");
      await repo.initialize();
      const result = await repo.commit({ message: "big", baseCommit: base, changes: [{ path: "big.bin", type: "create", content }] });
      await repo.refresh(result.sha);
      const file = await repo.readFile("big.bin");
      assert.equal(blobSha(file.content), blobSha(content));
    });

    it("commits to a slash branch and leaves main alone", async () => {
      await freshRepo("c-slash");
      await fx.apiOk(OWNER, "POST", "/repos/owner/c-slash/branches", { new_branch_name: "feature/x-y", old_ref_name: "main" });
      const mainHead = await head("c-slash", "main");
      const repo = open("c-slash", "feature/x-y", "owner");
      const state = await repo.initialize();
      assert.equal(state.canWrite, true);
      const result = await repo.commit({ message: "on branch", baseCommit: state.commit, changes: [{ path: "f.txt", type: "create", content: enc.encode("f") }] });
      assert.equal(await head("c-slash", "feature/x-y"), result.sha);
      assert.equal(await head("c-slash", "main"), mainHead);
    });

    it("refuses to commit to a tag or a commit", async () => {
      for (const ref of [refs.tag, refs.commit]) {
        const repo = open("pub", ref, "owner");
        const state = await repo.initialize();
        await rejectsWith(repo.commit({ message: "x", baseCommit: state.commit, changes: [{ path: "x.txt", type: "create", content: enc.encode("x") }] }), "read-only");
      }
    });

    it("validates the request before sending it", async () => {
      const base = await freshRepo("c-invalid", [{ path: "a.txt", content: "a" }]);
      const repo = open("c-invalid", "main", "owner");
      await repo.initialize();
      const sha = (await repo.getEntry("a.txt")).sha;
      const create = (path: string): RepositoryChange => ({ path, type: "create", content: enc.encode("x") });
      const ok = { message: "m", baseCommit: base };
      await rejectsWith(repo.commit({ ...ok, message: "  ", changes: [create("x")] }), "invalid-change");
      await rejectsWith(repo.commit({ ...ok, changes: [] }), "invalid-change");
      await rejectsWith(repo.commit({ ...ok, baseCommit: "abc", changes: [create("x")] }), "invalid-change");
      await rejectsWith(repo.commit({ ...ok, changes: [create("../x")] }), "invalid-path");
      await rejectsWith(repo.commit({ ...ok, changes: [create("x"), create("x")] }), "invalid-change");
      await rejectsWith(repo.commit({ ...ok, changes: [{ path: "a.txt", type: "update", content: enc.encode("b") }] }), "invalid-change");
      await rejectsWith(repo.commit({ ...ok, changes: [{ path: "a.txt", type: "delete" }] }), "invalid-change");
      await rejectsWith(repo.commit({ ...ok, changes: [{ path: "a.txt", type: "create", content: enc.encode("b"), originalSha: sha }] }), "invalid-change");
      assert.equal(await head("c-invalid", "main"), base);
    });

    it("enforces maxFileSize on commits", async () => {
      const base = await freshRepo("c-limit");
      const repo = open("c-limit", "main", "owner", { maxFileSize: 8 });
      await repo.initialize();
      await rejectsWith(repo.commit({ message: "m", baseCommit: base, changes: [{ path: "big.txt", type: "create", content: new Uint8Array(9) }] }), "file-too-large");
      assert.equal(await head("c-limit", "main"), base);
    });

    it("rejects creating a path that already exists", async () => {
      const base = await freshRepo("c-exists", [{ path: "a.txt", content: "a" }]);
      const repo = open("c-exists", "main", "owner");
      await repo.initialize();
      const error = await rejectsWith(repo.commit({ message: "dup", baseCommit: base, changes: [{ path: "a.txt", type: "create", content: enc.encode("b") }] }), "already-exists");
      assert.equal(error.status, 422);
      assert.equal(await head("c-exists", "main"), base);
    });

    it("is atomic: one failing change leaves the branch and every other change untouched", async () => {
      const base = await freshRepo("c-atomic", [{ path: "a.txt", content: "a" }]);
      const repo = open("c-atomic", "main", "owner");
      await repo.initialize();
      await rejectsWith(
        repo.commit({
          message: "partial",
          baseCommit: base,
          changes: [
            { path: "fresh.txt", type: "create", content: enc.encode("fresh") },
            { path: "a.txt", type: "create", content: enc.encode("dup") },
          ],
        }),
        "already-exists",
      );
      assert.equal(await head("c-atomic", "main"), base);
      await repo.refresh();
      await rejectsWith(repo.getEntry("fresh.txt"), "not-found");
    });

    it("rejects a commit whose base is behind the branch head and creates nothing", async () => {
      const base = await freshRepo("c-stale-head", [{ path: "a.txt", content: "a" }]);
      const repo = open("c-stale-head", "main", "owner");
      await repo.initialize();
      const sha = (await repo.getEntry("a.txt")).sha;
      const remote = await fx.commitFiles("owner", "c-stale-head", "main", "remote", [{ operation: "create", path: "r.txt", content: "r" }]);
      const error = await failure(repo.commit({ message: "late", baseCommit: base, changes: [{ path: "a.txt", type: "update", content: enc.encode("mine"), originalSha: sha }] }));
      assert.ok(error instanceof StaleHeadError, `${error.name}: ${error.message}`);
      assert.equal(error.code, "stale-head");
      assert.equal(error.baseCommit, base);
      assert.equal(error.headCommit, remote);
      assert.equal(await head("c-stale-head", "main"), remote);
      assert.deepEqual(await parentsOf("c-stale-head", remote), [base]);
      await repo.refresh();
      assert.equal(await text(repo, "a.txt"), "a");
    });

    it("rejects a stale blob at the current head and names the path, without overwriting", async () => {
      const base = await freshRepo("c-stale-blob", [
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
      ]);
      const repo = open("c-stale-blob", "main", "owner");
      await repo.initialize();
      const aSha = (await repo.getEntry("a.txt")).sha;
      const bSha = (await repo.getEntry("b.txt")).sha;
      // The caller's base commit equals the head, but its idea of a.txt is out of date.
      const stale = blobSha(enc.encode("something else"));
      const err1 = await failure(repo.commit({ message: "stale", baseCommit: base, changes: [{ path: "a.txt", type: "update", content: enc.encode("mine"), originalSha: stale }, { path: "b.txt", type: "update", content: enc.encode("B"), originalSha: bSha }] }));
      assert.ok(err1 instanceof StaleBlobError, `${err1.name}: ${err1.message}`);
      assert.deepEqual([...err1.paths], ["a.txt"]);
      const err2 = await failure(repo.commit({ message: "stale delete", baseCommit: base, changes: [{ path: "a.txt", type: "delete", originalSha: stale }] }));
      assert.equal(err2.code, "stale-blob");
      assert.equal(await head("c-stale-blob", "main"), base);
      assert.equal(await text(repo, "a.txt"), "a");
      assert.equal((await repo.getEntry("a.txt")).sha, aSha);
    });

    it("never loses data when two writers race on the same file", async () => {
      const base = await freshRepo("c-race", [{ path: "shared.txt", content: "base" }]);
      const a = open("c-race", "main", "owner");
      const b = open("c-race", "main", "writer");
      await fx.apiOk(OWNER, "PUT", "/repos/owner/c-race/collaborators/writer", { permission: "write" });
      await a.initialize();
      await b.initialize();
      const sha = (await a.getEntry("shared.txt")).sha;
      const attempt = (repo: HttpGiteaRepository, value: string) =>
        repo.commit({ message: value, baseCommit: base, changes: [{ path: "shared.txt", type: "update", content: enc.encode(value), originalSha: sha }] });
      const results = await Promise.allSettled([attempt(a, "from-a"), attempt(b, "from-b")]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.ok(lost[0].reason instanceof RepositoryError);
      // Gitea answers the loser of a same-branch push race with HTTP 500 (PushRejected); the client cannot tell that from an unknown outcome.
      assert.ok(LOSER_CODES.includes(lost[0].reason.code), lost[0].reason.code);
      const winner = results[0].status === "fulfilled" ? "from-a" : "from-b";
      const reader = open("c-race", "main");
      await reader.initialize();
      assert.equal(await text(reader, "shared.txt"), winner);
      assert.deepEqual(await parentsOf("c-race", await head("c-race", "main")), [base]);
    });

    it("keeps every successful commit when two writers race on different files", async () => {
      const base = await freshRepo("c-race2", [{ path: "a.txt", content: "a" }]);
      await fx.apiOk(OWNER, "PUT", "/repos/owner/c-race2/collaborators/writer", { permission: "write" });
      const a = open("c-race2", "main", "owner");
      const b = open("c-race2", "main", "writer");
      await a.initialize();
      await b.initialize();
      const attempt = (repo: HttpGiteaRepository, path: string) => repo.commit({ message: path, baseCommit: base, changes: [{ path, type: "create", content: enc.encode(path) }] });
      const results = await Promise.allSettled([attempt(a, "from-a.txt"), attempt(b, "from-b.txt")]);
      assert.ok(results.some((r) => r.status === "fulfilled"));
      for (const r of results) {
        if (r.status === "rejected") {
          assert.ok(r.reason instanceof RepositoryError);
          assert.ok(LOSER_CODES.includes(r.reason.code), r.reason.code);
        }
      }
      const reader = open("c-race2", "main");
      await reader.initialize();
      const present = await names(reader);
      assert.equal(present.includes("from-a.txt"), results[0].status === "fulfilled");
      assert.equal(present.includes("from-b.txt"), results[1].status === "fulfilled");
    });

    it("fails a delete of a path that does not exist without committing", async () => {
      const base = await freshRepo("c-del-missing");
      const repo = open("c-del-missing", "main", "owner");
      await repo.initialize();
      const phantom = blobSha(enc.encode("phantom"));
      await failure(repo.commit({ message: "del", baseCommit: base, changes: [{ path: "ghost.txt", type: "delete", originalSha: phantom }] }));
      assert.equal(await head("c-del-missing", "main"), base);
    });
  });

  describe("protected and archived repositories", () => {
    it("denies writes on a branch protected against pushes, server side and client side", async () => {
      const base = await freshRepo("prot");
      await fx.apiOk(OWNER, "PUT", "/repos/owner/prot/collaborators/writer", { permission: "write" });
      await fx.apiOk(OWNER, "POST", "/repos/owner/prot/branch_protections", { rule_name: "main", enable_push: false });
      const body = { message: "x", branch: "main", files: [{ operation: "create", path: "x.txt", content: "eA==" }] };
      assert.equal((await fx.api(OWNER, "POST", "/repos/owner/prot/contents", body)).status, 403);
      assert.equal((await fx.api({ name: "writer" }, "POST", "/repos/owner/prot/contents", body)).status, 403);
      const repo = open("prot", "main", "owner");
      const state = await repo.initialize();
      assert.equal(state.canWrite, false);
      await rejectsWith(repo.commit({ message: "x", baseCommit: base, changes: [{ path: "x.txt", type: "create", content: enc.encode("x") }] }), "read-only");
      assert.equal(await head("prot", "main"), base);
    });

    it("allows a user on the push allowlist and nobody else", async () => {
      const base = await freshRepo("prot-allow");
      await fx.apiOk(OWNER, "PUT", "/repos/owner/prot-allow/collaborators/writer", { permission: "write" });
      await fx.apiOk(OWNER, "POST", "/repos/owner/prot-allow/branch_protections", {
        rule_name: "main",
        enable_push: true,
        enable_push_whitelist: true,
        push_whitelist_usernames: ["writer"],
      });
      assert.equal((await open("prot-allow", "main", "owner").initialize()).canWrite, false);
      const writer = open("prot-allow", "main", "writer");
      const state = await writer.initialize();
      assert.equal(state.canWrite, true);
      const result = await writer.commit({ message: "allowed", baseCommit: base, changes: [{ path: "w.txt", type: "create", content: enc.encode("w") }] });
      assert.equal(await head("prot-allow", "main"), result.sha);
    });

    it("keeps an unprotected branch of a protected repository writable", async () => {
      await freshRepo("prot-other");
      await fx.apiOk(OWNER, "POST", "/repos/owner/prot-other/branch_protections", { rule_name: "main", enable_push: false });
      await fx.apiOk(OWNER, "POST", "/repos/owner/prot-other/branches", { new_branch_name: "work", old_ref_name: "main" });
      const repo = open("prot-other", "work", "owner");
      const state = await repo.initialize();
      assert.equal(state.canWrite, true);
      await repo.commit({ message: "ok", baseCommit: state.commit, changes: [{ path: "w.txt", type: "create", content: enc.encode("w") }] });
    });

    it("reads an archived repository but never writes to it", async () => {
      const base = await freshRepo("arch", [{ path: "a.txt", content: "a" }]);
      await fx.apiOk(OWNER, "PATCH", "/repos/owner/arch", { archived: true });
      const repo = open("arch", "main", "owner");
      const state = await repo.initialize();
      assert.equal(state.canWrite, false);
      assert.equal(await text(repo, "a.txt"), "a");
      await rejectsWith(repo.commit({ message: "x", baseCommit: base, changes: [{ path: "x.txt", type: "create", content: enc.encode("x") }] }), "read-only");
      const body = { message: "x", branch: "main", files: [{ operation: "create", path: "x.txt", content: "eA==" }] };
      assert.equal((await fx.api(OWNER, "POST", "/repos/owner/arch/contents", body)).status, 423);
      assert.equal(await head("arch", "main"), base);
    });

    it("maps a write that races with archiving to the archived error", async () => {
      const base = await freshRepo("arch-race");
      const repo = open("arch-race", "main", "owner");
      const state = await repo.initialize();
      assert.equal(state.canWrite, true);
      await fx.apiOk(OWNER, "PATCH", "/repos/owner/arch-race", { archived: true });
      await rejectsWith(repo.commit({ message: "x", baseCommit: base, changes: [{ path: "x.txt", type: "create", content: enc.encode("x") }] }), "archived");
      assert.equal(await head("arch-race", "main"), base);
    });
  });

  describe("recorded Gitea limits", () => {
    it("matches the API limits documented in docs/testing.md", async () => {
      const api = await fx.apiOk<Record<string, number>>(null, "GET", "/settings/api");
      assert.deepEqual(api, {
        max_response_items: 50,
        default_paging_num: 30,
        default_git_trees_per_page: 1000,
        default_max_blob_size: 10485760,
        default_max_response_size: 104857600,
      });
    });

    it("has no 'rename' contents operation: renames are update with from_path", async () => {
      const base = await freshRepo("lim-rename", [{ path: "a.txt", content: "a" }]);
      const entry = await fx.apiOk<{ sha: string }>(OWNER, "GET", "/repos/owner/lim-rename/contents/a.txt?ref=main");
      const res = await fx.api(OWNER, "POST", "/repos/owner/lim-rename/contents", {
        message: "rn",
        branch: "main",
        files: [{ operation: "rename", from_path: "a.txt", path: "b.txt", sha: entry.sha }],
      });
      assert.equal(res.status, 500);
      assert.match(fx.logText(), /invalid file operation: rename b\.txt/);
      assert.equal(await head("lim-rename", "main"), base);
    });

    it("rejects a branch name containing a space but accepts '#'", async () => {
      const space = await fx.api(OWNER, "POST", "/repos/owner/pub/branches", { new_branch_name: "a b", old_ref_name: "main" });
      assert.equal(space.status, 422);
      const hash = await fx.api(OWNER, "POST", "/repos/owner/pub/branches", { new_branch_name: "h#ash", old_ref_name: "main" });
      assert.equal(hash.status, 201);
    });

    it("answers a concurrent push to one branch with HTTP 500 for the loser", async () => {
      await freshRepo("lim-race");
      const make = (path: string) => fx.api(OWNER, "POST", "/repos/owner/lim-race/contents", { message: path, branch: "main", files: [{ operation: "create", path, content: "eA==" }] });
      const statuses: number[] = [];
      for (let round = 0; round < 5 && !statuses.includes(500); round++) {
        const rs = await Promise.all([make(`a${round}.txt`), make(`b${round}.txt`), make(`c${round}.txt`)]);
        statuses.push(...rs.map((r) => r.status));
      }
      assert.ok(statuses.every((s) => s === 201 || s === 500), JSON.stringify(statuses));
      assert.ok(statuses.includes(500), "no concurrent push was rejected in 5 rounds; the documented 500 was not observed");
      assert.match(fx.logText(), /PushRejected/);
    });
  });
});

describe("HttpGiteaRepository under a sub-path", { concurrency: false }, () => {
  let sub: GiteaFixture;
  let subRefs: SeededRefs;

  before(async () => {
    sub = await startGitea({ subPath: "/git/hub", users: [{ name: "owner", tokens: { full: ["all"] } }] });
    subRefs = await sub.seedRefs("owner", "pub");
    await sub.createRepo("owner", "priv", { private: true });
  });
  after(async () => sub?.stop());

  const repoFor = (repository: string, ref: string, token = true) =>
    new HttpGiteaRepository({
      instance: sub.baseUrl,
      owner: "owner",
      repository,
      ref,
      auth: token ? new PersonalAccessTokenAuth(sub.token("owner")) : undefined,
    });

  it("reads and commits through the proxy that strips the prefix", async () => {
    assert.equal(new URL(sub.baseUrl).pathname, "/git/hub");
    const anon = repoFor("pub", subRefs.slashBranch, false);
    assert.equal((await anon.initialize()).commit, subRefs.commit);
    assert.equal(dec.decode((await anon.readFile("dir/hello.txt")).content), "hello\n");

    const repo = repoFor("priv", "main");
    const state = await repo.initialize();
    assert.equal(state.canWrite, true);
    const result = await repo.commit({ message: "via proxy", baseCommit: state.commit, changes: [{ path: "p/q.bin", type: "create", content: ALL_BYTES }] });
    await repo.refresh(result.sha);
    assert.deepEqual([...(await repo.readFile("p/q.bin")).content], [...ALL_BYTES]);
  });

  it("tolerates a trailing slash on the instance", async () => {
    const repo = new HttpGiteaRepository({ instance: `${sub.baseUrl}/`, owner: "owner", repository: "pub", ref: "main" });
    assert.equal((await repo.initialize()).branch, "main");
  });

  it("does not find the repository outside the sub-path", async () => {
    const origin = new URL(sub.baseUrl).origin;
    const repo = new HttpGiteaRepository({ instance: origin, owner: "owner", repository: "pub", ref: "main" });
    await rejectsWith(repo.initialize(), "not-found");
  });
});
