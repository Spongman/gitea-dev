// Ref listing, branch creation, new-branch commits, selective commits, remote checks and pull
// requests against a disposable Gitea v1.24.6 (see docs/testing.md). Expectations follow the
// Gitea API (swagger) and plan.md ("Branches, staging and pull requests"), not the current implementation.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GiteaRefs, PersonalAccessTokenAuth, RepositoryError } from "../../packages/gitea-repository/src/index.ts";
import type { Descriptor } from "../../packages/gitea-vscode-web/src/descriptor.ts";
import { OverlayError } from "../../packages/gitea-vscode-web/src/overlay.ts";
import { Session } from "../../packages/gitea-vscode-web/src/session.ts";
import { MemoryOverlayStorage, type OverlayStorage } from "../../packages/gitea-vscode-web/src/storage.ts";
import { GiteaFixture, startGitea } from "../helpers/gitea.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const OWNER = { name: "owner" };
const WRITE = { create: true, overwrite: true };

let fx: GiteaFixture;

function refsFor(repo: string, who = "owner"): GiteaRefs {
  return new GiteaRefs({ instance: fx.baseUrl, owner: "owner", repository: repo, auth: new PersonalAccessTokenAuth(fx.token(who)) });
}

async function open(repo: string, ref = "main", who = "owner", storage: OverlayStorage = new MemoryOverlayStorage()): Promise<Session> {
  const descriptor: Descriptor = { instance: fx.baseUrl, owner: "owner", repository: repo, ref, refKind: "branch" };
  return Session.open(descriptor, { storage, auth: new PersonalAccessTokenAuth(fx.token(who)) });
}

async function freshRepo(name: string, files: Array<{ path: string; content: string }> = [{ path: "a.txt", content: "alpha" }, { path: "b.txt", content: "bravo" }]): Promise<string> {
  await fx.createRepo("owner", name);
  return fx.commitFiles("owner", name, "main", "seed", files.map((f) => ({ operation: "create" as const, ...f })));
}

async function headOf(repo: string, branch: string): Promise<string> {
  return (await fx.apiOk(OWNER, "GET", `/repos/owner/${repo}/branches/${branch}`)).commit.id;
}

async function fileAt(repo: string, ref: string, path: string): Promise<string | undefined> {
  const res = await fx.api(OWNER, "GET", `/repos/owner/${repo}/raw/${path}?ref=${encodeURIComponent(ref)}`);
  return res.status === 200 ? res.text : undefined;
}

async function rejectsOverlay(promise: Promise<unknown>, code: OverlayError["code"]): Promise<OverlayError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OverlayError, `expected OverlayError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail("expected a rejection");
}

async function rejectsRepo(promise: Promise<unknown>): Promise<RepositoryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a rejection");
}

describe("source control against Gitea", () => {
  before(async () => {
    fx = await startGitea();
  });
  after(async () => fx?.stop());

  describe("refs", () => {
    it("lists every branch across pages and the tags", async () => {
      const seeded = await fx.seedRefs("owner", "many");
      for (let i = 0; i < 52; i++) {
        await fx.apiOk(OWNER, "POST", "/repos/owner/many/branches", { new_branch_name: `b/${i}`, old_ref_name: "main" });
      }
      const refs = refsFor("many");
      const { branches, truncated } = await refs.listBranches();
      assert.equal(truncated, false);
      // main, dev, feature/x-y from seedRefs, plus 52.
      assert.equal(branches.length, 55);
      assert.equal(new Set(branches.map((b) => b.name)).size, 55);
      assert.equal(branches.find((b) => b.name === "main")?.commit, seeded.head);
      const { branches: tags } = await refs.listTagRefs();
      assert.deepEqual(tags.map((t) => t.name).sort(), ["rel/v1", "v1.0"]);
      assert.equal(tags.find((t) => t.name === "v1.0")?.commit, seeded.commit);
    });

    it("creates a branch from a branch, a tag and a full commit id", async () => {
      const seeded = await fx.seedRefs("owner", "mk");
      const refs = refsFor("mk");
      // seedRefs cut dev before the later commit on main.
      assert.equal((await refs.createBranch("from-main", "main")).commit, seeded.head);
      assert.equal((await refs.createBranch("from-branch", "dev")).commit, seeded.commit);
      assert.equal((await refs.createBranch("from-tag", "v1.0")).commit, seeded.commit);
      assert.equal((await refs.createBranch("from-sha", seeded.commit)).commit, seeded.commit);
      assert.equal((await refs.createBranch("with/slash", "main")).name, "with/slash");
      assert.equal(await headOf("mk", "from-sha"), seeded.commit);
    });

    it("reports an existing branch name as branch-exists and an invalid name before any request", async () => {
      await fx.seedRefs("owner", "dupe");
      const refs = refsFor("dupe");
      const error = await rejectsRepo(refs.createBranch("main", "dev"));
      assert.deepEqual([error.code, error.status], ["branch-exists", 409]);
      assert.equal((await rejectsRepo(refs.createBranch("bad..name", "main"))).code, "invalid-argument");
    });

    it("does not create a branch from a ref that does not exist", async () => {
      await fx.seedRefs("owner", "nosrc");
      const refs = refsFor("nosrc");
      await rejectsRepo(refs.createBranch("ghost-child", "no-such-ref"));
      assert.equal(await refs.branchHead("ghost-child"), undefined);
    });

    it("reads the branch head, undefined once the branch is deleted, and the default branch", async () => {
      const seeded = await fx.seedRefs("owner", "head");
      const refs = refsFor("head");
      assert.equal(await refs.branchHead("main"), seeded.head);
      assert.equal(await refs.branchHead("feature/x-y"), seeded.commit);
      await fx.apiOk(OWNER, "DELETE", "/repos/owner/head/branches/dev");
      assert.equal(await refs.branchHead("dev"), undefined);
      assert.equal(await refs.defaultBranch(), "main");
    });

    it("counts the commits the head has beyond a base", async () => {
      const base = await freshRepo("cmp");
      await fx.commitFiles("owner", "cmp", "main", "one", [{ operation: "create", path: "c1.txt", content: "1" }]);
      const head = await fx.commitFiles("owner", "cmp", "main", "two", [{ operation: "create", path: "c2.txt", content: "2" }]);
      const refs = refsFor("cmp");
      assert.deepEqual(await refs.compare(base, head), { ahead: 2 });
      assert.deepEqual(await refs.compare(head, head), { ahead: 0 });
      assert.deepEqual(await refs.compare("0".repeat(40), head), { ahead: undefined });
    });
  });

  describe("commit to a new branch", () => {
    async function protectedRepo(name: string): Promise<string> {
      const base = await freshRepo(name);
      await fx.apiOk(OWNER, "PUT", `/repos/owner/${name}/collaborators/writer`, { permission: "write" });
      await fx.apiOk(OWNER, "POST", `/repos/owner/${name}/branch_protections`, { rule_name: "main", enable_push: false });
      return base;
    }

    it("is the only way to commit on a branch protected against pushes, and leaves that branch alone", async () => {
      const base = await protectedRepo("prot-nb");
      const session = await open("prot-nb", "main", "writer");
      assert.deepEqual([session.state.canWrite, session.state.canBranch], [false, true]);
      await session.overlay.writeFile("a.txt", enc.encode("edited"), WRITE);
      await session.overlay.writeFile("new.txt", enc.encode("new"), WRITE);

      await rejectsOverlay(session.commit("direct"), "Protected");
      assert.equal(session.overlay.size, 2, "changes survive the refusal");
      assert.equal(await headOf("prot-nb", "main"), base);

      const result = await session.commit("Fix things\n\nDetails.", { newBranch: "fix-1" });
      assert.equal(result.branch, "fix-1");
      assert.equal(result.changes, 2);
      assert.equal(await headOf("prot-nb", "main"), base, "protected branch untouched");
      assert.equal(await headOf("prot-nb", "fix-1"), result.sha);
      assert.equal(await fileAt("prot-nb", "fix-1", "a.txt"), "edited");
      assert.equal(await fileAt("prot-nb", "fix-1", "new.txt"), "new");
      assert.equal(await fileAt("prot-nb", "main", "new.txt"), undefined);
      const commit = await fx.apiOk(OWNER, "GET", `/repos/owner/prot-nb/git/commits/${result.sha}`);
      assert.deepEqual(commit.parents.map((p: { sha: string }) => p.sha), [base], "exactly one new commit on the old head");
      assert.equal(commit.commit.message.trim(), "Fix things\n\nDetails.");
      assert.equal(session.overlay.size, 0);
      assert.equal(session.baseCommit, base, "the opened branch did not move");
    });

    it("refuses an existing branch name with branch-exists and keeps the local changes", async () => {
      await protectedRepo("prot-dup");
      await fx.apiOk(OWNER, "POST", "/repos/owner/prot-dup/branches", { new_branch_name: "taken", old_ref_name: "main" });
      const session = await open("prot-dup", "main", "writer");
      await session.overlay.writeFile("a.txt", enc.encode("edited"), WRITE);
      const error = await rejectsRepo(session.commit("m", { newBranch: "taken" }));
      assert.equal(error.code, "branch-exists");
      assert.equal(session.overlay.size, 1);
    });

    it("is refused for a user without write access to the repository", async () => {
      await protectedRepo("prot-reader");
      await fx.apiOk(OWNER, "PUT", "/repos/owner/prot-reader/collaborators/reader", { permission: "read" });
      const session = await open("prot-reader", "main", "reader");
      assert.equal(session.state.canBranch, false);
      await session.overlay.writeFile("a.txt", enc.encode("edited"), WRITE);
      await rejectsOverlay(session.commit("m", { newBranch: "nope" }), "ReadOnly");
      assert.equal(await refsFor("prot-reader", "reader").branchHead("nope"), undefined);
    });
  });

  describe("selective commit", () => {
    it("commits only the chosen paths and keeps the others pending on the new base", async () => {
      const base = await freshRepo("sel");
      const session = await open("sel");
      await session.overlay.writeFile("a.txt", enc.encode("alpha 2"), WRITE);
      await session.overlay.writeFile("b.txt", enc.encode("bravo 2"), WRITE);
      await session.overlay.writeFile("c.txt", enc.encode("charlie"), WRITE);

      const first = await session.commit("only a and c", { paths: ["a.txt", "c.txt"] });
      assert.equal(first.changes, 2);
      assert.equal(await fileAt("sel", "main", "a.txt"), "alpha 2");
      assert.equal(await fileAt("sel", "main", "c.txt"), "charlie");
      assert.equal(await fileAt("sel", "main", "b.txt"), "bravo", "unselected change is not committed");
      assert.equal(session.baseCommit, first.sha);
      assert.deepEqual(session.overlay.list().map((c) => [c.path, c.status]), [["b.txt", "modified"]]);
      assert.equal(dec.decode(await session.overlay.readFile("b.txt")), "bravo 2");

      const second = await session.commit("the rest");
      assert.equal(await fileAt("sel", "main", "b.txt"), "bravo 2");
      const commit = await fx.apiOk(OWNER, "GET", `/repos/owner/sel/git/commits/${second.sha}`);
      assert.deepEqual(commit.parents.map((p: { sha: string }) => p.sha), [first.sha]);
      assert.notEqual(first.sha, base);
    });

    it("commits a staged rename as one unit and leaves other edits pending", async () => {
      await freshRepo("sel-mv");
      const session = await open("sel-mv");
      await session.overlay.rename("a.txt", "moved.txt", { overwrite: false });
      await session.overlay.writeFile("b.txt", enc.encode("bravo 2"), WRITE);
      await session.commit("move", { paths: ["moved.txt"] });
      assert.equal(await fileAt("sel-mv", "main", "moved.txt"), "alpha");
      assert.equal(await fileAt("sel-mv", "main", "a.txt"), undefined);
      assert.equal(await fileAt("sel-mv", "main", "b.txt"), "bravo");
      assert.deepEqual(session.overlay.list().map((c) => c.path), ["b.txt"]);
    });

    it("is not blocked by a conflict in a change that is not selected", async () => {
      await freshRepo("sel-conflict");
      const session = await open("sel-conflict");
      await session.overlay.writeFile("a.txt", enc.encode("mine a"), WRITE);
      await session.overlay.writeFile("b.txt", enc.encode("mine b"), WRITE);
      await fx.commitFiles("owner", "sel-conflict", "main", "remote edit", [
        { operation: "update", path: "b.txt", content: "theirs b", sha: (await fx.apiOk(OWNER, "GET", "/repos/owner/sel-conflict/contents/b.txt")).sha },
      ]);
      await session.commit("a only", { paths: ["a.txt"] });
      assert.equal(await fileAt("sel-conflict", "main", "a.txt"), "mine a");
      assert.equal(await fileAt("sel-conflict", "main", "b.txt"), "theirs b");
      const conflict = await rejectsOverlay(session.commit("b too"), "Conflict");
      assert.deepEqual(conflict.conflicts.map((c) => c.path), ["b.txt"]);
    });
  });

  describe("create branch", () => {
    it("cuts the branch at the base commit and carries pending changes to it", async () => {
      const base = await freshRepo("mkbr");
      const storage = new MemoryOverlayStorage();
      const session = await open("mkbr", "main", "owner", storage);
      await session.overlay.writeFile("a.txt", enc.encode("work in progress"), WRITE);
      await fx.commitFiles("owner", "mkbr", "main", "later on main", [{ operation: "create", path: "later.txt", content: "x" }]);

      const created = await session.createBranch("topic");
      assert.equal(created.commit, base, "cut at the session base, not at the newer main head");
      assert.equal(session.overlay.size, 0);

      const topic = await open("mkbr", "topic", "owner", storage);
      assert.equal(topic.baseCommit, base);
      assert.deepEqual(topic.overlay.list().map((c) => [c.path, c.status]), [["a.txt", "modified"]]);
      const result = await topic.commit("wip");
      assert.equal(await headOf("mkbr", "topic"), result.sha);
      assert.equal(await fileAt("mkbr", "topic", "a.txt"), "work in progress");
    });

    it("keeps the pending changes where they are when the name is taken", async () => {
      await freshRepo("mkbr-dup");
      const session = await open("mkbr-dup");
      await session.overlay.writeFile("a.txt", enc.encode("wip"), WRITE);
      const error = await rejectsRepo(session.createBranch("main"));
      assert.equal(error.code, "branch-exists");
      assert.equal(session.overlay.size, 1);
    });
  });

  describe("remote changes", () => {
    it("sees a moved branch head, counts the new commits and updates through refresh", async () => {
      const base = await freshRepo("remote");
      const session = await open("remote");
      await session.overlay.writeFile("b.txt", enc.encode("local"), WRITE);
      assert.equal(await session.remoteHead(), base);
      await fx.commitFiles("owner", "remote", "main", "r1", [{ operation: "create", path: "r1.txt", content: "1" }]);
      const head = await fx.commitFiles("owner", "remote", "main", "r2", [{ operation: "create", path: "r2.txt", content: "2" }]);
      assert.equal(await session.remoteHead(), head);
      assert.equal(await session.countIncoming(head), 2);
      assert.equal(session.baseCommit, base, "checking does not move the session");

      const refreshed = await session.refresh();
      assert.equal(refreshed.moved, true);
      assert.equal(session.baseCommit, head);
      assert.equal(await session.remoteHead(), session.baseCommit);
      assert.equal(await session.countIncoming(head), 0);
      assert.deepEqual(session.overlay.list().map((c) => c.path), ["b.txt"], "local change kept");
    });
  });

  describe("pull requests", () => {
    it("creates one from the new branch, with title and body, and reports duplicates and identical branches", async () => {
      await freshRepo("pr");
      const session = await open("pr");
      await session.overlay.writeFile("a.txt", enc.encode("changed"), WRITE);
      const committed = await session.commit("Add a change\n\nBecause.", { newBranch: "pr-head" });
      const refs = refsFor("pr");

      const created = await refs.createPullRequest({ head: committed.branch, base: "main", title: "Add a change", body: "Because." });
      assert.equal(created.number, 1);
      assert.equal(created.url, `${fx.baseUrl}/owner/pr/pulls/1`);
      const pull = await fx.apiOk(OWNER, "GET", "/repos/owner/pr/pulls/1");
      assert.deepEqual([pull.title, pull.body, pull.head.ref, pull.base.ref], ["Add a change", "Because.", "pr-head", "main"]);

      const duplicate = await rejectsRepo(refs.createPullRequest({ head: "pr-head", base: "main", title: "again" }));
      assert.equal(duplicate.status, 409);
      const same = await rejectsRepo(refs.createPullRequest({ head: "main", base: "main", title: "same" }));
      assert.equal(same.status, 422);
    });
  });
});
