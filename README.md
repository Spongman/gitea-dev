# Gitea Web IDE

A VS Code editor that runs entirely in the browser for self-hosted [Gitea](https://about.gitea.com/), the
equivalent of pressing `.` on a GitHub repository. A **Web IDE** tab on every repository page, or the `.` key,
opens the repository at the current branch, tag, commit or pull request in a new browser tab. Edits stay in
the browser until you commit them, and the repository is never cloned.

Gitea serves the editor as plain static files: there is no extra server, reverse proxy or Node process at
runtime. The editor is made of two parts:

- the **workbench**: the VS Code user interface itself (editor, file explorer, search, extensions view), the
  official VS Code web build published by Microsoft;
- this project's **extension**, which connects the workbench to Gitea: it reads files through Gitea's API,
  keeps your edits, and commits them.

VS Code runs extensions, including this one, in the **extension host**: a separate hidden frame and worker in
the same browser tab.

Features:

- Local saves in browser storage; an explicit commit creates one Gitea commit.
- Branches, staging, protected-branch handling, pull request creation and remote change detection.
- Search over the repository and your pending changes, and TypeScript and JavaScript language features.
- Extensions from [Open VSX](https://open-vsx.org) (web extensions only), with an optional operator allowlist.
- A virtual shell (**Gitea: Open Shell**) over your pending changes, with no process execution.
- Native VS Code Settings Sync, stored in your own Gitea account.
- Sign in with Gitea OAuth (silent re-sign-in from your Gitea web session) or a personal access token.

## Requirements

- **Gitea**: the test suites run against Gitea 1.24.6; the local demo instance (`npm run instance:start`) runs
  28.2.0. Other versions are untested. Settings Sync needs Gitea 1.24 or later.
- **Browsers**: Chromium, Firefox and WebKit (Safari's engine). The editor needs service workers and
  cross-origin isolation, which browsers allow only over HTTPS or on `http://localhost`, `127.0.0.1` or
  `[::1]`; it refuses to start otherwise.
- **To build from source**: Node.js 22 or newer. The prebuilt release archive needs no Node.
- **To install** (`install.sh`, no Node): a POSIX shell and the usual utilities. `--workbench=download`
  and `--workbench=local` also need `tar`, `gzip` and one of `sha256sum`, `shasum` or `openssl`; `download`
  also needs `curl` or `wget`. The installer's checks of a running Gitea use `curl` when it is present.

## Installation

Installing copies files into Gitea's **custom directory** and needs no change to Gitea itself, except the
`[cors]` setting in the default workbench mode. The steps below explain what each one does.

### Terms used below

- **`GITEA_CUSTOM`**: Gitea's custom directory, where Gitea looks for extra templates and static files. Run
  `gitea help` as the user that runs Gitea and look for `CustomPath` under "DEFAULT CONFIGURATION" (the same
  output shows `ConfigFile`, the `app.ini` in use). In the official Docker image it is `/data/gitea`, in the
  rootless Docker image `/var/lib/gitea/custom`. The directory must exist.
- **`ROOT_URL`**: the public address of your Gitea, exactly as set by `ROOT_URL` in the `[server]` section of
  Gitea's `app.ini`, for example `https://git.example.com/`. If Gitea is served under a sub-path, the sub-path
  is part of it: with `ROOT_URL = https://git.example.com/git/`, pass `https://git.example.com/git/`. The
  editor builds every link and API call from this value, so it must match.
- **Workbench source**: where browsers get the VS Code workbench (see step 2).
- **OAuth application**: a registration in Gitea that lets the editor sign users in through Gitea's own login
  page, so nobody pastes a token (see step 3).
- **Personal access token (PAT)**: a password-like token a user creates in Gitea under **Settings >
  Applications > Manage Access Tokens**. The editor accepts one when there is no OAuth application, or when a
  user prefers it. For reading and committing, give it the `repository` permission as Read and Write; Settings
  Sync also needs `user` as Read and Write.
- **Gallery**: the extension marketplace the Extensions view searches, by default Open VSX.

### 1. Get the release

The release is a directory, `gitea-dev/`, with the installer (`install.sh`), the editor files, Gitea's template
for the Web IDE tab, and `workbench.json`, which pins the exact workbench build by commit and SHA-256 checksum.
It contains no Microsoft code.

Either download a prebuilt archive and check it:

```sh
sha256sum -c gitea-dev-VERSION.tar.gz.sha256
tar -xzf gitea-dev-VERSION.tar.gz
```

or build it from source (writes `dist/gitea-dev/`; `npm run package` packs it as an archive):

```sh
npm ci --ignore-scripts
npm run build
```

### 2. Choose a workbench source

Microsoft's license for the workbench does not allow redistributing it, so the release does not include it.
The installer's `--workbench` option decides where browsers get it. Every mode uses the same pinned build.

| Mode | What happens | Choose it when | Requirements |
| --- | --- | --- | --- |
| `cdn` (default) | Browsers load the workbench from Microsoft's CDN, `https://main.vscode-cdn.net/stable/<commit>/`, on every load. Nothing from Microsoft is installed. | Users' browsers can reach the internet and you want the smallest install. | Gitea on HTTPS; `[cors]` enabled in Gitea's `app.ini`; browsers can reach `*.vscode-cdn.net`. |
| `download` | The installer downloads Microsoft's archive once, checks it against the pinned SHA-256, and installs it into `GITEA_CUSTOM`; Gitea serves it. | Browsers must not contact Microsoft, but the install host can. | The install host can reach `vscode.download.prss.microsoft.com`. |
| `local` | As `download`, from an archive file you supply with `--workbench-archive=PATH`. | Air-gapped sites. | The archive named by `url` in the release's `workbench.json`, copied to the install host; it must match the pinned SHA-256. |

Trade-offs:

- **Privacy**: in `cdn` mode Microsoft's CDN sees each user's IP address on every load, and the extension host
  address names your Gitea origin. In `download` and `local` modes browsers contact only Gitea (and the gallery,
  if enabled).
- **Availability**: `cdn` mode depends on Microsoft's CDN being reachable; the other modes depend only on Gitea.
- **Extension isolation and network restriction**: in `cdn` mode the extension host runs on a
  `*.vscode-cdn.net` address, so extensions do not share the Gitea web session; but Microsoft's page allows
  extensions to connect to any `https:` host, so `--connect-src` does not apply. In `download` and `local`
  modes extensions run on the Gitea origin and can use the user's Gitea web session, but can connect only to
  Gitea, the gallery and `--connect-src` hosts. See [Security model](#security-model).
- **Chromium on intranets**: in `cdn` mode Chromium may ask users for permission to access the local network,
  because a public page (the CDN extension host) calls an intranet Gitea.

For `cdn` mode, add this to Gitea's `app.ini` and restart Gitea. It lets the extension host on
`*.vscode-cdn.net` load the extension from Gitea and call Gitea's API with the user's token (no cookies):

```ini
[cors]
ENABLED = true
ALLOW_DOMAIN = https://*.vscode-cdn.net
METHODS = GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
HEADERS = Content-Type,User-Agent,Authorization
ALLOW_CREDENTIALS = false
```

WebKit (Safari) blocks requests from the HTTPS extension host to an `http` Gitea, so `cdn` mode requires an
`https` `ROOT_URL`.

### 3. Register the OAuth application (optional)

Skip this step to let users sign in with personal access tokens only.

The OAuth application lets the editor sign a user in through Gitea: a Gitea sign-in popup asks the user once to
allow access, and later loads sign in silently while the user is signed in to Gitea. The editor is a **public
client**: it runs in the browser, cannot keep a secret, and proves itself with PKCE instead.

In the Gitea web UI, as an administrator, open **Site Administration > Integrations > Applications**
(`<ROOT_URL>/-/admin/applications`). An application there belongs to the instance rather than to one user,
which suits a site-wide editor. Without administrator rights, any user can create the same application under
**Settings > Applications** (`<ROOT_URL>/user/settings/applications`); it then belongs to that user's account.
Under **Create a new OAuth2 Application**, fill in:

| Field | Value |
| --- | --- |
| Application Name | Any name users will recognize on the consent page, for example `Gitea Web IDE`. |
| Redirect URIs | `<ROOT_URL>/assets/gitea-dev/oauth-callback.html`, for example `https://git.example.com/git/assets/gitea-dev/oauth-callback.html`. |
| Confidential Client | Uncheck it (Gitea checks it by default): the editor is a public client and has no secret. |
| Skip authorization for public clients after granting access once | Check it (Gitea enables it only once Confidential Client is unchecked): after the first consent, Gitea sends a signed-in user straight back, which is what makes the silent sign-in on each load work. Without it Gitea shows the consent page every time. |

Click **Create Application** and copy the **Client ID**; it is the value of `--oauth-client-id`. The client
secret Gitea shows is not used.

The same application through Gitea's API, with the credentials of the account that should own it:

```sh
curl -u USER -H 'Content-Type: application/json' \
  -d '{"name":"Gitea Web IDE","confidential_client":false,"skip_secondary_authorization":true,"redirect_uris":["https://git.example.com/git/assets/gitea-dev/oauth-callback.html"]}' \
  https://git.example.com/git/api/v1/user/applications/oauth2
```

`-u USER` makes curl ask for that user's password. Instead of a password you can pass a personal access token
with the `user` permission as Read and Write: `-H "Authorization: token TOKEN"`. The response's `client_id` is the
value for `--oauth-client-id`.

### 4. Run the installer

```sh
sh gitea-dev/install.sh GITEA_CUSTOM ROOT_URL [OPTIONS]          # prebuilt release
sh dist/gitea-dev/install.sh GITEA_CUSTOM ROOT_URL [OPTIONS]     # release built from source (npm run build)
```

Run it as the user that owns `GITEA_CUSTOM`. Before writing anything, the installer checks every argument, the
custom directory, Gitea's `app.ini` (`GITEA_CUSTOM/conf/app.ini`, or `--app-ini`), the workbench archive, and,
when Gitea answers at `ROOT_URL`, that it is Gitea with that `ROOT_URL`, that `[cors]` admits the CDN in `cdn`
mode, and that the OAuth application exists, is public and has the redirect URI. It prints every problem it
finds, one line each with the value found and the value expected, and changes nothing. When Gitea does not answer
(for example before its first start), it notes which checks it skipped and goes on.

It then writes:

- `GITEA_CUSTOM/public/assets/gitea-dev/`: the start page, the service worker, `configuration.json` with your
  settings, and a versioned directory with the editor, its extension and, in `download` and `local` modes, the
  workbench. Gitea serves these at `<ROOT_URL>/assets/gitea-dev/`.
- `GITEA_CUSTOM/templates/custom/extra_tabs.tmpl`: the template that adds the **Web IDE** tab to repository
  pages, and `public/assets/gitea-dev/shortcut.js`, the `.` key handler. The installer never overwrites a
  different existing copy of either; merge your changes and rerun.

Examples:

```sh
# CDN workbench, OAuth sign-in
sh gitea-dev/install.sh /var/lib/gitea/custom https://git.example.com/ --oauth-client-id=CLIENT_ID

# Workbench downloaded once and served by Gitea
sh gitea-dev/install.sh /var/lib/gitea/custom https://git.example.com/ --workbench=download --oauth-client-id=CLIENT_ID

# Air-gapped: archive copied in, no gallery
sh gitea-dev/install.sh /var/lib/gitea/custom https://git.example.com/ --workbench=local \
  --workbench-archive=/tmp/vscode-web.tar.gz --gallery=off
```

Rerunning with other options reconfigures the installation in place.

### 5. Restart Gitea if needed, and check

Gitea loads templates when it starts (in production mode), so restart it after the first install or when
`extra_tabs.tmpl` changed, and after editing `app.ini`. Static files need no restart.

To check: `<ROOT_URL>/assets/gitea-dev/configuration.json` shows your settings; a repository page shows the
**Web IDE** tab; clicking it opens the editor with the repository's files in the Explorer.

## Usage

- **Open**: click **Web IDE** on a repository page, or press `.` (not while typing in a field or dialog).
  The editor opens the current branch, tag or commit; on a pull request page it opens the head branch (the
  fork's, for a fork) or the head commit when the branch is gone.
- **Sign in** (public repositories need none): **Gitea: Sign In with OAuth**, or **Gitea: Sign In with
  Personal Access Token**. Committing needs `write:repository` (a read-only token reads but its writes get 403,
  [docs/testing.md](docs/testing.md)); Settings Sync needs `read:user` and `write:user`.
- **Edit and save**: saves stay in the browser, survive a reload, and appear in Source Control.
  **Gitea: Discard Changes** and **Gitea: Discard All Changes** drop them.
- **Commit**: in Source Control, stage files (or leave everything unstaged to commit all), type a message and
  press Ctrl+Enter or click **Commit** (enabled while changes are pending; its drop-down has **Commit to New
  Branch**). A note under the box names the branch that receives the commit, or says that a tag or commit
  is read-only. The **...** menu groups the rest: **Checkout to...**, **Fetch**, and the **Commit**, **Changes**
  and **Branch** submenus. One commit lands on the opened branch. If the remote head or a file changed meanwhile, the editor
  reports the conflict and keeps your changes.
- **Branches and pull requests**: click the branch in the status bar to switch branch or tag
  (**Gitea: Checkout to...**), **Gitea: Create Branch**, and **Gitea: Commit to New Branch**; a protected
  branch that refuses a commit offers a new branch automatically. **Gitea: Create Pull Request** opens a pull
  request. While the window is focused the editor polls the branch head and offers **Update** when it moves.
- **Search**: Quick Open and Find in Files cover the repository and your pending changes. The first text
  search downloads the commit's archive from Gitea and keeps it in IndexedDB.
- **Language features**: TypeScript and JavaScript use the bundled browser language service. Other languages
  need web extensions.
- **Shell**: **Terminal > New Terminal** (or the **Open Gitea Shell** button in the empty Terminal panel, or **Gitea: Open Shell**) opens a terminal with a bash interpreter over `/workspace`, the repository.
  Writes go to your pending changes; nothing is committed and no process or network is available (`curl`,
  `python`, `node` and `git` are absent). The overlay cannot store links, file modes or modification times.
- **Files**: Git LFS files open read-only with their real content; symlinks inside the repository follow to their
  target; submodules are listed but cannot be opened.
- **Theme**: the editor follows your Gitea theme as light or dark.
- **Settings Sync**: turns on by itself after sign-in and stores your settings, keybindings, snippets, tasks and
  extension list in your Gitea user Actions variables (`WEBIDE_SYNC_*`). Turn it off in the native Settings
  Sync UI and it stays off.
- **Extensions**: use the Extensions view to search Open VSX and install web extensions. Installations persist in
  the browser profile; updates are manual. Only web extensions run: the extension host is a web worker that
  loads an extension's `browser` entry, so an extension with only `main`, Node-based extensions, desktop
  executables and arbitrary `.vsix` uploads do not work. The host also rejects ES-module entries (`.mjs`, or
  `"type": "module"` without a `.cjs` entry). Themes, snippets and browser formatters and language services work.
  In `download` and `local` modes extensions can connect only to Gitea, the gallery and `--connect-src` hosts.

Behavior details and limits are in [plan.md](plan.md#behavior-reference); sync details are in
[docs/settings-sync.md](docs/settings-sync.md).

## Configuration

### Installer arguments

`install.sh` takes these arguments. Options are
written `--name=value` or `--name value`. To change a setting, rerun the installer with all the options you
want; do not edit the installed files.

| Argument | Default | What it does | When to use it |
| --- | --- | --- | --- |
| `GITEA_CUSTOM` (first) | required | Gitea's custom directory, where the files are installed. It must exist, be writable, and be empty or hold Gitea's `conf`, `public`, `templates` or `options`. | Always. Find it with `gitea help` (`CustomPath`). |
| `ROOT_URL` (second) | required | Gitea's public address, equal to `[server] ROOT_URL` in `app.ini`: `https://host[:port][/sub/path]`, or `http` on `localhost`, `127.0.0.1` or `[::1]`; lowercase host, plain path. Must be `https` with `--workbench=cdn`. | Always. |
| `--workbench=cdn\|download\|local` | `cdn` | Where browsers get the workbench ([step 2](#2-choose-a-workbench-source)). | `download` or `local` to keep browsers from contacting Microsoft. |
| `--workbench-archive=PATH` | none | The workbench archive file; it must match the SHA-256 pinned in `workbench.json`. Required by `--workbench=local`, refused otherwise. | Air-gapped installs. |
| `--oauth-client-id=ID` | none | Enables **Sign In with OAuth** with this OAuth application ([step 3](#3-register-the-oauth-application-optional)): 1-128 letters, digits or hyphens. | When you registered the OAuth application. Without it users sign in with a personal access token. |
| `--gallery=URL\|off` | `https://open-vsx.org` | The extension gallery the Extensions view uses, which browsers contact directly. `off` disables installing extensions. | `off` on air-gapped sites or to forbid extensions; a URL for a private Open VSX instance. |
| `--extensions-allowlist="publisher.name ..."` | all | Only these gallery extensions are listed and downloadable. Ids are lowercased, separated by spaces, tabs, newlines or commas; an empty list is refused. | To limit extensions. Enforced by the browser, so not a security boundary ([Security model](#security-model)). |
| `--connect-src="SOURCE ..."` | none | Extra hosts extensions may connect to: `https://host[:port][/path]`, `wss://`, or loopback `http://`/`ws://`; a leading `*.` needs two more labels. Refused with `cdn`, where Microsoft's extension host page allows any `https:` host. | `download` or `local`, when an extension needs a service. |
| `--webviews=disabled\|vscode-cdn` | `vscode-cdn` with `cdn`, else `disabled` | Webviews are the panels extensions draw with HTML (Markdown preview, extension pages). `vscode-cdn` hosts them on Microsoft's `https://*.vscode-cdn.net`; `disabled` shows a page saying they are unavailable. | `vscode-cdn` with `download` or `local` if you accept that browsers contact Microsoft for webviews. |
| `--app-ini=PATH` | `GITEA_CUSTOM/conf/app.ini` if present | The `app.ini` Gitea runs with, for the installer's checks of `ROOT_URL` and `[cors]`; the installer never changes it. | When Gitea's configuration is elsewhere (`ConfigFile` in `gitea help`, for example `/etc/gitea/app.ini`). |

Webviews in detail: they always run on their own `*.vscode-cdn.net` origin, with no access to the Gitea page,
its cookies or the editor's stored secrets (`tests/browser/webviews.spec.ts`). With `download` and `local`, the
built-in Markdown preview opens but stays empty, because its styles and scripts come from Gitea, whose static
files lack the `Cross-Origin-Resource-Policy` header the webview page requires; webviews with inline content
work. With `cdn` those files come from the CDN, and the preview renders in Chromium and WebKit; in Firefox it
appeared empty in testing.

### `configuration.json`

The installer writes `GITEA_CUSTOM/public/assets/gitea-dev/configuration.json`, which the start page reads. The
same values are also built into the start pages and the service worker, so rerun the installer instead of
editing it.

| Field | Meaning |
| --- | --- |
| `instance` | `ROOT_URL` without the trailing slash; editor links must point to this origin and sub-path |
| `version` | Directory holding this release's editor, extension and, with `download` or `local`, the workbench |
| `oauthClientId` | `--oauth-client-id`, or `null` |
| `gallery` | Gallery address, or `null` when disabled |
| `extensionsAllowlist` | Lowercase `publisher.name` ids, or `null` for all |
| `connectSrc` | `--connect-src`, space-separated |
| `webviews` | `disabled` or `vscode-cdn` |
| `workbench` | `https://main.vscode-cdn.net/stable/<commit>/` with `cdn`, else `null` (the workbench is under `version`) |
| `testMode` | `false`; the browser test harness sets it |

### Editor settings

Set in the editor's Settings UI or `settings.json` (`packages/gitea-vscode-web/package.json`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `giteaWebIde.autoFetch.enabled` | `true` | Poll the remote branch head while the window is focused; updating always asks |
| `giteaWebIde.autoFetch.interval` | `60` | Seconds between checks (minimum 15) |
| `gitea.archive.prefetch` | `onSearch` | When to download the commit archive: `onSearch`, `onOpen` or `off` |
| `gitea.archive.maxRepositoryMiB` | `128` | Largest total file size for which the archive is fetched |
| `gitea.archive.maxFiles` | `50000` | Largest file count for which the archive is fetched |
| `gitea.archive.maxFileMiB` | `25` | Larger files are left out of the archive cache and read individually |
| `gitea.archive.maxDownloadMiB` | `128` | Largest compressed download |
| `gitea.archive.idleTimeoutSeconds` | `30` | Abort when no data arrives for this long |
| `gitea.archive.startTimeoutSeconds` | `120` | How long to wait for Gitea to build the archive |
| `gitea.archive.cacheMiB` | `512` | Total size of stored archives; least recently used removed first |

## Security model

**Extensions are trusted code**, as in desktop VS Code: install only extensions you trust. Opening a repository
cannot install an extension (workspace recommendations are disabled). What an extension can reach depends on
the workbench mode:

| | `download`, `local` | `cdn` |
| --- | --- | --- |
| Where extensions run | On the Gitea origin, in a frame served by Gitea | On `https://<id>.vscode-cdn.net`, in Microsoft's extension host page |
| Gitea web session | Usable: an extension can load Gitea pages with the user's session cookie, CSRF token included, so an extension in an administrator's editor can use site administration | Not usable: requests to Gitea carry no cookies |
| Stored personal access token | An extension can decrypt it from the editor's browser storage | Not tested |
| Extension network access | Only Gitea, the gallery and `--connect-src` hosts (CSP) | Any `https:` or `wss:` host and loopback (Microsoft's page CSP) |
| Microsoft at runtime | Not contacted (webviews excepted when `--webviews=vscode-cdn`) | Every load: workbench files, and the extension host page, whose address names the Gitea origin |

In every mode, all extensions share one extension host with the editor's own extension, which holds the user's
Gitea token, and any extension can ask it for a Gitea session (the `gitea` authentication provider, used by
Settings Sync).

- **The allowlist is advisory.** The editor hides other extensions and refuses their downloads, and the
  workbench disables installed extensions that left the list, but the browser enforces this, so a user can
  bypass it. It is not a security boundary.
- **Tokens** are never put in links or settings. OAuth tokens stay in memory, so signing out of Gitea ends editor
  access on the next load. A personal access token is kept in the browser's IndexedDB (`gitea-web-ide-secrets`),
  encrypted with AES-GCM under a key the page cannot export, so sign-in survives a reload. Script on the editor
  origin can still use that key, so this protects data at rest, not against extensions on that origin.
  **Gitea: Sign Out** clears local credentials and disables silent sign-in until the next interactive sign-in;
  revoke an OAuth grant in Gitea user settings.
- **What Gitea sees**: API calls with the user's token, commit archive downloads, a page request to read the
  user's theme, and Settings Sync data in `WEBIDE_SYNC_*` user Actions variables (gzip, not encrypted; visible
  in the user's settings when Actions is enabled). Telemetry is off. Pending edits reach Gitea only through a
  commit.
- **Isolation**: the editor page is cross-origin isolated, with a restrictive Content Security Policy set by the
  editor's service worker. Only the extension host frame allows `'unsafe-eval'`, which the workbench's extension
  loader needs; in `cdn` mode that frame is Microsoft's page with Microsoft's policy.

Design and requirements: [plan.md](plan.md). A session bridge (sign-in from the Gitea session, no token in the
browser) would need a Gitea backend patch and is not built: [docs/session-bridge.md](docs/session-bridge.md).

## Upgrading and uninstalling

**Upgrade the editor**: rebuild (or take a new archive) and rerun the installer with the same options. Each
release has its own `<12 hex>-<12 hex>` directory under `$GITEA_CUSTOM/public/assets/gitea-dev/`; earlier version
directories stay for open sessions and can be deleted later. Restart Gitea only if the template changed.

**Upgrade the workbench**: review a new official VS Code web release, then replace `version`, `commit`, `url`
and `sha256` in `config/workbench.json` together, build and install again (with `--workbench=local`, pass the new
archive). To roll a deployment back, restore the previous pin, rebuild and reinstall.

**Uninstall**: delete `$GITEA_CUSTOM/public/assets/gitea-dev/` (it holds `shortcut.js` too) and
`$GITEA_CUSTOM/templates/custom/extra_tabs.tmpl` (only the Web IDE part, if you merged it into another
template), then restart Gitea. Delete the OAuth application in Gitea; users can delete the `WEBIDE_SYNC_*`
variables in their Gitea settings and clear the site data in their browsers.

## Development

```sh
npm run build 2>&1 | tee -a ./build.log
npm run typecheck 2>&1 | tee -a ./build.log
npm test 2>&1 | tee -a ./build.log
npm run test:integration 2>&1 | tee -a ./build.log
npx playwright install chromium firefox webkit
npm run test:browser 2>&1 | tee -a ./build.log
```

Suites, prerequisites, the disposable Gitea fixtures and what is not covered: [docs/testing.md](docs/testing.md).

**Workbench assets.** `config/workbench.json` pins the official standalone web archive
(`vscode-web.tar.gz`, release 1.143.1) by version, commit, URL and SHA-256; `latest` is never resolved. The
archive, not VS Code Server (which contains a remote agent), is used. The build only copies the pin into the
release; the installer fetches and verifies the workbench. For development and tests, the asset provider caches the
pinned archive in `data/vscode-web/`: it requires the browser workbench bundle, the extension-host worker and
its iframe page, rejects server layouts, remote-agent files and native executables
(`packages/asset-provider/src/validate.ts`), and checksum-verifies every archive before extraction. The browser
test harness installs with `--workbench=local` from `data/vscode-web/downloads/<sha256>.tar.gz` when it
exists, else with `--workbench=download` (`scripts/cached-workbench.mjs`).

```sh
npm run assets -- warm        # download and install the pin
npm run assets -- status
npm run assets -- validate
npm run assets -- bundle /path/to/offline-workbench   # destination must not exist
npm run assets -- rollback FULL_INSTALLED_COMMIT
npm run assets -- prune
```

Design notes on the cache and locks are in [plan.md](plan.md#workbench-assets). `BROWSER_WORKBENCH=cdn` runs the
browser suite in `cdn` mode, which needs internet ([docs/testing.md](docs/testing.md#cdn-mode)).

**Local Gitea instance.** The local installation runs Gitea 28.2.0 with SQLite at `http://localhost:3000`, serving
the editor itself in `cdn` mode (browsers load the workbench from Microsoft's CDN, so the machine needs internet;
`[cors]` is enabled in its `app.ini`), with the OAuth application registered automatically and the demo repositories
`web-ide-demo` (public) and `private-demo`, owned by the administrator:

```sh
npm run instance:start
npm run instance:status
npm run instance:stop
```

The administrator credentials are in `data/local-gitea/credentials.json`. Database, repositories, configuration and
logs persist under `data/local-gitea/`. The services bind to loopback only. Run `instance:start` again after a
machine or WSL restart. The Gitea binary URL and checksum are pinned in `config/gitea-instance.json`; build the
project before the first start, because `instance:start` installs the current build.

Repository layout: `packages/` (asset-provider, editor-host, gitea-repository, gitea-vscode-web),
`gitea/custom/` (Gitea template and shortcut script), `scripts/`, `tests/`, `docs/`.
The Gitea client library is described in [packages/gitea-repository/README.md](packages/gitea-repository/README.md).

## License

[MIT](LICENSE). The release archive contains no Microsoft code. just-bash, bundled into the extension, is
Apache-2.0 (`node_modules/just-bash/package.json`). The VS Code web workbench is Microsoft's, under the terms in
the `LICENSE` file of its archive: in `download` and `local` modes the installer installs it into
`$GITEA_CUSTOM`, and in `cdn` mode browsers load it from Microsoft.
