# Tests

Three suites, all run from the repository root. Redirect their output to `./build.log`.

| Suite | Command | Needs |
| --- | --- | --- |
| Unit (`node:test` through `tsx`, `tests/*.test.ts`) | `npm test` | Node 22 |
| Integration against a disposable Gitea 1.24.6 (`tests/integration/*.test.ts`) | `npm run test:integration` | Linux x64, `git`, network on the first run |
| Browser (Playwright: Chromium, Firefox, WebKit; `tests/browser/*.spec.ts`) | `npm run test:browser` | `npm run build` output, `npx playwright install chromium firefox webkit`, the cached workbench archive (`npm run assets -- warm`) or network |

The unit suite has one optional case that installs the real pinned workbench
archive; it runs only when `GITEA_WORKBENCH_ARCHIVE` names the downloaded file
(`tests/assets.test.ts`). Pass counts are not recorded in this document; run the
suites for the current numbers.

## Integration tests against a disposable Gitea

Real Gitea v1.24.6 process, SQLite in a temp dir, nothing mocked.

```sh
npm run test:integration 2>&1 | tee -a ./build.log
node scripts/test-gitea.mjs ensure              # only fetch and verify the binary
```

Files run in parallel, one fixture per `startGitea()`. One case is skipped: the
archive 404 for a nonexistent commit, because Gitea 1.24.6 sends no response
within 5 seconds (comment above `it.skip` in `tests/integration/archive.test.ts`).

## Browser tests

`tests/helpers/gallery.ts` supplies a fixture extension gallery (Open VSX-shaped
responses with CORS and no CORP), so browser checks do not depend on Open VSX
availability. Browser coverage includes local saves, reload recovery, discard,
single-commit writes, conflicting remote edits, private repositories, OAuth,
logout, the period shortcut, search, cross-file TypeScript definitions, source
control (branches, staging, pull requests), archive prefetch, Settings Sync,
theme, secrets, extension install and the virtual shell.

### Static deployment in the browser suite

`tests/browser/server.ts` installs `dist/gitea-dev` (from `npm run build`) into
the disposable Gitea's custom directory with `scripts/install.sh` (through `scripts/run-installer.mjs`) and lets
Gitea serve it on port 8081; there is no Node editor server. The workbench
comes from the cached archive with `--workbench=local`, or with
`--workbench=download` when the cache has none (`tests/helpers/workbench.ts`,
also used by the specs that start their own Gitea). It reinstalls once
Gitea runs to add the OAuth client id. A second origin on port 8082 serves the
fixture gallery (`tests/helpers/gallery.ts`, CORS for any origin and no CORP,
like Open VSX) and the test controls under `/__test/`. The harness installs an
extension allowlist without `gitea-test.blocked-fixture`. Playwright starts the
server as its `webServer` and stops it with SIGTERM (`gracefulShutdown` in
`playwright.config.ts`), so `tests/browser/server.ts` stops Gitea and removes
its temp dir.

`tests/install.test.ts` runs `install.sh` (under `sh` and,
when present in PATH, `ksh`, `dash` and `busybox sh`) on a fixture release tree and a fixture workbench archive,
and requires identical files, identical rejections with identical messages under every shell, refusal to overwrite a differing
template or `shortcut.js`, and idempotent reinstalls. Its checks of a running Gitea use a local HTTPS stand-in
that answers as Gitea 1.24.6 does (the real one is exercised by the browser harness's second install).
`tests/browser/sync.spec.ts` runs the real native Settings Sync client against
the service worker's store: automatic turn-on, device-to-device sync, turning
sync off, Clear Data in Cloud and extension sync.

### CDN mode

`BROWSER_WORKBENCH=cdn` installs with `--workbench=cdn` and starts every Gitea
with the `[cors]` section README requires; it needs internet. Specs that assert
no request leaves Gitea, that the extension host is on the Gitea origin, or
that extensions share the Gitea session (`editor.spec.ts`, `extensions.spec.ts`,
`extension-reach.spec.ts`, `shell.spec.ts`, `subpath.spec.ts`, `sync.spec.ts`,
`webviews.spec.ts`) fail in this mode by design.
`tests/browser/cdn.spec.ts` covers the mode itself and is skipped without it.
Chromium gets the `local-network-access` permission. WebKit refuses an `http`
Gitea from the CDN extension host; `BROWSER_HTTPS=1` serves Gitea over HTTPS
with a throwaway certificate, and only `cdn.spec.ts` uses relative URLs
throughout, so run it alone in that case:

```sh
BROWSER_WORKBENCH=cdn npx playwright test --project=chromium --project=firefox 2>&1 | tee -a ./build.log
BROWSER_WORKBENCH=cdn BROWSER_HTTPS=1 npx playwright test tests/browser/cdn.spec.ts 2>&1 | tee -a ./build.log
```

### Parallel browser runs

`playwright.config.ts` runs `BROWSER_WORKERS` workers (default 4; `fullyParallel` is off, so the tests of one file run in order on one worker). The shared Gitea on 8081 has `owner` plus one account per worker slot, `owner-w0` .. `owner-w<N-1>`, each with its own `browser-fixture` (same seed as `owner`'s) and `browser-private` repository and its own token. `tests/browser/server.ts` builds them from the same `BROWSER_WORKERS` (the config passes it to the web server); `/__test/token` and `/__test/login` take `?worker=<n>` (no parameter: `owner`; unknown slot: 404 naming `BROWSER_WORKERS`).

`tests/browser/fixtures.ts` exports `test` with a worker-scoped `account` fixture (`user`, `password`, `token`, `launch(repo?, ref?)`) chosen by `testInfo.parallelIndex`, which stays stable when a worker restarts after a failure. Specs that write state tied to the user or that sign in as the user use it: `editor` (commits to `browser-fixture`), `source-control` (own repositories per test), `sync` (the user's Actions variables), `theme` (the user's theme setting, which every signed-in editor reads), `secrets`, `extension-reach`. `archive`, `extensions`, `shell` and `special-files` stay on `owner`: they only read `owner/browser-fixture` or create uniquely named repositories (`<prefix>-<project>-<ms>`). `allowlist`, `subpath` and `webviews` start their own Gitea and gallery on free ports. Use `--workers=N` above `BROWSER_WORKERS` only together with `BROWSER_WORKERS=N`.

The web server runs as `node --import tsx tests/browser/server.ts` with `gracefulShutdown: SIGTERM, 15 s`. The `npx` and `tsx` CLI wrappers exit on SIGTERM before `stop()` deletes the Gitea temp dir (comment in `playwright.config.ts`), so they are not used.

### Writing browser tests

- `command()` in `tests/browser/fixtures.ts` returns only plain data. Serializing a rich command result through Playwright (for example the editor pane that `workbench.action.openSettingsJson` returns) blocks the page main thread for seconds, so commands whose result is not plain data return `undefined`.
- The user `settings.json` opens in a modal editor dialog. Scope locators to that dialog (`settingsDialog` and `settingsEditor` in `tests/browser/sync.spec.ts`), not to the page.

### Sub-path, allowlist and webview specs

Each has its own Gitea (random ports) and install, so the default harness is untouched.

- `tests/browser/subpath.spec.ts`: Gitea with ROOT_URL `http://127.0.0.1:<port>/git/` behind the prefix-stripping test proxy. Gitea 1.24.6 cannot serve a sub-path itself (direct `/git/...` is 404; first test). Covers isolation, worker scope `/git/assets/gitea-dev/`, launch link and period shortcut, OAuth popup and silent sign-in with the callback under `/git/`, read and commit with the OAuth token, PAT sign-in, gallery install and allowlist. Requests outside `/git/` are collected and must be empty.
- `tests/browser/allowlist.spec.ts`: an extension installed while allowed, then removed from the allowlist by reinstalling. The service worker refuses the extension's resources and, because `extensions.allowed` is set from the allowlist (`packages/editor-host/src/bootstrap.ts`), the Extensions view shows it disabled with "not in the allowed list". A second test replaces the worker's allowlist with `null` to show the workbench alone disables it. Side effect of the pinned workbench (`isPublisherTrusted` returns true for ids allowed by `extensions.allowed`): allowlisted extensions install without the publisher-trust prompt.
- `tests/browser/webviews.spec.ts`: default has no frame or request on another origin (runs offline). `--webviews=vscode-cdn` tests need network access to `*.vscode-cdn.net` and skip with a reason when offline, so run them outside a network-less sandbox. A fixture extension (`panel-check`) runs a probe inside its webview and posts the result. The Markdown preview is hosted on `*.vscode-cdn.net` but renders empty (requests to its Gitea-hosted styles and scripts fail: webview page COEP `require-corp`, no CORP on Gitea static); that case is `fixme`. Playwright on Firefox cannot evaluate in these cross-origin frames, hence the in-webview probe. In the webview `window.parent === window`, so `window.parent.document` does not throw; `window.top.document` does.

### What a gallery extension can reach

`tests/browser/extension-reach.spec.ts` signs in to Gitea's web UI, signs in to
the editor with a PAT, installs `gitea-test.probe-fixture` from the fixture
gallery and runs its command in the extension host. In Chromium, Firefox and
WebKit the test asserts:

| Probe | Result |
| --- | --- |
| `fetch('/user/settings', { credentials: 'include' })` | 200 at `/user/settings`; the page contains the user name and a CSRF token |
| Open IndexedDB `gitea-web-ide-secrets`, decrypt every `secrets` record with the `keys` CryptoKey | records decrypt; one plaintext contains the PAT |

This is a characterization, not a desired property (`README.md`, Security model).
Without the Gitea login step the settings probe lands on `/user/login` and the
test fails, so it does detect the session.

### WebKit on Rocky Linux 9

Playwright's Ubuntu fallback requires extra shared libraries on this host:

```sh
node scripts/setup-webkit.mjs
```

The script downloads verified Ubuntu packages into `data/browser-libs`; it does
not install system packages. The Playwright configuration uses those libraries
for WebKit only. Its static dependency checker is bypassed when this local
runtime is present; the actual headless browser tests still run. Media codec
and headed WebKit behavior are not covered.

## Prerequisites (missing ones fail, never skip)

- Network to `dl.gitea.com` on the first run only. The binary is cached.
- `git` on PATH (Gitea requires it); `requireGit()` throws a clear error.
- Free loopback ports (chosen at random).

## Binary

`scripts/test-gitea.mjs`:

- Pins `gitea-1.24.6-linux-amd64` from `https://dl.gitea.com/gitea/1.24.6/`.
- Pinned SHA-256 `bb09d565d7e22ed07a9525d22e6f7c468ec00b58484a9691d61ff70940452676`. It also fetches the official `.sha256` file and refuses to download if the two differ.
- Downloads to a `.part` file, verifies the digest, then renames atomically. A cached binary is re-hashed before every use.
- Cache: `data/test-tools/gitea-1.24.6/` (override with `GITEA_TEST_TOOLS_DIR`). The binary is never added to source; keep `data/` out of version control.

## Fixture (`tests/helpers/gitea.ts`)

`startGitea({ subPath?, users?, custom? })` returns a `GiteaFixture`:

- Writes its own `app.ini`; runs `gitea migrate`, `gitea admin user create`, `gitea admin user generate-access-token --raw`, then `gitea web`. Each fixture gets its own work path, custom path, HOME and port.
- Users default to `admin`, `owner` (tokens `full` and `readonly`), `writer`, `reader`, `outsider`. Pass a smaller `users` list for browser tests.
- Passwords and tokens are random, in memory only, registered for redaction. CLI errors omit argv and stdout; `redact()` is applied to errors and log excerpts. The user password is passed with `--password`, so it is visible in the process list of the local machine for the length of that CLI call.
- `password(user)` is a getter for browser sign-in tests. The record's `password` property is non-enumerable, so logging or serializing a user cannot print it.
- `createOAuthApp(user, { name, redirectUris, confidential?, skipSecondaryAuthorization? })` uses the public `POST /api/v1/user/applications/oauth2`. Public (PKCE) with `skip_secondary_authorization` by default, like the editor app; it throws if Gitea does not apply the flag. Gitea 1.24.6 also returns a secret for public clients; the helper hides it.
- `subPath: "/git"` puts a local reverse proxy in front of Gitea that strips the prefix, and sets `ROOT_URL` to the prefixed URL (Gitea expects the proxy to strip it). `baseUrl` includes the sub-path; `directUrl` bypasses the proxy.
- `custom: true` copies `gitea/custom` into `$GITEA_CUSTOM` before start; a string copies that directory; a function populates it (the browser harness runs the installer there).
- `port` fixes Gitea's HTTP port (the browser harness uses 8081); default is a free random port.
- `lfs: true` turns on Gitea's built-in LFS server (`LFS_START_SERVER`, with a random `LFS_JWT_SECRET`); it is off by default. The browser harness enables it.
- `tests/helpers/git-push.ts`: `pushWithGit()` clones, changes and pushes with plain `git` over HTTP (the contents API cannot create symlinks or submodules); the token travels in `GIT_CONFIG_*` environment variables, never in argv, URLs or logs. `uploadLfsObject()` uploads an object through the LFS batch API (`info/lfs/objects/batch`, then the returned upload and verify actions) because `git-lfs` is not on PATH in this environment; `pushSpecialFiles()` builds the LFS, symlink and submodule repository used by the integration and browser tests.
- Helpers: `api()/apiOk()` (token or anonymous), `web()`, `createRepo()`, `commitFiles()`, `seedRefs()` (main, `dev`, `feature/x-y`, tags `v1.0` and `rel/v1`, a first commit and a later head), `logText()`, `stop()` (SIGTERM, then SIGKILL after 10 s, removes the temp dir).

Not available: the Gitea source patch, so there is no session bridge and `GiteaSessionBridgeAuth` is not exercised.

## What is covered

`tests/integration/repository.test.ts` (`HttpGiteaRepository` + `PersonalAccessTokenAuth` from `packages/gitea-repository/src/index.ts`):

- Public reads without auth; text and binary byte-for-byte; sha equals the git blob id; paths with spaces, Unicode, `%`, `#`, `?`, `&`, `+`, literal `%2F`.
- Domain errors for missing, mistyped, traversal and `.git` paths (traversal makes zero requests); empty repository; unknown repo or ref; not initialized; abort.
- Refs: branch, slash branch, `refs/heads/`, tag, slash tag, `refs/tags/`, full commit id; pinning after the branch moves; `refresh()` and `refresh(commit)`.
- Private repository: hidden from anonymous and outsider; read collaborator reads but cannot write; write collaborator can; invalid token is `unauthenticated` and not echoed; token never in a URL.
- Server-side enforcement through raw API calls the client would not send.
- Commits: create, update, delete, rename (with and without content change), binary, empty file, Unicode paths, 11 MiB file, slash branch, one commit with the base as its only parent, message round trip, validation, `maxFileSize`, already exists, atomicity, stale head, stale blob (paths named), same-file and different-file races.
- Protected branch (no push, push allowlist, other branch), archived repository, archive racing a write.
- Directory of 1100 entries (more than one tree page); file over Gitea's API blob limit read through the raw endpoint and hash-checked.
- Sub-path (`/git/hub`): read, commit, trailing slash on `instance`, not found outside the prefix.

`tests/integration/template.test.ts`: `extra_tabs.tmpl` rendered by Gitea at `/` and under `/git`; launch link on code pages (branch, slash branch, tag, slash tag, commit, directory, file) and on issues, pulls and activity (default-branch fallback); each link passes `validateLaunch`; no Go template error in the response or log; hostile branch names stay inside the query value; empty repository has no link; a control run without the custom tree has none.

`tests/integration/source-control.test.ts` (`GiteaRefs` and `Session` against Gitea): branch listing over more than one page and tags; branch creation from a branch, tag and full commit id; 409 on an existing name; a missing source ref; branch head after deletion; `compare` counts; commit to a new branch on a branch protected against pushes (parent is the old head, protected branch untouched, `Protected` before and `branch-exists` after); no new branch for a reader; selective commit (paths, rename as a unit, an unselected conflict does not block); create branch carries pending changes; remote head, incoming count and `refresh`; pull request creation with title and body, 409 duplicate and 422 same head and base.

`tests/integration/template.test.ts` also renders pull request pages: a same-repository head on the conversation, files and commits tabs, a fork head, the commit fallback after the head branch is deleted, and a plain issue.

`tests/integration/special-files.test.ts` (LFS server on; a second fixture with it off): on the per-blob path and on the archive path, with the same assertions on both:
- LFS: `readFile` returns the object from the media endpoint (hash and size checked, tree entry still the pointer blob); `lfs: 'pointer'` returns the pointer with no media request; an object the server never received stays a pointer, unresolved; an object over `maxFileSize` is refused with no download; in the overlay the file is read-only with a message naming Git LFS, edits and renames are refused without a download; search skips it, downloads nothing, matches neither the object nor the pointer text, and warns with the count.
- Symlinks: entries are `symlink` with the target text as size and content; the overlay stats a link as its target type, follows it (also through a directory link), and for dangling, outside-the-repository (`../../etc/passwd`, absolute) links reports an unknown-type link and fails to read, with no request that names `etc`, `passwd` or `..`; links and paths below them are read-only; search skips them.
- Submodules: `submodule` entry with the target commit and size 0 in `getEntry`, `readDirectory` and `readTree`; reading fails with `unsupported` naming the commit and makes no blob request; read-only in the overlay and skipped by search.
- Archive content: `git archive` keeps the LFS pointer, writes symlinks as tar links and a submodule as an empty directory.
- Commits: an unrelated edit keeps every symlink, the gitlink and the LFS pointer blobs of the tree; the server refuses an update of a symlink and it stays mode 120000; the LFS-off fixture shows Gitea stores raw bytes over a pointer.

`tests/browser/special-files.spec.ts` (Chromium, Firefox, WebKit): the explorer lists links, a dangling link and a submodule (labelled `Symbolic Link` and `Submodule at commit ...`), a directory link expands, the LFS file opens with the object and rejects typing, a link opens its target's content, broken links and the submodule fail to open with the workbench's generic error page (the message naming the target is asserted in the integration tests), the LFS and link tabs show the lock icon, and search finds only the ordinary file.

`tests/integration/archive.test.ts` (recursive trees and archives against Gitea): a listing larger than one tree page with correct shas and sizes; `truncated` on a non-final page is not an error; the recursive listing fills the directory cache; subdirectory listings use repository-relative paths; `archive/{commit}.tar.gz` serves a gzip tar prefixed with the repository name, holds every file of the recursive tree except `export-ignore` ones, and answers a private repository with the token but 404 anonymously; end to end, a complete archive serves every file with zero `git/blobs` requests, a reload makes zero archive requests, and files the archive omits or rewrites are read through blobs.

`tests/integration/sync.test.ts` (Settings Sync store on Gitea): token acceptance as `Authorization: Bearer`, the round trip in the client's request shapes, chunking above the 64 KiB variable limit, torn writes, a read overlapping a write, racing writers (Gitea's 409 on create lets one win), history pruned with its chunks, per-user stores, no readable plaintext, token scopes (`read:user`, `write:user`, OAuth token), Gitea's naming and count rules, and visibility with Actions enabled and disabled.

`tests/integration/fixture.test.ts`: passwords log in (API basic auth and the web form), stay out of records and logs; a public OAuth application reaches Gitea's consent page after web login, and an unknown client or unregistered redirect URI does not.

## Real limits and behaviors observed (Gitea 1.24.6)

Gitea 1.24.6. "Test" names the case that asserts it.

| Behavior | Observed | Test |
| --- | --- | --- |
| API settings | `max_response_items` 50, `default_paging_num` 30, `default_git_trees_per_page` 1000, `default_max_blob_size` 10485760, `default_max_response_size` 104857600 | recorded Gitea limits |
| Blob over 10485760 bytes | `git/blobs/<sha>` returns `content: null`; the raw endpoint serves it | reads a file over Gitea's API blob limit |
| 11 MiB create via contents API | accepted (201). Upper bound unknown | commits an 11 MiB binary |
| Contents operation `rename` | HTTP 500, log `invalid file operation: rename ..., supported operations are create, update, delete`. Renames work as `update` with `from_path` | has no 'rename' contents operation |
| Delete of a missing path | HTTP 500, empty message; no commit made | fails a delete of a path that does not exist |
| Concurrent pushes to one branch | the loser gets HTTP 500 (`PushRejected` in the log); the client reports `commit-outcome-unknown`; no lost data | answers a concurrent push; race tests |
| Stale `sha` on update | 422 `sha does not match` | stale blob |
| Create of an existing path | 422 `repository file already exists` | rejects creating a path that already exists |
| Protected branch, no push | 403 `user cannot commit to repo` | protected |
| Non-allowlisted user on a protected branch | `user_can_push` false, so `canWrite` false | allows a user on the push allowlist |
| Archived repository | 423 `... is archived` | archived |
| Write without permission | 403 `user should have a permission to write to this branch` | has the server reject writes |
| Anonymous write: public repo / private repo | 401 `token is required` / 404 | has the server reject writes |
| Read-only scope token | reads work; write is 403 naming the missing `write:repository` scope | read-only-scope token |
| Private repo, no access | 404 `The target couldn't be found.` (reads and writes) | private repository |
| Branch name | with a space: 422; with `#`: accepted | recorded Gitea limits |
| Media endpoint, LFS on, object stored | `GET /repos/{o}/{r}/media/{path}?ref=` returns the object bytes | `reads the LFS object, not the pointer` |
| Media endpoint, LFS off or object never uploaded | 200 with the pointer text itself | `keeps the pointer, marked unresolved`; `reads the pointer, marked unresolved` |
| Contents `update` and `create` on a path with `filter=lfs` in `.gitattributes`, LFS on | the sent bytes become an LFS object; the blob is a pointer | `show why LFS files are read-only here` |
| Contents `update` of a pointer with LFS off | the raw bytes replace the pointer | `is still read-only in the overlay` |
| Contents `update` of a symlink | 422 `a symbolic link exists where ...` or 500 with an empty message; never a silent conversion | `are refused by the server for an update of a symlink` |
| Contents commit that touches other files | symlinks (120000) and gitlinks (160000) stay in the tree | `keep symlinks, submodules and LFS pointers` |
| Recursive tree | symlink `mode` 120000 `type` blob with `size` = target length; submodule `mode` 160000 `type` commit, `size` 0, `sha` = target commit | `is a submodule entry at its target commit` |
| Archive of a commit with LFS, links, a submodule | pointer text; tar symlink entries; the submodule as an empty directory | `holds LFS pointers as stored` |

## Not covered

- Session bridge (no Gitea patch). Browser OAuth token exchange and logout are covered by `tests/browser/editor.spec.ts`; this integration suite checks application registration and the consent page.
- Template when the user can see a repository but cannot read its Code unit (the `CanRead` guard); the fixture cannot create that state through the API used here. Gitea versions other than 1.24.6. A pull request whose head fork is private to someone else.
- Whether an unqualified ref that names both a branch and a tag resolves to the branch: Gitea refuses `branch` creation when a tag exists (409 seen in a probe, not asserted); the shared-name test accepts either outcome of tag creation and checks the qualified forms only.
- Short commit ids: the test accepts either a full-id resolution or a rejection; the behavior is not pinned.
- Directory renames, sizes above 11 MiB, protected-branch approvals and signed commits.
- LFS: `git-lfs` itself (objects are uploaded through the batch API, pointers committed with git), other LFS servers (external storage, S3), the `lfs.locksverify` and file-locking API, and objects at the 25 MiB read limit. Whether the editor's `stat.size` (the pointer's size for an LFS file) affects any VS Code limit check: UNPROVEN. The native VS Code `Read-Only` presentation of an LFS tab beyond rejecting typing.
- Symlinks: the stat of a link reports the target's size only inside the overlay; the gitea-base provider (diff originals) still reports a link as an unknown-type link and reads its target text. Deleting a link is refused (Gitea can delete one). Chains longer than 16 links fail as loops.
- Submodules: the `.gitmodules` URL is not read, so the tooltip shows only the commit.
- Deterministic stale-blob-at-same-head races: the stale blob is forced with a wrong `originalSha`; real races surface as `stale-head` or the 500 above.
- Other platforms: only `linux-amd64` is pinned.
