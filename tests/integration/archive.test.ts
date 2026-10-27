// Recursive trees and archive prefetch against a disposable Gitea v1.24.6 (see docs/testing.md).
// Expectations follow the Gitea API (swagger: recursive, page, per_page, truncated; archive/{commit}.tar.gz)
// and POSIX tar, not the current implementation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  HttpGiteaRepository,
  PersonalAccessTokenAuth,
  RepositoryError,
  type RepositoryEntry,
} from "../../packages/gitea-repository/src/index.ts";
import { DEFAULT_LIMITS, GiteaHttp } from "../../packages/gitea-repository/src/http.ts";
import { parseTar } from "../../packages/gitea-repository/src/tar.ts";
import { ArchiveBackedRepository } from "../../packages/gitea-vscode-web/src/archive-reader.ts";
import { DEFAULT_ARCHIVE_SETTINGS } from "../../packages/gitea-vscode-web/src/archive-prefetch.ts";
import { ArchiveStore } from "../../packages/gitea-vscode-web/src/archive-store.ts";
import { GiteaFixture, startGitea } from "../helpers/gitea.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

let fx: GiteaFixture;
let pubHead: string;
let manyHead: string;
const manyFiles = new Map<string, string>();

const blobSha = (data: Uint8Array) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const LONG = `${"deep-directory-name/".repeat(6)}file-with-a-long-path.txt`;

const PUB_FILES: Record<string, string | Uint8Array> = {
  "NOTES.md": "# demo\nneedle\n",
  "src/main.ts": "export const needle = 1;\n",
  "src/nested/util.ts": "export const util = 2;\n",
  "docs/caf\u00e9 menu.txt": "unicode name\n",
  [LONG]: "long path\n",
  "bin/blob.dat": new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13]),
  "empty.txt": "",
  "ignored.txt": "left out of archives by export-ignore\n",
  "eol.txt": "line one\nline two\n",
  ".gitattributes": "ignored.txt export-ignore\neol.txt text eol=crlf\n",
};

function countingFetch(log: string[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    log.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return fetch(input, init);
  }) as typeof fetch;
}

function auth(who: "owner" | "readonly" | "bogus" | "anon") {
  if (who === "anon") return undefined;
  if (who === "bogus") return new PersonalAccessTokenAuth("0".repeat(40));
  return new PersonalAccessTokenAuth(fx.token("owner", who === "readonly" ? "readonly" : "full"));
}

function http(who: "owner" | "readonly" | "bogus" | "anon") {
  return new GiteaHttp(`${fx.baseUrl}/api/v1`, fetch, auth(who), DEFAULT_LIMITS);
}

function archivePath(repo: string, commit: string) {
  return `/repos/owner/${repo}/archive/${commit}.tar.gz`;
}

async function rawArchive(who: "owner" | "readonly" | "bogus" | "anon", repo: string, commit: string, startTimeoutMs = 60_000): Promise<Uint8Array> {
  const stream = await http(who).stream({ path: archivePath(repo, commit), maxBytes: 64 * 1024 * 1024, idleTimeoutMs: 20_000, startTimeoutMs });
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function gunzipped(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

async function rejectsWith(promise: Promise<unknown>, code: RepositoryError["code"], status?: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RepositoryError, `expected RepositoryError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (status !== undefined) assert.equal(error.status, status);
    return;
  }
  assert.fail("expected rejection");
}

function open(repository: string, ref: string, who: "owner" | "anon" = "owner", log: string[] = []) {
  return new HttpGiteaRepository({ instance: fx.baseUrl, owner: "owner", repository, ref, auth: auth(who), fetch: countingFetch(log) });
}

describe("recursive trees and archives against Gitea", () => {
  before(async () => {
    fx = await startGitea();
    await fx.createRepo("owner", "pub");
    pubHead = await fx.commitFiles(
      "owner",
      "pub",
      "main",
      "seed",
      Object.entries(PUB_FILES).map(([path, content]) => ({ operation: "create" as const, path, content })),
    );
    await fx.createRepo("owner", "priv", { private: true });
    await fx.commitFiles("owner", "priv", "main", "seed", [{ operation: "create", path: "secret.txt", content: "secret\n" }]);

    await fx.createRepo("owner", "many");
    const names: string[] = [];
    for (let i = 0; i < 1300; i++) {
      const name = `d${i % 13}/g${i % 7}/f${i}.txt`;
      manyFiles.set(name, `file ${i}\n`);
      names.push(name);
    }
    for (let at = 0; at < names.length; at += 325) {
      manyHead = await fx.commitFiles(
        "owner",
        "many",
        "main",
        `batch ${at}`,
        names.slice(at, at + 325).map((path) => ({ operation: "create" as const, path, content: manyFiles.get(path) })),
      );
    }
  });
  after(async () => fx?.stop());

  describe("recursive tree", () => {
    it("lists a repository larger than one tree page with correct shas and sizes", async () => {
      const log: string[] = [];
      const repo = open("many", "main", "owner", log);
      await repo.initialize();
      log.length = 0;
      const entries = await repo.readTree("");
      const trees = log.filter((line) => line.includes("/git/trees/"));
      assert.ok(trees.length >= 2, `expected at least two pages, saw ${trees.join(" | ")}`);
      assert.ok(trees.every((line) => line.includes("recursive=true")));
      assert.deepEqual(
        trees.map((line) => new URL(`http://x${line.split(" ")[1]}`).searchParams.get("page")),
        trees.map((_, i) => String(i + 1)),
      );

      const files = entries.filter((e) => e.type === "file");
      assert.equal(files.length, 1300 + 1, "1300 generated files plus the README from auto_init");
      for (const file of files) {
        const content = manyFiles.get(file.path);
        if (content === undefined) continue;
        assert.equal(file.size, content.length, file.path);
        assert.equal(file.sha, blobSha(enc.encode(content)), file.path);
      }
      assert.equal(new Set(entries.map((e) => e.path)).size, entries.length, "no entry is repeated across pages");
      const dirs = entries.filter((e) => e.type === "directory").map((e) => e.path);
      assert.ok(dirs.includes("d0") && dirs.includes("d12/g6"));
    });

    it("reports truncated=true on a non-final page, which is not an error (swagger: more pages follow)", async () => {
      const head = await fx.apiOk<{ commit: { tree: { sha: string } } }>(null, "GET", `/repos/owner/many/git/commits/${manyHead}`);
      const page1 = await fx.apiOk<{ truncated: boolean; total_count: number; tree: unknown[] }>(null, "GET", `/repos/owner/many/git/trees/${head.commit.tree.sha}?recursive=true&page=1&per_page=50`);
      const last = await fx.apiOk<{ truncated: boolean }>(null, "GET", `/repos/owner/many/git/trees/${head.commit.tree.sha}?recursive=true&page=${Math.ceil(page1.total_count / 50)}&per_page=50`);
      assert.equal(page1.tree.length, 50);
      assert.equal(page1.truncated, true);
      assert.equal(last.truncated, false);
    });

    it("fills the directory cache: later directory reads send no request and match per-directory reads", async () => {
      const log: string[] = [];
      const repo = open("many", "main", "owner", log);
      await repo.initialize();
      await repo.readTree("");
      log.length = 0;
      const viaTree = {
        root: await repo.readDirectory(""),
        d3: await repo.readDirectory("d3"),
        leaf: await repo.readDirectory("d3/g3"),
      };
      assert.deepEqual(log, []);
      const plain = open("many", "main");
      await plain.initialize();
      assert.deepEqual(viaTree.root, await plain.readDirectory(""));
      assert.deepEqual(viaTree.d3, await plain.readDirectory("d3"));
      assert.deepEqual(viaTree.leaf, await plain.readDirectory("d3/g3"));
    });

    it("lists a subdirectory with repository-relative paths", async () => {
      const repo = open("pub", "main");
      await repo.initialize();
      const paths = (await repo.readTree("src")).map((e: RepositoryEntry) => e.path);
      assert.deepEqual(paths, ["src/main.ts", "src/nested", "src/nested/util.ts"]);
    });
  });

  describe("archive endpoint", () => {
    it("serves a gzip tar by commit id whose entries are prefixed with the repository name", async () => {
      const bytes = await rawArchive("anon", "pub", pubHead);
      assert.deepEqual([...bytes.slice(0, 3)], [0x1f, 0x8b, 0x08]);
      const entries: Array<{ path: string; type: string; content?: Uint8Array }> = [];
      for await (const entry of parseTar(gunzipped(bytes))) {
        entries.push(entry);
      }
      assert.equal(entries[0].path, "pub/");
      assert.equal(entries[0].type, "directory");
      assert.ok(entries.every((e) => e.path === "pub/" || e.path.startsWith("pub/")));
      assert.ok(entries.some((e) => e.type === "directory" && e.path === "pub/src/nested/"));
    });

    it("contains every file of the recursive tree except export-ignore ones, with blob-identical bytes unless eol conversion applies", async () => {
      const repo = open("pub", "main");
      await repo.initialize();
      const tree = (await repo.readTree("")).filter((e) => e.type === "file");
      const byPath = new Map(tree.map((e) => [e.path, e]));
      const archive = new Map<string, Uint8Array>();
      for await (const entry of parseTar(gunzipped(await rawArchive("owner", "pub", pubHead)))) {
        if (entry.type === "file") archive.set(entry.path.slice("pub/".length), entry.content as Uint8Array);
      }
      const missing = [...byPath.keys()].filter((p) => !archive.has(p)).sort();
      const extra = [...archive.keys()].filter((p) => !byPath.has(p));
      assert.deepEqual(extra, []);
      assert.deepEqual(missing, ["ignored.txt"], "export-ignore omits exactly that file");
      const rewritten = [...archive].filter(([path, content]) => blobSha(content) !== byPath.get(path)?.sha).map(([path]) => path);
      assert.deepEqual(rewritten, ["eol.txt"], "only the eol=crlf file differs from its blob");
      for (const [path, content] of archive) {
        if (path === "eol.txt" || path === "README.md") continue;
        const expected = PUB_FILES[path];
        assert.deepEqual(content, typeof expected === "string" ? enc.encode(expected) : expected, path);
      }
    });

    it("answers a private repository with the token but 404 anonymously", async () => {
      const head = await fx.apiOk<{ commit: { id: string } }>({ name: "owner" }, "GET", "/repos/owner/priv/branches/main");
      const withToken = await rawArchive("owner", "priv", head.commit.id);
      assert.deepEqual([...withToken.slice(0, 2)], [0x1f, 0x8b]);
      assert.ok((await rawArchive("readonly", "priv", head.commit.id)).length > 0, "a read-only token can download");
      await rejectsWith(rawArchive("anon", "priv", head.commit.id), "not-found", 404);
      await rejectsWith(rawArchive("bogus", "priv", head.commit.id), "unauthenticated", 401);
    });

    // Disabled: swagger GET /repos/{owner}/{repo}/archive/{archive} documents 404, but Gitea 1.24.6 sends no response within 5 s (28.2.0 answers 404 in 7 ms).
    it.skip("answers 404 for a commit that does not exist", async () => {
      await rejectsWith(rawArchive("anon", "pub", "0".repeat(40), 5_000), "not-found", 404);
    });
  });

  describe("archive prefetch end to end", () => {
    const settings = () => ({ ...DEFAULT_ARCHIVE_SETTINGS, prefetch: "onOpen" as const });

    const archiveNotes: string[] = [];

    async function session(repository: string, log: string[], factory: IDBFactory) {
      const store = new ArchiveStore(factory, { keyRange: IDBKeyRange });
      const repo = new ArchiveBackedRepository(
        { instance: fx.baseUrl, owner: "owner", repository, ref: "main", auth: auth("owner"), fetch: countingFetch(log) },
        { store, settings, log: (message) => archiveNotes.push(message) },
      );
      await repo.initialize();
      await repo.archive.attach();
      await repo.archive.settled();
      return repo;
    }

    it("reads every file with zero git/blobs requests once complete, and a reload makes zero archive requests", async () => {
      const factory = new IDBFactory();
      const log: string[] = [];
      const repo = await session("many", log, factory);
      assert.equal(repo.archive.state.kind, "ready", JSON.stringify(repo.archive.state));
      assert.equal(log.filter((line) => line.includes("/archive/")).length, 1);
      assert.ok(log.some((line) => line.includes(`/archive/${manyHead}.tar.gz`)));

      log.length = 0;
      for (const [path, content] of manyFiles) {
        assert.equal(dec.decode((await repo.readFile(path)).content), content, path);
      }
      assert.deepEqual(log.filter((line) => line.includes("/git/blobs/") || line.includes("/raw/")), []);

      const reloadLog: string[] = [];
      const reloaded = await session("many", reloadLog, factory);
      assert.equal(reloaded.archive.state.kind, "ready");
      assert.equal(reloadLog.filter((line) => line.includes("/archive/")).length, 0);
      assert.equal(dec.decode((await reloaded.readFile("d1/g1/f1.txt")).content), "file 1\n");
      assert.deepEqual(reloadLog.filter((line) => line.includes("/git/blobs/") || line.includes("/raw/")), []);
    });

    it("reads files the archive omits or rewrites through blobs, with correct bytes", async () => {
      const log: string[] = [];
      archiveNotes.length = 0;
      const repo = await session("pub", log, new IDBFactory());
      assert.equal(repo.archive.state.kind, "ready");
      log.length = 0;
      assert.equal(dec.decode((await repo.readFile("NOTES.md")).content), PUB_FILES["NOTES.md"]);
      assert.deepEqual((await repo.readFile("bin/blob.dat")).content, PUB_FILES["bin/blob.dat"]);
      assert.equal((await repo.readFile("empty.txt")).content.length, 0);
      assert.equal(dec.decode((await repo.readFile(LONG)).content), "long path\n");
      assert.equal(dec.decode((await repo.readFile("docs/caf\u00e9 menu.txt")).content), "unicode name\n");
      assert.equal(log.filter((line) => line.includes("/git/blobs/")).length, 0, "files the archive carries verbatim need no blob read");

      assert.equal(dec.decode((await repo.readFile("ignored.txt")).content), PUB_FILES["ignored.txt"]);
      assert.equal(dec.decode((await repo.readFile("eol.txt")).content), PUB_FILES["eol.txt"], "the blob, not the crlf-converted archive bytes");
      assert.equal(log.filter((line) => line.includes("/git/blobs/")).length, 2);
      assert.deepEqual(archiveNotes.filter((note) => note.includes("do not match")), [], "the crlf-converted eol.txt differs in size from its tree entry, so it is never stored");
    });
  });
});
