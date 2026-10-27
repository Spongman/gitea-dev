// Git LFS files, symlinks and submodules against a disposable Gitea v1.24.6 (see docs/testing.md).
// Expectations follow the Gitea API (swagger: GET /repos/{owner}/{repo}/media/{filepath}, ContentsResponse
// type symlink/submodule), the git tree modes (120000 symlink, 160000 gitlink), the Git LFS pointer spec
// and vscode.d.ts FileType, not the current implementation. Content is pushed with plain git over HTTP
// (the contents API cannot create symlinks or submodules); git-lfs is not on PATH, so LFS objects are
// uploaded through the LFS batch API and their pointer files are committed with git.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  HttpGiteaRepository,
  PersonalAccessTokenAuth,
  RepositoryError,
  type InitializableGiteaRepository,
} from "../../packages/gitea-repository/src/index.ts";
import { DEFAULT_ARCHIVE_SETTINGS } from "../../packages/gitea-vscode-web/src/archive-prefetch.ts";
import { ArchiveBackedRepository } from "../../packages/gitea-vscode-web/src/archive-reader.ts";
import { ArchiveStore } from "../../packages/gitea-vscode-web/src/archive-store.ts";
import { ChangeOverlay, OverlayError, type OverlayKey } from "../../packages/gitea-vscode-web/src/overlay.ts";
import { searchText, type EngineResult } from "../../packages/gitea-vscode-web/src/search-engine.ts";
import { MemoryOverlayStorage } from "../../packages/gitea-vscode-web/src/storage.ts";
import { GiteaFixture, startGitea } from "../helpers/gitea.ts";
import { SPECIAL_LFS_OBJECT as OBJECT, SPECIAL_SUBMODULE_COMMIT as SUBMODULE_COMMIT, lfsPointerFor, pushSpecialFiles, pushWithGit } from "../helpers/git-push.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const WRITE = { create: true, overwrite: true };

const blobSha = (data: Uint8Array) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

interface Tree {
  tree: Array<{ path: string; mode: string; type: string; size: number; sha: string }>;
}

let fx: GiteaFixture;
let head: string;
let pointers: { data: string; large: string; missing: string };

function auth() {
  return new PersonalAccessTokenAuth(fx.token("owner"));
}

function countingFetch(log: string[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    log.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return fetch(input, init);
  }) as typeof fetch;
}

function blobRepo(repository: string, ref: string, log: string[], maxFileSize?: number) {
  return new HttpGiteaRepository({ instance: fx.baseUrl, owner: "owner", repository, ref, auth: auth(), fetch: countingFetch(log), maxFileSize });
}

async function archiveRepo(repository: string, ref: string, log: string[], maxFileSize?: number) {
  const store = new ArchiveStore(new IDBFactory(), { keyRange: IDBKeyRange });
  const repo = new ArchiveBackedRepository(
    { instance: fx.baseUrl, owner: "owner", repository, ref, auth: auth(), fetch: countingFetch(log), maxFileSize },
    { store, settings: () => ({ ...DEFAULT_ARCHIVE_SETTINGS, prefetch: "onOpen" as const }) },
  );
  await repo.initialize();
  await repo.archive.attach();
  await repo.archive.settled();
  assert.equal(repo.archive.state.kind, "ready", JSON.stringify(repo.archive.state));
  return repo;
}

async function overlayOn(repo: InitializableGiteaRepository, commit: string) {
  const key: OverlayKey = { instance: fx.baseUrl, owner: "owner", repository: "special", ref: "main", baseCommit: commit };
  return ChangeOverlay.open({ key, storage: new MemoryOverlayStorage(), base: repo });
}

async function rejects(promise: Promise<unknown>, code: RepositoryError["code"]) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function overlayRejects(promise: Promise<unknown>, code: OverlayError["code"]): Promise<OverlayError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OverlayError, `expected OverlayError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function search(repo: InitializableGiteaRepository, commit: string, pattern: string) {
  const overlay = await overlayOn(repo, commit);
  const results: EngineResult[] = [];
  const summary = await searchText(overlay, { query: { pattern }, root: "", maxResults: 1000, isCancelled: () => false, onResult: (r) => results.push(r) });
  return { paths: [...new Set(results.map((r) => r.path))], summary };
}

describe("LFS files, symlinks and submodules against Gitea (LFS server on)", () => {
  before(async () => {
    fx = await startGitea({ lfs: true });
    await fx.createRepo("owner", "special");
    ({ head, pointers } = await pushSpecialFiles(fx, "owner", "special"));
    await fx.apiOk({ name: "owner" }, "POST", "/repos/owner/special/branches", { new_branch_name: "edit", old_ref_name: "main" });
    await fx.apiOk({ name: "owner" }, "POST", "/repos/owner/special/branches", { new_branch_name: "rewrap", old_ref_name: "main" });
  });
  after(async () => fx?.stop());

  it("creates the entries the rest of the suite relies on, with the git modes", async () => {
    const tree = await fx.apiOk<Tree>({ name: "owner" }, "GET", `/repos/owner/special/git/trees/${head}?recursive=true&per_page=100`);
    const modes = Object.fromEntries(tree.tree.map((e) => [e.path, `${e.mode} ${e.type}`]));
    assert.equal(modes["link-file"], "120000 blob");
    assert.equal(modes["link-dir"], "120000 blob");
    assert.equal(modes["link-dangling"], "120000 blob");
    assert.equal(modes["sub"], "160000 commit");
    assert.equal(modes["data.bin"], "100644 blob");
    const media = await fetch(`${fx.baseUrl}/api/v1/repos/owner/special/media/data.bin?ref=${head}`, { headers: { authorization: `token ${fx.token("owner")}` } });
    assert.equal(await media.text(), OBJECT, "Gitea's media endpoint serves the LFS object");
  });

  for (const label of ["per-blob path", "archive path"] as const) {
    describe(label, () => {
      async function repo(log: string[], maxFileSize?: number): Promise<InitializableGiteaRepository> {
        if (label === "archive path") {
          return archiveRepo("special", head, log, maxFileSize);
        }
        const blob = blobRepo("special", head, log, maxFileSize);
        await blob.initialize();
        return blob;
      }

      describe("Git LFS", () => {
        it("reads the LFS object, not the pointer", async () => {
          const log: string[] = [];
          const r = await repo(log);
          const file = await r.readFile("data.bin");
          assert.equal(dec.decode(file.content), OBJECT);
          assert.deepEqual(file.lfs, { oid: createHash("sha256").update(OBJECT).digest("hex"), size: OBJECT.length, resolved: true });
          assert.equal(file.entry.sha, blobSha(enc.encode(pointers.data)), "the tree entry stays the pointer blob");
          assert.ok(log.some((line) => line.startsWith("GET ") && line.includes("/media/data.bin?ref=")), log.join("\n"));
        });

        it("returns the pointer as stored when asked, with no media request", async () => {
          const log: string[] = [];
          const r = await repo(log);
          log.length = 0;
          const file = await r.readFile("data.bin", { lfs: "pointer" });
          assert.equal(dec.decode(file.content), pointers.data);
          assert.equal(file.lfs?.resolved, false);
          assert.equal(log.filter((line) => line.includes("/media/")).length, 0);
        });

        it("keeps the pointer, marked unresolved, for an object the server never received", async () => {
          const r = await repo([]);
          const file = await r.readFile("missing.bin");
          assert.equal(dec.decode(file.content), pointers.missing);
          assert.equal(file.lfs?.resolved, false);
        });

        it("refuses an object over maxFileSize without downloading it", async () => {
          const log: string[] = [];
          const r = await repo(log, 200);
          assert.equal((await r.readFile("data.bin")).lfs?.resolved, true, "an object within the limit is read");
          log.length = 0;
          await rejects(r.readFile("large.bin"), "file-too-large");
          assert.equal(log.filter((line) => line.includes("/media/")).length, 0);
        });

        it("shows in the overlay as a read-only file with the real content and refuses edits", async () => {
          const r = await repo([]);
          const overlay = await overlayOn(r, head);
          assert.equal(dec.decode(await overlay.readFile("data.bin")), OBJECT);
          const stat = await overlay.stat("data.bin");
          assert.deepEqual([stat.type, stat.readonly], ["file", true]);
          assert.equal((await overlay.stat("docs/notes.txt")).readonly, false);
          const edit = await overlayRejects(overlay.writeFile("data.bin", enc.encode("x"), WRITE), "ReadOnly");
          assert.match(edit.message, /Git LFS/);
          await overlayRejects(overlay.rename("data.bin", "moved.bin", { overwrite: false }), "ReadOnly");
          assert.deepEqual(overlay.list(), []);
        });

        it("is not searched: no download, no match on the object or the pointer, and a warning", async () => {
          const log: string[] = [];
          const r = await repo(log);
          log.length = 0;
          const found = await search(r, head, "needle");
          assert.deepEqual(found.paths, ["docs/notes.txt"]);
          assert.deepEqual(found.summary.warnings, ["3 Git LFS file(s) were not searched; LFS objects are not downloaded for search."]);
          assert.equal(log.filter((line) => line.includes("/media/")).length, 0);
          assert.deepEqual((await search(r, head, "oid sha256")).paths, []);
        });
      });

      describe("symlinks", () => {
        it("lists links as symlinks with the target path text as size and content, unfollowed", async () => {
          const r = await repo([]);
          const entries = new Map((await r.readDirectory("")).map((e) => [e.name, e]));
          for (const [name, target] of [["link-file", "docs/notes.txt"], ["link-dir", "docs"], ["link-dangling", "nowhere/missing"], ["link-escape", "../../etc/passwd"]] as const) {
            assert.equal(entries.get(name)?.type, "symlink", name);
            assert.equal(entries.get(name)?.size, target.length, name);
            const file = await r.readFile(name);
            assert.equal(dec.decode(file.content), target, name);
            assert.equal(file.entry.type, "symlink");
            assert.equal(file.lfs, undefined);
          }
        });

        it("follows links inside the repository in the overlay, with the target's type", async () => {
          const r = await repo([]);
          const overlay = await overlayOn(r, head);
          const file = await overlay.stat("link-file");
          assert.deepEqual([file.type, file.target, file.size, file.readonly], ["symlink", "file", "plain needle\n".length, true]);
          const dir = await overlay.stat("link-dir");
          assert.deepEqual([dir.type, dir.target, dir.readonly], ["symlink", "directory", true]);
          assert.equal(dec.decode(await overlay.readFile("link-file")), "plain needle\n");
          assert.deepEqual((await overlay.readDirectory("link-dir")).map((i) => i.name), ["notes.txt", "up"]);
          assert.equal(dec.decode(await overlay.readFile("link-dir/notes.txt")), "plain needle\n");
          assert.equal((await overlay.stat("docs/up")).target, "file", "a relative link climbs inside the repository");
          assert.equal((await overlay.readDirectory("")).find((i) => i.name === "link-dir")?.target, "directory");
        });

        it("never resolves a link outside the repository, and a dangling link does not crash", async () => {
          const log: string[] = [];
          const r = await repo(log);
          const overlay = await overlayOn(r, head);
          log.length = 0;
          for (const name of ["link-dangling", "link-escape", "link-abs"]) {
            const stat = await overlay.stat(name);
            assert.deepEqual([stat.type, stat.target, stat.readonly], ["symlink", undefined, true], name);
            await overlayRejects(overlay.readFile(name), "BrokenLink");
            await overlayRejects(overlay.readDirectory(name), "BrokenLink");
          }
          await overlayRejects(overlay.readFile("link-dangling/child"), "BrokenLink");
          assert.deepEqual(log.filter((line) => /passwd|etc|\.\.|%2e/i.test(line)), [], "no request leaves the repository");
          assert.ok((await overlay.readDirectory("")).some((i) => i.name === "link-escape"), "the root still lists");
        });

        it("is skipped by search, so a linked file is found once", async () => {
          const r = await repo([]);
          assert.deepEqual((await search(r, head, "plain needle")).paths, ["docs/notes.txt"]);
        });

        it("is read-only in the overlay, so a commit cannot turn it into a regular file", async () => {
          const r = await repo([]);
          const overlay = await overlayOn(r, head);
          await overlayRejects(overlay.writeFile("link-file", enc.encode("x"), WRITE), "ReadOnly");
          await overlayRejects(overlay.writeFile("link-dir/new.txt", enc.encode("x"), WRITE), "ReadOnly");
          await overlayRejects(overlay.writeFile("link-dir/notes.txt", enc.encode("x"), WRITE), "ReadOnly");
          await overlayRejects(overlay.delete("link-file", { recursive: false }), "ReadOnly");
          assert.deepEqual(overlay.list(), []);
        });
      });

      describe("submodules", () => {
        it("is a submodule entry at its target commit, with size 0", async () => {
          const r = await repo([]);
          const entry = await r.getEntry("sub");
          assert.deepEqual([entry.type, entry.sha, entry.size], ["submodule", SUBMODULE_COMMIT, 0]);
          assert.equal((await r.readDirectory("")).find((e) => e.name === "sub")?.type, "submodule");
          assert.equal((await r.readTree?.(""))?.find((e) => e.path === "sub")?.type, "submodule");
        });

        it("reads with a clear error naming the commit, without a blob request", async () => {
          const log: string[] = [];
          const r = await repo(log);
          log.length = 0;
          await assert.rejects(r.readFile("sub"), (error: unknown) => {
            assert.ok(error instanceof RepositoryError);
            assert.equal(error.code, "unsupported");
            assert.match(error.message, new RegExp(SUBMODULE_COMMIT));
            return true;
          });
          assert.equal(log.filter((line) => line.includes("/git/blobs/")).length, 0);
        });

        it("is a read-only non-file in the overlay and is skipped by search", async () => {
          const r = await repo([]);
          const overlay = await overlayOn(r, head);
          const stat = await overlay.stat("sub");
          assert.deepEqual([stat.type, stat.readonly, stat.size], ["submodule", true, 0]);
          const error = await overlayRejects(overlay.readFile("sub"), "Unsupported");
          assert.match(error.message, new RegExp(SUBMODULE_COMMIT));
          await overlayRejects(overlay.readDirectory("sub"), "NotDirectory");
          await overlayRejects(overlay.writeFile("sub/file.txt", enc.encode("x"), WRITE), "NotDirectory");
          await overlayRejects(overlay.delete("sub", { recursive: true }), "ReadOnly");
          assert.deepEqual((await search(r, head, "needle")).paths, ["docs/notes.txt"]);
        });
      });
    });
  }

  describe("archive", () => {
    it("holds LFS pointers as stored, symlinks as links and a submodule as an empty directory", async () => {
      const { parseTar } = await import("../../packages/gitea-repository/src/tar.ts");
      const res = await fetch(`${fx.baseUrl}/api/v1/repos/owner/special/archive/${head}.tar.gz`, { headers: { authorization: `token ${fx.token("owner")}` } });
      const body = new Blob([new Uint8Array(await res.arrayBuffer())]).stream().pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      const entries = new Map<string, { type: string; text: string }>();
      for await (const entry of parseTar(body)) {
        entries.set(entry.path.replace(/\/$/, ""), { type: entry.type, text: entry.type === "symlink" ? (entry.linkpath ?? "") : entry.content === undefined ? "" : dec.decode(entry.content) });
      }
      assert.deepEqual(entries.get("special/data.bin"), { type: "file", text: pointers.data });
      assert.deepEqual(entries.get("special/link-file"), { type: "symlink", text: "docs/notes.txt" });
      assert.deepEqual(entries.get("special/link-escape"), { type: "symlink", text: "../../etc/passwd" });
      // git archive writes a submodule as an empty directory; the prefetcher stores regular files only.
      assert.deepEqual(entries.get("special/sub"), { type: "directory", text: "" });
      assert.deepEqual([...entries.keys()].filter((key) => key.startsWith("special/sub/")), []);
    });

    it("serves ordinary files with no blob request once ready, and reads links and LFS files like the blob path", async () => {
      const log: string[] = [];
      const archived = await archiveRepo("special", head, log);
      const blob = blobRepo("special", head, []);
      await blob.initialize();
      log.length = 0;
      assert.equal((await archived.readFile("docs/notes.txt")).lfs, undefined);
      assert.equal(log.filter((line) => line.includes("/git/blobs/")).length, 0);
      for (const name of ["data.bin", "missing.bin", "link-file", "link-escape", "docs/notes.txt", ".gitattributes"]) {
        const [a, b] = [await archived.readFile(name), await blob.readFile(name)];
        assert.deepEqual([...a.content], [...b.content], name);
        assert.deepEqual([a.entry, a.lfs], [b.entry, b.lfs], name);
      }
    });
  });

  describe("commits", () => {
    it("keep symlinks, submodules and LFS pointers when another file changes", async () => {
      const r = new HttpGiteaRepository({ instance: fx.baseUrl, owner: "owner", repository: "special", ref: "edit", auth: auth() });
      const state = await r.initialize();
      const overlay = await overlayOn(r, state.commit);
      await overlay.writeFile("docs/notes.txt", enc.encode("edited needle\n"), WRITE);
      const result = await overlay.commit({
        head: r,
        headCommit: state.commit,
        submit: async (request) => {
          const { sha } = await r.commit({ message: "edit notes", baseCommit: request.baseCommit, changes: request.changes });
          await r.refresh(sha);
          return { sha };
        },
      });
      const before = await fx.apiOk<Tree>({ name: "owner" }, "GET", `/repos/owner/special/git/trees/${head}?recursive=true&per_page=100`);
      const after = await fx.apiOk<Tree>({ name: "owner" }, "GET", `/repos/owner/special/git/trees/${result.sha}?recursive=true&per_page=100`);
      const changed = after.tree.filter((e) => before.tree.find((b) => b.path === e.path)?.sha !== e.sha).map((e) => e.path);
      assert.deepEqual(changed.filter((p) => !["docs", "docs/notes.txt"].includes(p)), []);
      assert.deepEqual(after.tree.filter((e) => e.mode === "120000").map((e) => e.path).sort(), before.tree.filter((e) => e.mode === "120000").map((e) => e.path).sort());
      assert.equal(after.tree.find((e) => e.path === "sub")?.sha, SUBMODULE_COMMIT);
      assert.equal(after.tree.find((e) => e.path === "sub")?.mode, "160000");
    });

    it("are refused by the server for an update of a symlink, which stays a symlink", async () => {
      const r = new HttpGiteaRepository({ instance: fx.baseUrl, owner: "owner", repository: "special", ref: "edit", auth: auth() });
      const state = await r.initialize();
      const link = await r.getEntry("link-file");
      await assert.rejects(r.commit({ message: "touch link", baseCommit: state.commit, changes: [{ type: "update", path: "link-file", content: enc.encode("plain"), originalSha: link.sha }] }));
      const tree = await fx.apiOk<Tree>({ name: "owner" }, "GET", `/repos/owner/special/git/trees/edit?recursive=true&per_page=100`);
      assert.equal(tree.tree.find((e) => e.path === "link-file")?.mode, "120000");
    });

    it("show why LFS files are read-only here: the contents API re-wraps content only because .gitattributes and the LFS server say so", async () => {
      // Characterization of Gitea 1.24.6, not a desired property of this editor.
      const entry = (await fx.apiOk<Tree>({ name: "owner" }, "GET", `/repos/owner/special/git/trees/rewrap?recursive=true&per_page=100`)).tree.find((e) => e.path === "data.bin");
      await fx.apiOk({ name: "owner" }, "POST", "/repos/owner/special/contents", {
        message: "edit lfs through the contents API",
        branch: "rewrap",
        files: [{ operation: "update", path: "data.bin", sha: entry?.sha, content: Buffer.from("edited lfs content\n").toString("base64") }],
      });
      const get = async (kind: "raw" | "media") => (await fetch(`${fx.baseUrl}/api/v1/repos/owner/special/${kind}/data.bin?ref=rewrap`, { headers: { authorization: `token ${fx.token("owner")}` } })).text();
      assert.equal(await get("raw"), lfsPointerFor(enc.encode("edited lfs content\n")).pointer);
      assert.equal(await get("media"), "edited lfs content\n");
    });
  });
});

describe("LFS files against Gitea with its LFS server off", () => {
  let off: GiteaFixture;
  let offHead: string;
  const pointer = lfsPointerFor(enc.encode("held elsewhere\n"));

  before(async () => {
    off = await startGitea();
    await off.createRepo("owner", "ptr");
    offHead = await pushWithGit(off, "owner", "ptr", "pointer", (git) => {
      writeFileSync(path.join(git.dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      writeFileSync(path.join(git.dir, "data.bin"), pointer.pointer);
    });
  });
  after(async () => off?.stop());

  it("reads the pointer, marked unresolved, because the media endpoint answers with it", async () => {
    const r = new HttpGiteaRepository({ instance: off.baseUrl, owner: "owner", repository: "ptr", ref: offHead, auth: new PersonalAccessTokenAuth(off.token("owner")) });
    await r.initialize();
    const file = await r.readFile("data.bin");
    assert.equal(dec.decode(file.content), pointer.pointer);
    assert.deepEqual(file.lfs, { oid: pointer.oid, size: pointer.size, resolved: false });
  });

  it("is still read-only in the overlay, because Gitea would replace the pointer with the raw content", async () => {
    const r = new HttpGiteaRepository({ instance: off.baseUrl, owner: "owner", repository: "ptr", ref: offHead, auth: new PersonalAccessTokenAuth(off.token("owner")) });
    await r.initialize();
    const key: OverlayKey = { instance: off.baseUrl, owner: "owner", repository: "ptr", ref: "main", baseCommit: offHead };
    const overlay = await ChangeOverlay.open({ key, storage: new MemoryOverlayStorage(), base: r });
    assert.equal((await overlay.stat("data.bin")).readonly, true);
    await overlayRejects(overlay.writeFile("data.bin", enc.encode("x"), WRITE), "ReadOnly");
    // Characterization of Gitea 1.24.6: with LFS off the contents API stores the raw bytes.
    const entry = await r.getEntry("data.bin");
    await off.apiOk({ name: "owner" }, "POST", "/repos/owner/ptr/contents", {
      message: "raw",
      branch: "main",
      files: [{ operation: "update", path: "data.bin", sha: entry.sha, content: Buffer.from("raw bytes\n").toString("base64") }],
    });
    const raw = await fetch(`${off.baseUrl}/api/v1/repos/owner/ptr/raw/data.bin?ref=main`, { headers: { authorization: `token ${off.token("owner")}` } });
    assert.equal(await raw.text(), "raw bytes\n");
  });
});
