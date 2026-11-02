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

- **Gitea or Forgejo**: the test suites run against Gitea 1.24.6; the local demo instance (`npm run instance:start`)
  runs 28.2.0. The installer and the Web IDE tab were also run against Gitea 1.21.11, 1.22.6 and 1.23.8 and Forgejo
  11 and 12 (a disposable server for each; no browser suite). Differences by version:
  - Gitea before 1.23 and Forgejo have no "skip authorization" option for OAuth applications. Users approve an
    authorization page at each sign-in, and the editor does not sign in on load: the first commit offers **Sign In**.
  - Gitea before 1.24 does not tell templates the viewed ref; the tab takes it from the older variables. Forgejo
    and Gitea 1.21 have no `ctx.Consts`; the tab takes the code unit from `UnitTypeCode`.
  - Settings Sync needs Gitea 1.24 or later.
- **Browsers**: Chromium, Firefox and WebKit (Safari's engine).
- **HTTPS**: serve Gitea over HTTPS. Plain `http` works on `localhost`, `127.0.0.1` and `[::1]`.
- **To build from source**: Node.js 22 or newer. The prebuilt release archive needs no Node.
- **To install** (`install.sh`, no Node): a POSIX shell and the usual utilities, `tar`, `gzip` and one of
  `sha256sum`, `shasum` or `openssl`; `--workbench=download` (the default) also needs `curl` or `wget`. The installer's checks of a running Gitea use `curl` when it is present.

## Installation

Installing copies files into Gitea's **custom directory** and needs no change to Gitea itself.

### Terms used below

- **`GITEA_CUSTOM`**: Gitea's custom directory, where Gitea looks for extra templates and static files. Run
  `gitea help` as the user that runs Gitea and look for `CustomPath` under "DEFAULT CONFIGURATION" (the same
  output shows `ConfigFile`, the `app.ini` in use). In the official Docker image it is `/data/gitea`, in the
  rootless Docker image `/var/lib/gitea/custom`. The directory must exist.
- **`ROOT_URL`**: the public address of your Gitea, exactly as set by `ROOT_URL` in the `[server]` section of
  Gitea's `app.ini`, for example `https://git.example.com/`. If Gitea is served under a sub-path, the sub-path
  is part of it: with `ROOT_URL = https://git.example.com/git/`, pass `https://git.example.com/git/`. The
  editor builds every link and API call from this value, so it must match. The installer reads it from `app.ini`
  when you leave it out.
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
for the Web IDE tab, `workbench.json`, which pins the exact workbench build by commit and SHA-256 checksum, and
`LICENSE` and `THIRD_PARTY_NOTICES.txt`.

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

The installer installs the pinned VS Code workbench into `GITEA_CUSTOM`, and Gitea serves it. Use the default,
`download`, unless the install host has no internet access.

| Mode | Use it when | Needs |
| --- | --- | --- |
| `download` (default, recommended) | The install host can reach `vscode.download.prss.microsoft.com`. | `curl` or `wget`. |
| `local` | The install host has no internet access. | `--workbench-archive=PATH`: the archive named by `url` in the release's `workbench.json`, copied to the install host. |

Both modes install the same build, checked against the SHA-256 pinned in `workbench.json`.

### 3. Register the OAuth application (optional)

Recommended. With it, users sign in through Gitea: they allow access once, and later loads sign in silently.
Skip this step to have users sign in with personal access tokens.

**Use the administrator UI (A)**, so the application belongs to the instance. B and C create it under one user
account.

| | Way | Owner | Result |
| --- | --- | --- | --- |
| A | Administrator UI (recommended) | the instance | A Client ID to pass with `--oauth-client-id`. |
| B | `install.sh --create-oauth-app` | the token's user | The installer creates or reuses the application and installs its Client ID. |
| C | Gitea API with `curl` | the account you authenticate as | A Client ID to pass with `--oauth-client-id`. |

#### A. Administrator UI (recommended)

As an administrator, open **Site Administration > Integrations > Applications**
(`<ROOT_URL>/-/admin/applications`). Without administrator rights, any user can create the same application under
**Settings > Applications** (`<ROOT_URL>/user/settings/applications`); it then belongs to that user's account.
Under **Create a new OAuth2 Application**, fill in:

| Field | Value |
| --- | --- |
| Application Name | Any name users will recognize on the consent page, for example `Gitea Web IDE`. |
| Redirect URIs | `<ROOT_URL>/assets/gitea-dev/oauth-callback.html`, for example `https://git.example.com/git/assets/gitea-dev/oauth-callback.html`. |
| Confidential Client | Uncheck it (Gitea checks it by default). |
| Skip authorization for public clients after granting access once | Check it (Gitea enables it once Confidential Client is unchecked). |

Click **Create Application** and copy the **Client ID**; it is the value of `--oauth-client-id`. The client
secret Gitea shows is not used.

#### B. Let the installer create it

Give the installer a personal access token in the environment variable `GITEA_TOKEN`, with the `user` permission as
Read and Write, and add `--create-oauth-app` (not together with `--oauth-client-id`):

```sh
GITEA_TOKEN=TOKEN sh gitea-dev/install.sh /var/lib/gitea/custom --create-oauth-app
```

Gitea must be running at `ROOT_URL`. The installer reuses the token owner's application named `Gitea Web IDE`, or
creates one, and prints its Client ID. If the existing application has other settings, the installer says what to
fix and changes nothing.

#### C. Gitea API

With the credentials of the account that should own the application:

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
sh gitea-dev/install.sh GITEA_CUSTOM [ROOT_URL] [OPTIONS]        # prebuilt release
sh dist/gitea-dev/install.sh GITEA_CUSTOM [ROOT_URL] [OPTIONS]   # release built from source (npm run build)
```

Run it as the user that owns `GITEA_CUSTOM`. The installer first checks its arguments, the custom directory,
Gitea's `app.ini` (`GITEA_CUSTOM/conf/app.ini`, or `--app-ini`), the workbench archive and, when Gitea is
running, `ROOT_URL` and the OAuth application. If anything is wrong it prints each problem with the value
expected and changes nothing.

It then writes:

- `GITEA_CUSTOM/public/assets/gitea-dev/`: the start page, the service worker, `configuration.json` with your
  settings, and a versioned directory with the editor, its extension and the workbench. Gitea serves these at `<ROOT_URL>/assets/gitea-dev/`.
- `GITEA_CUSTOM/templates/custom/extra_tabs.tmpl`: the template that adds the **Web IDE** tab to repository
  pages, and `public/assets/gitea-dev/shortcut.js`, the `.` key handler. The installer never overwrites a
  different existing copy of either; merge your changes and rerun.

Examples:

```sh
# Workbench downloaded once and served by Gitea, OAuth sign-in
sh gitea-dev/install.sh /var/lib/gitea/custom https://git.example.com/ --oauth-client-id=CLIENT_ID

# Air-gapped: archive copied in, no gallery
sh gitea-dev/install.sh /var/lib/gitea/custom https://git.example.com/ --workbench=local \
  --workbench-archive=/tmp/vscode-web.tar.gz --gallery=off --webviews=disabled
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
  Extensions can connect to Gitea, the gallery and `--connect-src` hosts.

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
| `ROOT_URL` (second) | `[server] ROOT_URL` of the `app.ini` | Gitea's public address, equal to `[server] ROOT_URL` in `app.ini`: `https://host[:port][/sub/path]`, or `http` on `localhost`, `127.0.0.1` or `[::1]`; lowercase host, plain path. | Leave it out when the `app.ini` is found (see `--app-ini`); the installer reads it and says which value it used. Pass it when `app.ini` has no literal `ROOT_URL`. |
| `--workbench=download\|local` | `download` | Where the installer gets the workbench ([step 2](#2-choose-a-workbench-source)). | `local` when the install host cannot reach the internet. |
| `--workbench-archive=PATH` | none | The workbench archive file; it must match the SHA-256 pinned in `workbench.json`. Required by `--workbench=local`, refused otherwise. | Air-gapped installs. |
| `--oauth-client-id=ID` | none | Enables **Sign In with OAuth** with this OAuth application ([step 3](#3-register-the-oauth-application-optional)): 1-128 letters, digits or hyphens. | When you registered the application in the administrator UI (recommended). Without an OAuth application users sign in with a personal access token. |
| `--create-oauth-app` | off | Finds or creates the public OAuth application `Gitea Web IDE` with the personal access token in the environment variable `GITEA_TOKEN`, and installs its Client ID. The application belongs to the token's user, not the instance. Refused with `--oauth-client-id`. | Only when the administrator UI is not an option ([step 3, B](#b-let-the-installer-create-it)). |
| `--gallery=URL\|off` | `https://open-vsx.org` | The extension gallery the Extensions view uses, which browsers contact directly. `off` disables installing extensions. | `off` on air-gapped sites or to forbid extensions; a URL for a private Open VSX instance. |
| `--extensions-allowlist="publisher.name ..."` | all | Only these gallery extensions are listed and downloadable. Ids are lowercased, separated by spaces, tabs, newlines or commas; an empty list is refused. | To limit extensions. Enforced by the browser, so not a security boundary ([Security model](#security-model)). |
| `--connect-src="SOURCE ..."` | none | Extra hosts extensions may connect to: `https://host[:port][/path]`, `wss://`, or loopback `http://`/`ws://`; a leading `*.` needs two more labels. | When an extension needs a service. |
| `--webviews=vscode-cdn\|disabled` | `vscode-cdn` | Webviews are the panels extensions draw with HTML (Markdown preview, extension pages). `vscode-cdn` hosts them on Microsoft's `https://*.vscode-cdn.net`; `disabled` turns them off. | The default. `disabled` when browsers cannot reach `*.vscode-cdn.net`, or must not contact Microsoft. |
| `--app-ini=PATH` | `GITEA_CUSTOM/conf/app.ini` if present | The `app.ini` Gitea runs with, for the installer's check of `ROOT_URL`; the installer never changes it. | When Gitea's configuration is elsewhere (`ConfigFile` in `gitea help`, for example `/etc/gitea/app.ini`). |

Webviews in detail: they always run on their own `*.vscode-cdn.net` origin, with no access to the Gitea page,
its cookies or the editor's stored secrets (`tests/browser/webviews.spec.ts`). The built-in Markdown preview
opens but stays empty, because its styles and scripts come from Gitea, whose static files lack the
`Cross-Origin-Resource-Policy` header the webview page requires; webviews with inline content work.

### `configuration.json`

The installer writes `GITEA_CUSTOM/public/assets/gitea-dev/configuration.json`, which the start page reads. The
same values are also built into the start pages and the service worker, so rerun the installer instead of
editing it.

| Field | Meaning |
| --- | --- |
| `instance` | `ROOT_URL` without the trailing slash; editor links must point to this origin and sub-path |
| `version` | Directory holding this release's editor, extension and workbench |
| `oauthClientId` | `--oauth-client-id`, or `null` |
| `gallery` | Gallery address, or `null` when disabled |
| `extensionsAllowlist` | Lowercase `publisher.name` ids, or `null` for all |
| `connectSrc` | `--connect-src`, space-separated |
| `webviews` | `vscode-cdn` or `disabled` |
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
cannot install an extension (workspace recommendations are disabled). What an extension can reach:

- **Where extensions run**: on the Gitea origin, in a frame served by Gitea.
- **Gitea web session**: usable. An extension can load Gitea pages with the user's session cookie, CSRF token
  included, so an extension in an administrator's editor can use site administration.
- **Stored personal access token**: an extension can decrypt it from the editor's browser storage.
- **Network access**: only Gitea, the gallery and `--connect-src` hosts (CSP).
- **Microsoft at runtime**: contacted for webviews, unless `--webviews=disabled`.

All extensions share one extension host with the editor's own extension, which holds the user's
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
  loader needs.

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

**Releases.** `.github/workflows/ci.yml` runs typecheck, the unit tests, the build and the packaging on every push to
`main` and every pull request, and uploads the archive as a workflow artifact. A release is a tag named
`v<version>`, where `<version>` is `version` in `package.json`:

```sh
npm version --no-git-tag-version 0.3.0     # edit package.json and package-lock.json
git commit -am "Release 0.3.0"
git push origin main
git tag v0.3.0
git push origin v0.3.0
```

The same workflow runs on the tag. It fails when the tag and `package.json` disagree, then builds and packs as above
and a second job creates a GitHub release with `gitea-dev-v<version>.tar.gz`, its `.sha256` file and generated
notes. Running the CI workflow by hand from the Actions tab with an existing tag as input publishes that tag's
release the same way. A tag with a hyphen (`v0.3.0-rc.1`) is published as a pre-release. The integration and browser
suites are not run in Actions.

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

Design notes on the cache and locks are in [plan.md](plan.md#workbench-assets).

**Local Gitea instance.** The local installation runs Gitea 28.2.0 with SQLite at `http://localhost:3000`, serving
the editor itself with the workbench from the local download cache (`npm run assets -- warm`), or downloaded
when the cache is empty, with the OAuth application registered automatically and the demo repositories
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

[MIT](LICENSE). The release archive contains no Microsoft code. The npm packages bundled into it, among them
just-bash (Apache-2.0) and the packages its browser bundle inlines, are credited with their license texts in the
release's `THIRD_PARTY_NOTICES.txt`; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) covers the Microsoft typings
in this repository. The VS Code web workbench is Microsoft's, under the terms in
the `LICENSE` file of its archive; the installer installs it into `$GITEA_CUSTOM`.
