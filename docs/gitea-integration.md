# Gitea integration (Web IDE tab and `.` shortcut)

Tested against live Gitea v1.24.6 at `/` and `/git`. Template rendering, ref selection, query escaping and the shortcut are covered by integration and browser tests.

The local instance (`npm run instance:start`) runs Gitea 28.2.0 at `/`; its repository pages render the Web IDE tab with the launch link. See the Development section of `README.md` for its URL and service controls.

## Files

| Source in this repo | Install to (relative to `$GITEA_CUSTOM`) |
| --- | --- |
| `gitea/custom/templates/custom/extra_tabs.tmpl` | `templates/custom/extra_tabs.tmpl` |
| `gitea/custom/public/assets/gitea-dev/shortcut.js` | `public/assets/gitea-dev/shortcut.js` |

The tab links to `{{AppSubUrl}}/assets/gitea-dev/index.html`. Gitea serves the editor itself from the same custom directory as static files; see the root README for installation.

```sh
sh dist/gitea-dev/install.sh /path/to/GITEA_CUSTOM https://git.example.com/
```

Restart Gitea after the template is installed or changed; static files need no restart.

## Where the template renders

Verified in `templates/repo/header.tmpl` at v1.24.6 (`github.com/go-gitea/gitea`, tag `v1.24.6`):

- `header.tmpl:220`: `{{template "custom/extra_tabs" .}}` inside `.overflow-menu-items`, after Activity and before Settings. It is the intended extension point.
- `header.tmpl:138-143`: the Code tab's `CanRead` guard closes at line 142, before line 220. `extra_tabs` is therefore **not** permission-guarded by Gitea. The template checks `.Permission.CanRead ctx.Consts.RepoUnitTypeCode` and `not .IsEmptyRepo` itself.
- The header renders on all repo pages (code, issues, pulls, wiki, ...), so the tab appears on all of them.
- `templates/custom/extra_tabs.tmpl` ships empty upstream, so installing this file replaces nothing.

## Template data used

| Field | Evidence (v1.24.6) |
| --- | --- |
| `.Permission.CanRead ctx.Consts.RepoUnitTypeCode` | `templates/repo/header.tmpl:138` |
| `.IsEmptyRepo` | `services/context/repo.go:375` |
| `.Repository.OwnerName`, `.Repository.DefaultBranch` | `models/repo/repo.go:157`, `:165` |
| `.Repository.Name` | used at `header.tmpl:11` as `.Name` under `with .Repository` |
| `AppSubUrl` (func) | `modules/templates/helper.go:85`; sub-path comes from `ROOT_URL`, `modules/setting/server.go:312`, no trailing slash, `""` at root |
| `.RefFullName` (`git.RefName`) | `services/context/repo.go:924`, set only by `RepoRefByType` code routes |
| `.RefFullName.RefType`, `.ShortName` | `modules/git/ref.go:199`, `:148`; `RefType` is `branch`, `tag`, `commit`, or empty |
| `svg "octicon-code"` | `header.tmpl:140` |

Ref selection: on code routes (`/src/branch|tag|commit/...`) `.RefFullName` gives kind and short name. When `.RefFullName` is absent or has no kind, the template uses `.Repository.DefaultBranch` with kind `branch`.

**Commit pages open that commit.** `/{owner}/{repo}/commit/{sha}` sets `.PageIsDiff` and `.Commit` (not `.RefFullName`), so the template uses `.Commit.ID.String` with `refKind=commit` (a short sha in the URL becomes the full id). `/src/commit/{sha}[/path]` already carries the commit in `.RefFullName`. Asserted in `tests/integration/template.test.ts`; the editor side (tree and file content at the commit) in `tests/browser/editor.spec.ts`.

**Pull request pages open the PR head.** `routers/web/repo/pull.go` does not set `RefFullName`, but the PR page data has `.Issue` (`pull.go:131`; `.Issue.PullRequest` is loaded at `pull.go:138`), `.HeadBranchLink` (`pull.go:180`, empty when the head repository or branch is gone, or for AGit flow) and `.PullHeadCommitID` (`pull.go:511`, the commit at `refs/pull/N/head` in the base repository). The template opens the head branch (in the fork's repository for a fork PR) when `.HeadBranchLink` is set, else the base repository at that commit with `refKind=commit`. Rendered and asserted for the conversation, files and commits tabs, a fork PR, a deleted head branch and a plain issue in `tests/integration/template.test.ts`.

## Launch descriptor

The tab href is

```text
{AppSubUrl}/assets/gitea-dev/index.html?owner=...&repository=...&ref=...&refKind=branch|tag|commit[&path=...]
```

`path` is added on a file page (`.IsViewFile`, `.TreePath`) and is the file to open. `bootstrap.ts` passes it as `defaultLayout.editors` with `force` (so it applies to an existing session too) and `openOnlyIfExists`, then removes it from the address so a reload restores the session. It is not part of the workspace identity, so pending changes are shared with the same ref.

- Plain query fields. The instance is **not** in the URL. `validateLaunch(input, instance)` in `packages/editor-host/src/launch.ts` takes `instance` from the installed `configuration.json` (Gitea's `ROOT_URL`, given to the installer) and requires `input` to be on that origin and under its sub-path.
- No inline script and no JS interpolation. Values are inserted only into an `href` attribute by Go `html/template`, which applies contextual query and attribute escaping. Rendered escaping is tested with hostile branch names.
- The shortcut script reads the anchor's `href`; there is a single source of truth, so no separate `data-*` copies exist.
- `validateLaunch` rejects: credentials, other origin or port or scheme, paths outside the sub-path, encoded `/`, `\`, NUL in the path, fragments, any query key other than `owner|repository|ref|refKind|path`, a `path` that is empty or has an empty, `.` or `..` segment or `\`, repeated keys, malformed percent-encoding, U+FFFD (invalid UTF-8), control and format characters, invalid owner or repository names (Gitea rules, `modules/validation` `IsValidUsername`, `models/repo` `IsUsableRepoName`), invalid git ref names, and non-hex commit ids (7-64 hex digits; lowercased). Error messages never echo values.
- `instance` must be `https`, or `http` on `localhost`, `127.0.0.1`, `[::1]`; no credentials, query, or fragment; sub-path segments limited to `[A-Za-z0-9._~-]`.
- Limitation: the WHATWG `URL` parser resolves `..` before the validator sees it, so `/sub/a/../index.html` is accepted as `/sub/index.html`. Traversal that leaves the sub-path is rejected.
- Limits: owner, repository, and ref at most 255 UTF-16 units each. These are this project's limits, not Gitea's.

## Host path: use `index.html`, not the directory

`modules/public/public.go:83-87` (`handleRequest`) answers `404` for any directory, with the comment "need to serve index file? (no at the moment)". A bare `/assets/gitea-dev/` URL does not work with Gitea's static handler, so the tab links to `index.html` explicitly. Custom files are served from `$GITEA_CUSTOM/public` under `/assets/*` (`public.go:24`, `routers/web/web.go:235`).

The installer writes only to `public/assets/gitea-dev` (`ASSETS` in `scripts/install.sh`), so another host path is not supported.

## Shortcut script

`shortcut.js` is a classic script, no inline code, no `eval`. Behavior (covered by `tests/shortcut.test.ts` under happy-dom):

- Acts only if a `a[data-gitea-dev-launch]` link exists, which makes it repository-pages-only and permission-aware without matching URLs.
- Reacts to `keydown` of `.` with no ctrl, meta or alt (shift is allowed); ignores repeats, IME composition, and already-handled events.
- Ignores events from `input`, `textarea`, `select`, `contenteditable`, `role=textbox|combobox|searchbox|spinbutton`, `.monaco-editor`, `.cm-editor`, `.CodeMirror`, `dialog`, `role=dialog|alertdialog`, `aria-modal=true`, `.ui.modal`, and the focused element. Ignores all keys while `dialog[open]`, `.ui.active.modal`, or `.ui.active.dimmer` exists.
- Opens `window.open(url, '_blank', 'noopener')` only if the link resolves to the current origin.
- The script tag has no `defer` on purpose: it must run right after the anchor is parsed to cache the URL. `web_src/js/webcomponents/overflow-menu.ts` moves `.item` elements between the menu and a popup (`:79-107`), so the anchor may later be outside `document`; caching the URL makes that irrelevant.
- Cache: Gitea serves public assets with `CacheControlForPublicStatic` (`public.go`, `servePublicAsset`). After editing `shortcut.js`, clients may need a hard reload.

## OAuth application

Register the editor's public OAuth application with `skip_secondary_authorization: true` (see Installation in `README.md`). Users consent once in the sign-in popup; afterwards Gitea redirects an authorization request from a signed-in web session straight to the callback, and the editor signs in silently on each load with a same-origin `fetch` that follows the redirect and reads the final URL. This needs the editor to be served from the Gitea origin. No iframe is used, so COEP and `X-Frame-Options` do not apply (`packages/editor-host/src/bootstrap.ts:69-70`). Tokens are memory-only, so a Gitea logout ends editor access on the next load.

## Compatibility with other settings

- `STATIC_URL_PREFIX` (`server.go:314`) changes `AssetUrlPrefix`, not `AppSubUrl`. The template uses `AppSubUrl` so scripts stay same-origin. If your deployment serves `/assets` from elsewhere, the shortcut will still work only when the host page is same-origin.
- CSP: the template emits only an external same-origin script; it needs no `unsafe-inline`. The editor host CSP and worker iframe exception are covered by browser tests.
- Text "Web IDE" is hard-coded English; Gitea locale keys would need `custom/options/locale` overrides.

## Limits

- Versions other than 1.24.6 and 28.2.0 are untested. The full disposable test suite targets 1.24.6; on 28.2.0 only the rendered tab was checked.
- A pull request whose head is in a fork the viewer cannot read opens that fork and fails to load; the template does not check the viewer's access to the fork.
- The Code-unit permission guard is present, but a visible repository with its Code unit hidden is not exercised in the fixture.
- Fomantic modal suppression is covered by DOM tests, not a live open-modal browser test.

## Tests

```sh
npx tsx --test tests/launch.test.ts tests/shortcut.test.ts 2>&1 | tee -a ./build.log
npm run test:integration 2>&1 | tee -a ./build.log
npm run test:browser 2>&1 | tee -a ./build.log
```
