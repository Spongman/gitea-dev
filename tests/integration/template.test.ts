// Renders gitea/custom/templates/custom/extra_tabs.tmpl in a live Gitea v1.24.6.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { validateLaunch } from "../../packages/editor-host/src/launch.ts";
import { GiteaFixture, type SeededRefs, REPO_CUSTOM_DIR, startGitea } from "../helpers/gitea.ts";
import path from "node:path";

const LINK_TAG = /<a\b[^>]*\bdata-gitea-dev-launch\b[^>]*>/g;
const OWNER = { name: "owner" };
const PAGE_USERS = [{ name: "owner", tokens: { full: ["all"] } }];

function unescapeHtml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Hrefs of every launch link in the page, HTML-unescaped. */
function launchHrefs(html: string): string[] {
  return (html.match(LINK_TAG) ?? []).map((tag) => {
    const m = /\bhref="([^"]*)"/.exec(tag);
    assert.ok(m, `launch link without href: ${tag}`);
    return unescapeHtml(m[1]);
  });
}

function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function assertNoTemplateFailure(fx: GiteaFixture, where: string): void {
  const log = fx.logText();
  assert.doesNotMatch(log, /template|panic|\[E\]|ERROR/i, `Gitea log after ${where}:\n${log.slice(-2000)}`);
}

interface Launch {
  href: string;
  url: URL;
  owner: string;
  repository: string;
  ref: string;
  refKind: string;
}

async function launchFor(fx: GiteaFixture, webPath: string): Promise<Launch> {
  const page = await fx.web(webPath);
  assert.equal(page.status, 200, `GET ${webPath}: ${page.text.slice(0, 300)}`);
  assert.doesNotMatch(page.text, /Internal Server Error|template: /, `GET ${webPath} body shows a server error`);
  const hrefs = launchHrefs(page.text);
  assert.ok(hrefs.length >= 1, `no launch link on ${webPath}`);
  assert.equal(new Set(hrefs).size, 1, `launch links differ on ${webPath}: ${hrefs.join(" | ")}`);
  const url = new URL(hrefs[0], `${fx.baseUrl}${webPath}`);
  const p = url.searchParams;
  return {
    href: hrefs[0],
    url,
    owner: p.get("owner") ?? "",
    repository: p.get("repository") ?? "",
    ref: p.get("ref") ?? "",
    refKind: p.get("refKind") ?? "",
  };
}

function expectLaunch(fx: GiteaFixture, launch: Launch, repo: string, ref: string, refKind: string, path?: string): void {
  assert.equal(launch.url.origin, new URL(fx.baseUrl).origin);
  const sub = new URL(fx.baseUrl).pathname.replace(/\/+$/, "");
  assert.equal(launch.url.pathname, `${sub}/assets/gitea-dev/index.html`);
  assert.deepEqual([...launch.url.searchParams.keys()].sort(), path === undefined ? ["owner", "ref", "refKind", "repository"] : ["owner", "path", "ref", "refKind", "repository"]);
  assert.equal(launch.url.searchParams.get("path") ?? undefined, path);
  assert.equal(launch.owner, "owner");
  assert.equal(launch.repository, repo);
  assert.equal(launch.ref, ref);
  assert.equal(launch.refKind, refKind);
  const descriptor = validateLaunch(launch.url, fx.baseUrl);
  assert.equal(descriptor.instance, fx.baseUrl);
  assert.equal(descriptor.ref, ref);
  assert.equal(descriptor.refKind, refKind);
}

function pagesFor(repo: string, refs: SeededRefs) {
  const r = `/owner/${repo}`;
  return [
    { page: r, ref: "main", kind: "branch" },
    { page: `${r}/src/branch/main`, ref: "main", kind: "branch" },
    { page: `${r}/src/branch/main/dir`, ref: "main", kind: "branch" },
    { page: `${r}/src/branch/${refs.branch}`, ref: refs.branch, kind: "branch" },
    { page: `${r}/src/branch/${refPath(refs.slashBranch)}`, ref: refs.slashBranch, kind: "branch" },
    { page: `${r}/src/branch/${refPath(refs.slashBranch)}/dir/hello.txt`, ref: refs.slashBranch, kind: "branch", path: "dir/hello.txt" },
    { page: `${r}/src/tag/${refs.tag}`, ref: refs.tag, kind: "tag" },
    { page: `${r}/src/tag/${refPath(refs.slashTag)}`, ref: refs.slashTag, kind: "tag" },
    { page: `${r}/src/commit/${refs.commit}`, ref: refs.commit, kind: "commit" },
    { page: `${r}/src/commit/${refs.commit}/bin/blob.dat`, ref: refs.commit, kind: "commit", path: "bin/blob.dat" },
    { page: `${r}/commit/${refs.commit}`, ref: refs.commit, kind: "commit" },
    // Pages without a ref fall back to the default branch.
    { page: `${r}/issues`, ref: "main", kind: "branch" },
    { page: `${r}/pulls`, ref: "main", kind: "branch" },
    { page: `${r}/activity`, ref: "main", kind: "branch" },
  ];
}

describe("extra_tabs.tmpl rendered by Gitea at /", () => {
  let fx: GiteaFixture;
  let refs: SeededRefs;

  before(async () => {
    fx = await startGitea({ custom: true, users: PAGE_USERS });
    refs = await fx.seedRefs("owner", "pub");
  });
  after(async () => fx?.stop());

  it("renders a launch link for every ref kind and fallback page", async () => {
    for (const { page, ref, kind, path } of pagesFor("pub", refs)) {
      expectLaunch(fx, await launchFor(fx, page), "pub", ref, kind, path);
    }
    assertNoTemplateFailure(fx, "page renders");
  });

  it("loads the shortcut script from the same origin", async () => {
    const page = await fx.web("/owner/pub");
    assert.match(page.text, /<script src="\/assets\/gitea-dev\/shortcut\.js"><\/script>/);
    const js = await fx.web("/assets/gitea-dev/shortcut.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const expected = await readFile(path.join(REPO_CUSTOM_DIR, "public/assets/gitea-dev/shortcut.js"), "utf8");
    assert.equal(js.text, expected);
  });

  it("renders no link on an empty repository and no 500", async () => {
    await fx.apiOk(OWNER, "POST", "/user/repos", { name: "empty", auto_init: false });
    const page = await fx.web("/owner/empty");
    assert.equal(page.status, 200);
    assert.deepEqual(launchHrefs(page.text), []);
    assertNoTemplateFailure(fx, "empty repo");
  });

  it("renders no link to anonymous users on a private repository (404)", async () => {
    await fx.createRepo("owner", "priv", { private: true });
    const page = await fx.web("/owner/priv");
    assert.equal(page.status, 404);
    assert.deepEqual(launchHrefs(page.text), []);
  });

  it("keeps hostile branch names inside the query value", async () => {
    // Names Gitea accepts are checked; at least two must be accepted so the test cannot pass vacuously.
    const candidates = ["x&ref=evil", "a%2Fb", 'q"t', "p<b>", "u'v", "sp+ace", "h#ash", "\u00fcn\u00ef"];
    const accepted: string[] = [];
    for (const name of candidates) {
      const res = await fx.api(OWNER, "POST", "/repos/owner/pub/branches", { new_branch_name: name, old_ref_name: "main" });
      if (res.status === 201) {
        accepted.push(name);
      }
    }
    assert.ok(accepted.length >= 2, `Gitea accepted only ${JSON.stringify(accepted)}`);
    for (const name of accepted) {
      const page = await fx.web(`/owner/pub/src/branch/${refPath(name)}`);
      assert.equal(page.status, 200, `branch ${JSON.stringify(name)}: HTTP ${page.status}`);
      for (const tag of page.text.match(LINK_TAG) ?? []) {
        assert.match(tag, /\bhref="[^"<>']*"/, `raw markup characters in href: ${tag}`);
      }
      const url = new URL(launchHrefs(page.text)[0], fx.baseUrl);
      assert.deepEqual([...url.searchParams.keys()].sort(), ["owner", "ref", "refKind", "repository"]);
      assert.equal(url.searchParams.get("ref"), name);
    }
    assertNoTemplateFailure(fx, "hostile refs");
  });
});

describe("extra_tabs.tmpl rendered by Gitea under a sub-path", () => {
  let fx: GiteaFixture;
  let refs: SeededRefs;

  before(async () => {
    fx = await startGitea({ custom: true, subPath: "/git", users: PAGE_USERS });
    refs = await fx.seedRefs("owner", "pub");
  });
  after(async () => fx?.stop());

  it("prefixes the launch link and script with the sub-path", async () => {
    assert.equal(new URL(fx.baseUrl).pathname, "/git");
    for (const { page, ref, kind, path } of pagesFor("pub", refs)) {
      const launch = await launchFor(fx, page);
      assert.ok(launch.href.startsWith("/git/assets/gitea-dev/index.html?"), launch.href);
      expectLaunch(fx, launch, "pub", ref, kind, path);
    }
    const page = await fx.web("/owner/pub");
    assert.match(page.text, /<script src="\/git\/assets\/gitea-dev\/shortcut\.js"><\/script>/);
    assert.equal((await fx.web("/assets/gitea-dev/shortcut.js")).status, 200);
    assertNoTemplateFailure(fx, "sub-path renders");
  });

  it("rejects the launch link when validated against a different instance", async () => {
    const launch = await launchFor(fx, "/owner/pub");
    assert.throws(() => validateLaunch(launch.url, `${new URL(fx.baseUrl).origin}/other`));
  });
});

describe("extra_tabs.tmpl on pull request pages", () => {
  const WRITER = { name: "writer" };
  let fx: GiteaFixture;
  let sameHead: string;
  let forkHead: string;

  async function branchWithFile(user: { name: string }, owner: string, repo: string, branch: string): Promise<string> {
    await fx.apiOk(user, "POST", `/repos/${owner}/${repo}/branches`, { new_branch_name: branch, old_ref_name: "main" });
    const res = await fx.apiOk<{ commit: { sha: string } }>(user, "POST", `/repos/${owner}/${repo}/contents`, {
      message: `work on ${branch}`,
      branch,
      files: [{ operation: "create", path: `${branch}.txt`, content: Buffer.from("x\n").toString("base64") }],
    });
    return res.commit.sha;
  }

  async function launchOf(pr: number, tab = ""): Promise<Launch> {
    return launchFor(fx, `/owner/pub/pulls/${pr}${tab}`);
  }

  before(async () => {
    fx = await startGitea({
      custom: true,
      users: [{ name: "owner", tokens: { full: ["all"] } }, { name: "writer", tokens: { full: ["all"] } }],
    });
    await fx.seedRefs("owner", "pub");
    sameHead = await branchWithFile(OWNER, "owner", "pub", "same-head");
    await fx.apiOk(OWNER, "POST", "/repos/owner/pub/pulls", { head: "same-head", base: "main", title: "same repo" });
    await fx.apiOk(WRITER, "POST", "/repos/owner/pub/forks", {});
    forkHead = await branchWithFile(WRITER, "writer", "pub", "fork-head");
    await fx.apiOk(WRITER, "POST", "/repos/owner/pub/pulls", { head: "writer:fork-head", base: "main", title: "from fork" });
    await fx.apiOk(OWNER, "POST", "/repos/owner/pub/issues", { title: "plain issue" });
  });
  after(async () => fx?.stop());

  it("opens the head branch from every tab of a same-repository pull request", async () => {
    for (const tab of ["", "/files", "/commits"]) {
      const launch = await launchOf(1, tab);
      expectLaunch(fx, launch, "pub", "same-head", "branch");
    }
    assertNoTemplateFailure(fx, "same-repo PR pages");
  });

  it("opens the fork repository for a fork pull request", async () => {
    for (const tab of ["", "/files"]) {
      const launch = await launchOf(2, tab);
      assert.equal(launch.owner, "writer");
      assert.equal(launch.repository, "pub");
      assert.equal(launch.ref, "fork-head");
      assert.equal(launch.refKind, "branch");
      assert.equal(validateLaunch(launch.url, fx.baseUrl).owner, "writer");
    }
  });

  it("keeps the default branch on a plain issue", async () => {
    expectLaunch(fx, await launchFor(fx, "/owner/pub/issues/3"), "pub", "main", "branch");
  });

  it("opens the head commit from the base repository once the head branch is gone", async () => {
    await fx.apiOk(OWNER, "DELETE", "/repos/owner/pub/branches/same-head");
    await fx.apiOk(WRITER, "DELETE", "/repos/writer/pub/branches/fork-head");
    for (const [pr, sha] of [[1, sameHead], [2, forkHead]] as const) {
      const launch = await launchOf(pr);
      expectLaunch(fx, launch, "pub", sha, "commit");
    }
    assertNoTemplateFailure(fx, "deleted head branches");
  });
});

describe("control: Gitea without the custom tree", () => {
  let fx: GiteaFixture;

  before(async () => {
    fx = await startGitea({ users: PAGE_USERS });
    await fx.createRepo("owner", "pub");
  });
  after(async () => fx?.stop());

  it("renders no launch link, so the link tests depend on the template", async () => {
    const page = await fx.web("/owner/pub");
    assert.equal(page.status, 200);
    assert.deepEqual(launchHrefs(page.text), []);
  });
});
