# Gitea Web IDE: design and requirements

Deployment and operation are in `README.md`; test layout, limits and prerequisites
are in `docs/testing.md`.

## Goal

The self-hosted Gitea equivalent of pressing `.` on GitHub:

- Open the current repository and ref in a new browser tab.
- Run the editor and extension host entirely in the browser.
- Read repository contents directly through Gitea.
- Keep edits locally until the user explicitly commits them.
- Commit changes through Gitea without cloning the repository.
- Work on independently operated Gitea instances.

This is a lightweight editor, not a Codespaces replacement. It has no terminal backed by
an operating-system process, no debugger, no server-side extension host and no process
execution on the Gitea host. Its terminal is a `vscode.Pseudoterminal` in the browser
extension host that starts no process, reads and writes only the repository overlay through the
`gitea-vfs` file system, and has no network access beyond the CSP.

## Constraints and decisions

1. **No reverse proxy, no Node at runtime, no extra process.** Gitea serves the editor as static files
   from `$GITEA_CUSTOM/public/assets/gitea-dev/` at `/assets/gitea-dev/`. Node or a prebuilt archive is
   needed only at install time (`scripts/build.mjs`, `scripts/install.sh`);
   `install.sh` needs no Node.
   Gitea's static responses carry no CSP, COOP, COEP or CORP and do carry `X-Frame-Options: SAMEORIGIN`
   (`curl -I` on `/assets/gitea-dev/index.html` of the local 28.2.0 instance), so the service worker
   `packages/editor-host/src/coi-sw.ts` adds them (COOP `same-origin`, COEP `require-corp`, CORP
   `same-origin`, CSP, `nosniff`, `no-referrer`; `coi-sw.ts:79-84`).
2. **Client-only workbench, never redistributed.** The workbench is the official standalone web archive,
   pinned in `config/workbench.json`; VS Code Server contains a remote agent and is never used. Its license
   (the archive's `LICENSE`, "MICROSOFT PRE-RELEASE SOFTWARE LICENSE TERMS") rules out shipping it, so the
   release holds only this project's code and the pin, and the installer's `--workbench` chooses the source:
   `cdn` (default) loads the pinned build in the browser from `https://main.vscode-cdn.net/stable/<commit>/`;
   `download` and `local` install the pinned archive, downloaded or from a file, after verifying its SHA-256,
   and Gitea serves it. The editor refuses to start unless the page is `crossOriginIsolated`. The workbench registers no service worker of its own
   (`serviceWorker.register` occurs 0 times in the pinned `workbench.web.main.internal.js`).
3. **No process terminal; a Pseudoterminal shell.** `gitea.openShell` opens a just-bash shell
   (`packages/gitea-vscode-web/src/shell/`). A browser has no process terminal, so the host maps
   `workbench.action.terminal.new` (New Terminal, the panel's `+`, Ctrl+Shift+`) to `gitea.openShell`
   (`bootstrap.ts`). The extension contributes a "Gitea Shell" terminal profile for the profile list and a
   welcome view on the empty Terminal panel with an **Open Gitea Shell** button (`viewsWelcome` on `terminal`).
   The panel does not start a terminal by itself: the workbench creates one on opening only with a terminal
   backend, which exists only with a remote server.
4. **Extensions are trusted like desktop VS Code.** With an installed workbench, gallery extensions run in a
   same-origin iframe worker on the Gitea origin (`tests/browser/editor.spec.ts:77,111`) and can reach what
   the user's session reaches (`tests/browser/extension-reach.spec.ts`); the product configuration leaves
   `webEndpointUrlTemplate` unset (`bootstrap.ts:112`), because Gitea sends `X-Frame-Options: SAMEORIGIN` and
   the workbench's host page only accepts a different parent origin through hostname validation
   (`webWorkerExtensionHostIframe.html:32,59`). In `cdn` mode the template is
   `https://{{uuid}}.vscode-cdn.net/{{quality}}/{{commit}}`, so the host runs on Microsoft's page and origin,
   with Microsoft's CSP (`connect-src` allows any `https:` host), and reaches Gitea through CORS with the
   user's token, without the session cookie. Workspace recommendations are disabled.
5. **Marketplace direct to Open VSX.** The browser calls the gallery itself (`--gallery`, default
   `https://open-vsx.org`); Open VSX answers CORS preflight with `access-control-allow-origin: *`. The
   operator's `--extensions-allowlist` is advisory (enforced in the browser). Automatic extension updates
   are off.
6. **Webviews follow the workbench mode.** `--webviews=vscode-cdn` allows Microsoft's `*.vscode-cdn.net`
   webview host in `frame-src`. It is the default with `--workbench=cdn`, whose page already loads from
   Microsoft's CDN; with `download` and `local`, which avoid Microsoft at runtime, the default is `disabled`,
   a static page that says embedded pages are unavailable. An explicit `--webviews` wins in every mode.
7. **Settings Sync in Actions variables.** The service worker answers the native sync protocol and stores
   the data in the user's Actions variables (`docs/settings-sync.md`).
8. **Authentication.** OAuth Authorization Code with PKCE and no client secret, using an application with
   `skip_secondary_authorization` so the editor re-signs in silently from the Gitea web session with a
   same-origin `fetch`; OAuth tokens stay in memory. A personal access token is the fallback; extension
   secrets (including that token) are AES-GCM encrypted in IndexedDB under a non-extractable key.
   A session bridge would need a Gitea backend patch and is not built (`docs/session-bridge.md`).
9. **Gitea versions.** The integration and browser suites run against Gitea 1.24.6. The local instance
   (`npm run instance:start`) runs Gitea 28.2.0, which renders the Web IDE tab. Other versions are untested.
10. **Commits target the opened branch.** When a protected branch refuses a commit, the editor asks for a new
    branch name and commits there. No force-push.
11. **Limits.** Files 25 MiB, text search 10,000 files and 50 MiB, recursive tree listing 100,000 entries,
    archive prefetch 128 MiB and 50,000 files (only the archive limits are settings, `gitea.archive.*`).

## Architecture

```text
Gitea repository page
        | `.` or Web IDE tab
        v
Start page + service worker (cross-origin isolation, CSP, Settings Sync store)
        |
        v
Client-only Code OSS web workbench (pinned build: Microsoft's CDN, or installed into $GITEA_CUSTOM)
        |
        v
Bundled Gitea VS Code web extension (packages/gitea-vscode-web)
        |-- Gitea repository module (packages/gitea-repository)
        |-- browser-local change overlay (extension global storage)
        `-- source control, search, shell, sign-in
        |
        v
Gitea REST API (same origin, or CORS from the CDN extension host); Open VSX (optional, direct)
```

Packages:

| Package | Role |
| --- | --- |
| `packages/asset-provider` | Acquires, validates and caches the pinned workbench for development and tests |
| `packages/editor-host` | Browser host: start page, bootstrap, launch validation, service worker, secret storage, Settings Sync store |
| `packages/gitea-repository` | Browser-compatible Gitea client (`fetch`, `Uint8Array`, Web APIs only) |
| `packages/gitea-vscode-web` | The web extension: `gitea-vfs` file system, overlay, source control, search, shell, authentication |
| `gitea/custom` | Files for `$GITEA_CUSTOM`: the `extra_tabs.tmpl` template and `shortcut.js` |

### Workbench assets

The build copies the pin into the release as `workbench.json` and puts the commit and archive SHA-256 into the
release version's fingerprint (`scripts/build.mjs`). The installer (`scripts/install.sh`) does the rest at install time:

- `cdn`: `configuration.json` gets `workbench: "https://main.vscode-cdn.net/stable/<commit>/"`, and the page
  CSP gets that origin in `script-src`, `style-src`, `img-src`, `font-src`, `connect-src` and `worker-src`, and
  `https://*.vscode-cdn.net` in `frame-src` (`@WORKBENCH_SOURCES@` and `@FRAME_SOURCES@`). The CDN answers
  with `access-control-allow-origin: *` and `cross-origin-resource-policy: cross-origin`, which COEP
  `require-corp` needs. `bootstrap.ts` loads the workbench from that root, sets the product
  `webEndpointUrlTemplate`, `quality` and `commit`, and supplies the Trusted Types policy
  `_VSCODE_WEB_PACKAGE_TTP`, without which the workbench's package loader rejects CDN script URLs such as
  xterm's (`[trusted_script_src] Invalid script url`). The extension and host bundle stay on Gitea; the
  extension host loads the extension through Gitea `[cors]`.
- `download` and `local`: the installer verifies the archive's SHA-256 against the pin before extracting it,
  drops Node-only parts (`node`, `bin` and `node_modules.asar` at any depth), restricts the extension-host
  iframe's `connect-src` to `'self'`, the gallery and `--connect-src`, and writes the inline script hashes of
  the workbench pages into the service worker (`@SCRIPT_HASHES@`), which adds them to each page's
  `script-src` (`packages/editor-host/src/sw-policy.ts`).

Before writing anything the installer checks the release, every argument (unknown options, missing values,
enumerations, options that do not apply to the mode), `GITEA_CUSTOM` (exists, writable, looks like Gitea's
custom directory), Gitea's `app.ini` (`<custom>/conf/app.ini`, Gitea's default, `modules/setting/path.go`, or
`--app-ini`: `[server] ROOT_URL`, and `[cors]` for `cdn`), the archive's SHA-256, and a running Gitea at
`ROOT_URL` (`/api/v1/version`, `appUrl` in its pages, CORS for the CDN origin, and the OAuth client through the
token endpoint's error for an invalid code, which names an unknown client, a confidential one or an unregistered
redirect URI before it checks the code). It prints every problem at once; checks that need an unreachable Gitea
are skipped with a note, so offline and staged installs work.

`WorkbenchAssets.ensure(version)` (`packages/asset-provider/src/types.ts`) returns the workbench `root`,
`version`, `commit` and `integrity`, and a `fallback` marker when it served the last validated install instead
of the pin. Two adapters: `CachedDownloadAssets` (default) and `BundledAssets` (offline, `WORKBENCH_ROOT`).
`CachedDownloadAssets` downloads the pinned archive, verifies its SHA-256 before extraction, rejects links,
traversal, native executables and server-only layouts (`validate.ts`), extracts into a versioned directory,
renames it into the cache atomically and serializes installs with a lock.

- Cache layout: `data/vscode-web/{versions,downloads,locks,current}`. `current` is the version served when a
  refresh of the pin fails; `rollback` only repoints it.
- The browser test harness and the local instance install from the cached archive
  (`scripts/cached-workbench.mjs`).
- Locks record host, boot and pid namespace and a heartbeat; a lock whose heartbeat is older than 30 seconds
  or whose same-host owner is dead is stale (`lock.ts`).
- Cache storage is trusted local administrator state and must not be writable by untrusted users.

### Gitea repository module

`GiteaRepository` (`packages/gitea-repository/src/types.ts`) covers repository metadata, tree reads, blob
reads and one atomic commit; the file system and source-control adapters use it and construct no HTTP
requests themselves. Its implementation hides same-origin URL construction, owner, repository and ref
encoding, authentication headers, base64 conversion, response normalization, HTTP-to-domain error mapping,
blob SHA and branch-head conflict detection, cancellation, bounded caching and retries of safe reads.
Details and the guards stock Gitea offers are in `packages/gitea-repository/README.md`.

### Virtual file system and overlay

The `gitea-vfs` provider merges the immutable remote tree with a browser-local overlay. Directories are Git
tree entries; there are no persistent empty directories. Pending changes (created, modified with their original
blob SHA, deleted, renamed, binary) live in the extension's global storage (`globalStorageUri`, one file per
record, keyed by instance, owner, repository, ref and base commit) and survive reload. That storage belongs to the
editor page, so it does not depend on the extension host origin. Concurrent tabs follow last-writer-wins per
record; a tab sees records that another tab creates only after it reloads. Saves create no Gitea commit.

### Source control and commits

On an explicit commit the extension revalidates the branch head and the affected blob SHAs, reports conflicts
without discarding local changes, converts the overlay into one Gitea multi-file request
(`POST /repos/{owner}/{repo}/contents`), clears the committed entries and refreshes. A commit takes the staged
set, or every change when nothing is staged.

### Authentication

`AuthProvider` (`packages/gitea-repository/src/types.ts`) has three adapters: `OAuthPkceAuth`,
`PersonalAccessTokenAuth` and `GiteaSessionBridgeAuth`. The last is exported but unused by the extension and
fails closed against stock Gitea. Stock Gitea's API authentication does not consume the web session
(`docs/session-bridge.md`), so a static template cannot give seamless sign-in.

### Gitea integration

The template `extra_tabs.tmpl` adds a Web IDE tab when the user can read code and the repository is not empty,
and `shortcut.js` handles `.`. The launch link carries only `owner`, `repository`, `ref` and `refKind`, plus `path` on a file page; the
browser validates it against the installed `configuration.json` (`launch.ts`). Details are in
`docs/gitea-integration.md`.

## Behavior reference

### Branches, staging and pull requests

- The status bar shows the opened branch, tag or commit. Clicking it (`gitea.switchRef`) lists branches and
  tags and reloads the editor at the chosen ref; pending changes are stored per ref and stay on the old one.
  `gitea.createBranch` cuts a branch from the current ref and moves the pending changes to it.
- Source Control has **Staged Changes** and **Changes** groups; the staged set survives a reload. Under the
  message box a **Commit** button (`gitea.commit`, secondary `gitea.commitToNewBranch`) is enabled while changes
  are pending on a branch, and a note names the branch that receives the commit. These use the `scmActionButton` and `scmValidation` proposed APIs,
  enabled for `gitea.gitea-vscode-web` in `bootstrap.ts` and the extension manifest.
- The Source Control "..." menu lists **Checkout to...** (`gitea.switchRef`) and **Fetch** (`gitea.checkRemote`),
  then the submenus **Commit** (Commit, Commit to New Branch), **Changes** (Stage All, Unstage All, Discard All) and
  **Branch** (Create Branch), then **Show Gitea Output**, below the workbench's own View entries. A changed file's
  row has **Open File** and Discard and Stage buttons, and its context menu adds **Open Changes** and **Open File**;
  the **Changes** group header has Discard All and Stage All.
- When the opened branch refuses a commit (it is protected), the editor asks for a branch name and commits
  there; `gitea.commitToNewBranch` does the same on demand. A notification then offers **Create Pull
  Request** and **Switch to Branch**. `gitea.createPullRequest` (`POST /pulls`) asks for a title; when Gitea
  refuses (a duplicate, no difference, no permission) it offers Gitea's compare page.
- While the window is focused the editor polls the branch head (`giteaWebIde.autoFetch.enabled`, default on;
  `giteaWebIde.autoFetch.interval`, default 60 seconds, minimum 15). A new remote commit shows a count in the
  status bar and asks to **Update**; `gitea.checkRemote` polls at once; **Refresh from Gitea** reports pending
  changes that conflict with the new head.
- On a pull request page the Web IDE tab opens the head branch (the fork's, for a fork), or the head commit
  when the branch is gone.

### Git LFS files, symlinks and submodules

- **LFS file**: opens with the real content, read through Gitea's `media/{path}?ref=` endpoint and checked
  against the pointer's SHA-256 and size. It is read-only and cannot be renamed (deleting is allowed). Gitea
  turns committed content back into an LFS object only when its LFS server is on and `.gitattributes` still
  matches; otherwise it stores the raw bytes in place of the pointer (Gitea 1.24.6, `docs/testing.md`), and the
  editor cannot see either condition. If the server has no LFS (or no object) the pointer text is shown, still
  read-only. Objects over the file size limit (25 MiB) fail to open with a size error.
- **Symlink**: shown as a symbolic link of the target's type (file or directory) when the target is inside the
  repository. Opening it opens the target; a directory link lists the target's entries. Links to a submodule,
  outside the repository (`../..`, absolute paths, `.git`), dangling or looping fail to open; nothing outside
  the repository is requested. Links, and everything reached through one, are read-only, so a commit never turns
  a link into a regular file.
- **Submodule**: an entry that is neither a file nor a folder, marked `S` in the Explorer with its commit in the
  tooltip. Opening it fails (the error names the commit); it is read-only and skipped by search.

The per-blob and the archive read paths behave the same.

### Search and navigation

Quick Open and Find in Files run in the browser over the repository tree and the overlay. They are the
extension's `FileSearchProvider` and `TextSearchProvider` for `gitea-vfs`
(`packages/gitea-vscode-web/src/extension.ts:147-148`), proposed APIs enabled for the extension in the product
configuration (`bootstrap.ts:95`).

- Text search supports regex, case and whole-word matching. It stops at 10,000 files or 50 MiB of text (binary
  files do not count) and reports partial results (`search-engine.ts:20`). Quick Open lists up to 100,000 files
  and says in the status bar when it stopped. It reads UTF-8 and UTF-16 with a byte order mark; other encodings
  are skipped and counted in the results warnings, as are folders that could not be listed. Git ignore files
  and following symlinks are not implemented. LFS files are listed but not searched; symlinks and submodules are
  skipped.
- Regular expressions run synchronously in the extension host worker, so a search cannot be cancelled while one
  match attempt runs. A regular expression query skips lines longer than 10,000 characters (counted in the
  warnings) and stops scanning a file after 2 seconds, checked between matches. Catastrophic backtracking inside
  one match attempt on a shorter line, such as `(a+)+$` on `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!`, still blocks the
  worker; stopping it would need a terminable Worker.
- Repository reads are cached by Git object ID. A recursive tree listing (`git/trees/{sha}?recursive=true`,
  paged) feeds Quick Open and folder expansion. Text search and file reads use a per-commit archive when one is
  available: the editor downloads `archive/{commit}.tar.gz` from the Gitea origin, checks each file's blob id and
  size against the tree, and keeps the files in IndexedDB (one archive per commit; 512 MiB in total by default,
  least recently used removed first). The download starts on the first text search (`gitea.archive.prefetch`:
  `onSearch`, the default, `onOpen` or `off`). Until it finishes, or for a repository over the limits (128 MiB,
  50,000 files by default), files are searched one at a time and the results carry a warning. The archive request
  uses the same API client and token as every other request, so it also works from the `cdn` extension host.
- TypeScript and JavaScript use the bundled browser language service. The COOP and COEP headers enable its
  SharedArrayBuffer file system bridge (`tests/browser/editor.spec.ts:179` resolves a cross-file Go to
  Definition). Repository identity is encoded in a lowercase URI authority because the TypeScript worker drops
  query strings when converting file paths. Other languages need compatible web extensions; there is no universal
  language server. External package type acquisition is blocked by the CSP.

### Shell

`gitea.openShell` opens a terminal running [just-bash](https://github.com/vercel-labs/just-bash) 3.6.0
(Apache-2.0, browser build), a bash interpreter written in TypeScript, as a `vscode.Pseudoterminal` in the
extension host.

- The repository is mounted at `/workspace` (`~`, the starting directory). Reads and writes go through
  `vscode.workspace.fs` on the `gitea-vfs` folder, so `echo x > t.txt`, `rm`, `mv`, `cp` and `mkdir` land in the
  overlay and show in Source Control. Nothing is committed from the shell. `status` lists pending changes
  (`A`, `M`, `D`, `R`); `help` describes the shell.
- The prompt is `owner/repo@ref:~/dir$`. Up/Down history, Ctrl+C, Ctrl+D (or `exit`) and the usual cursor and
  kill keys work. The working directory and variables persist between lines; functions and multi-line input do
  not.
- No processes and no network: `curl`, `python`, `node`, `sqlite3` and `git` are absent. `/tmp` is in memory.
  `gzip`, `gunzip` and `zcat` fail with a message (`node:zlib` is stubbed, `scripts/build.mjs:28-29`).
- The overlay cannot store symbolic or hard links, file modes or modification times: `ln`, `chmod` and `touch` on
  an existing file fail with a message saying so. `touch` creates new files.
- Globs, `find` and `grep -r` list directories on demand, so the first walk of a large tree makes the usual
  tree requests. just-bash 3.6.0 never calls the synchronous `getAllPaths`; the file system answers it from the
  recursive tree listing plus overlay paths, which is partial until that listing has loaded.
- Output of a line is printed when the line finishes (stdout, then stderr). Ctrl+C stops the line; an
  interrupted line leaves the working directory and variables unchanged, and a new line is refused ("still
  stopping") until the interrupted one has ended.
- Line editing counts every character as one column, so wide (CJK, emoji) characters can leave the cursor
  misplaced after an edit. A lone Esc is dropped after 50 ms. `>>` rewrites the whole file, because
  `workspace.fs` has no append.
- The shell has the same privileges as any extension in the extension host and adds none. The browser build of
  just-bash does not patch `eval`, `Function`, timers or other globals (`tests/shell-globals.test.ts`), and the
  shell passes `defenseInDepth: false` regardless (`shell/shell.ts:86`). Whether another extension can inject
  input with `Terminal.sendText` is untested; the effects would stay in the overlay and can be discarded.

### Theme

The editor follows the signed-in user's Gitea theme as light or dark (`packages/editor-host/src/theme.ts`). At
startup it reads `data-theme` with the session cookie from a Gitea page that renders only the base template (the
404 page of the reserved path `-/gitea-dev-theme-probe`): a name containing `dark` selects the workbench's Dark
2026 theme, `light` selects Light 2026, and anything else (`gitea-auto`, anonymous visitors, custom themes)
follows the OS color scheme. These are workbench defaults, so a color theme chosen in the editor still wins. If
Gitea cannot be reached within 1.5 s, the last scheme seen is used. The start page sends the request before the
workbench loads, so it overlaps the workbench download and does not delay startup; Firefox did not send it
within 1.5 s when it was made as the workbench bundle started to evaluate. After sign-in the extension confirms the
choice against the user's theme setting (`GET /api/v1/user/settings`,
`packages/gitea-vscode-web/src/theme-confirm.ts`); on a mismatch it remembers the setting's scheme, which then
takes precedence over the page on later loads, and offers to reload. It never writes the theme to
`settings.json`, so Settings Sync does not carry it.

### Browser extensions

Only web extensions run: the extension host is a web worker that loads an extension's `browser` entry
(`_getEntryPoint(e){return e.browser}` in the pinned `extensionHostWorkerMain.js`), so an extension with only
`main` never activates. The pinned host refuses ES modules (a `browser` entry ending in `.mjs`, or
`"type": "module"` with an entry that does not end in `.cjs`). With an installed workbench the extension host's
`connect-src` allows Gitea, the gallery hosts and `--connect-src`, so an extension that needs other hosts has
reduced functionality; in `cdn` mode Microsoft's host page allows any `https:` host.

## Security requirements

- Never ship Microsoft's workbench in the release; install it only from the pinned archive after verifying its
  SHA-256, or load the pinned build from Microsoft's CDN.
- Serve editor assets with `nosniff` and a restrictive CSP; only the extension-host iframe permits
  `'unsafe-eval'`, and with an installed workbench its `connect-src` is `'self'` plus the gallery and
  `--connect-src` hosts.
- Never place credentials in URLs, settings files, logs or workbench configuration. The launch URL carries only
  `owner`, `repository`, `ref` and `refKind`, plus an optional `path`.
- Reject path traversal before any Gitea request; encode owner, repository, ref and file path independently.
- Do not enable force-push.
- Do not expose process terminals, tasks, debuggers, port forwarding or a remote Node extension host.
- Opening a repository cannot install an extension (recommendations are disabled).
- For a session bridge, if built: enforce permission checks server-side and apply CSRF protection to mutations
  (`docs/session-bridge.md`).

## Acceptance criteria

- On a supported self-hosted Gitea repository page, pressing `.` opens a new editor tab.
- The editor displays the exact selected ref without cloning it.
- Public repositories require no authentication.
- Private repositories use the configured auth adapter without exposing credentials.
- Saves remain browser-local and survive reload.
- Explicit commit creates one atomic Gitea commit.
- Conflicting remote updates do not overwrite repository content.
- The editor works when Gitea is installed under a sub-path.
- The release contains no Microsoft code. By default browsers load the pinned workbench from Microsoft's CDN; an
  operator can instead install the pinned archive, downloaded or from a local file, verified against the pin.
- No editor action can execute a process on the Gitea host.

## Not implemented

- Session bridge: a Gitea backend patch for sign-in from the web session (`docs/session-bridge.md`).
- Pull request changed-files view and pull request editing.
- Hardened extension host: in `cdn` mode the extension host runs on `<uuid>.vscode-cdn.net` without the Gitea
  session, but the Gitea token still enters the shared extension worker; a broker on the main page that holds
  the token is not built. With an installed workbench the host shares the Gitea origin. A CSP `sandbox` header
  is an untested alternative: the host page compares `parentOrigin` with `window.origin` and `event.origin`
  (`webWorkerExtensionHostIframe.html:19,32,88,154`), and a sandboxed frame has an opaque origin.
- Built-in Markdown preview under `--webviews=vscode-cdn` with `download` or `local`: the webview opens but stays
  empty, because styles and scripts it loads from the Gitea origin lack a `Cross-Origin-Resource-Policy` header
  (`tests/browser/webviews.spec.ts`, the `fixme` case). With `cdn` those files come from the CDN, which sends
  `cross-origin-resource-policy: cross-origin`; the preview renders in Chromium and WebKit, and appeared empty
  in Firefox.
- Search that honors Git ignore files or follows symlinks; text search of LFS content.
- Installing a `.vsix` file; extensions that need Node or desktop executables.
