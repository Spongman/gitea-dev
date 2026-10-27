# Settings Sync

Native Code OSS Settings Sync for the Gitea Web IDE, authenticated by the user's Gitea identity, with no Node service, proxy or Gitea change. The native client (pinned 1.143.1, commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`) does all merging, ignoring and machine-setting logic. This repository provides the store it talks to, an account it can sign in with, and the automatic turn-on.

## Pieces

| Piece | File | Runs in |
| --- | --- | --- |
| Store protocol (routes, preconditions, status codes) | `packages/editor-host/src/sync-handler.ts` | service worker `coi-sw.js`, route `<scope>sync/` |
| Store semantics (manifest generations, chunks, history, collections, limits) | `packages/editor-host/src/sync-store.ts` | same |
| Gitea variables client | `packages/editor-host/src/sync-variables.ts` | same |
| gzip, base64url, chunking | `packages/editor-host/src/sync-codec.ts` | same |
| `configurationSync.store` value | `packages/editor-host/src/sync-config.ts`, used in `bootstrap.ts` | page |
| Native turn-on with default answers | `packages/editor-host/src/sync-turn-on.ts`, host command `giteaHost.syncTurnOn` in `bootstrap.ts` | page |
| `AuthenticationProvider` `gitea` | `packages/gitea-vscode-web/src/sync-auth.ts` | extension (web worker) |
| Automatic turn-on after sign-in, write probe | `packages/gitea-vscode-web/src/sync-auto.ts` | extension |
| Tests | `tests/sync.test.ts`, `tests/sync-store.test.ts`, `tests/integration/sync.test.ts`, `tests/browser/sync.spec.ts` | |

Nothing runs on a server other than Gitea. `coi-sw.ts` answers `/assets/gitea-dev/sync/v1/...` itself; the requests never reach Gitea's static files.

## Where the data lives

In the signed-in user's **user-level Actions variables**, `/api/v1/user/actions/variables[/{name}]` (GET list, GET/POST/PUT/DELETE by name), called by the service worker with the `Authorization: Bearer` header the sync client sends. All names start with `WEBIDE_SYNC_`:

| Variable | Content |
| --- | --- |
| `WEBIDE_SYNC_H` | Hint: the newest manifest generation number. Written after the manifest. |
| `WEBIDE_SYNC_M<n>` | Manifest generation `n`: the whole index (session id, collections, every retained version of every resource as `[ref, created, chunks, size]`, chunks to delete), gzip and base64url. |
| `WEBIDE_SYNC_B<ref>_<i>` | Chunk `i` of one resource version, gzip and base64url, at most 60,000 characters. `ref` is 24 hex digits, the first 8 are the creation time in seconds. |

Write order: upload the chunks, create `M<n+1>` last, then set the hint, delete `M<n>`, delete superseded chunks. Gitea answers `409` to a create of an existing variable, so two writers racing for generation `n+1` cannot both win (verified, see below); the loser re-reads, re-checks `If-Match` against the winner's state and answers `412` if it no longer holds. Readers follow the newest manifest and read only the chunks it names, so they never see a torn write; a chunk pruned under a reader makes it re-read the manifest. Manifest generations never repeat, also after a clear, so a stale writer cannot resurrect cleared data. A crash between uploading and committing leaves unreferenced chunks; a full clear removes those older than an hour (younger ones may be a write in progress). Variables that do not start with `WEBIDE_SYNC_` are never touched. Each resource keeps its latest 2 versions (`DEFAULT_STORE_LIMITS.maxVersions` in `sync-store.ts`): the current one and one previous version for Show Synced Data restore; older versions and their chunks are deleted on the next write.

Payloads are opaque to the store: the client sends `JSON.stringify` of its sync data, which is stored gzipped. Nothing is encrypted.

### Visibility and who can read it

- **Actions disabled (`[actions] ENABLED = false`): invisible.** The API still works and `/user/settings/actions/variables` and `/user/settings/actions` are `404`. Tested on Gitea 1.24.6 (`tests/integration/sync.test.ts`, "with Actions disabled").
- **Actions enabled: the variables show on the user's settings page** (`/user/settings/actions/variables`) as `WEBIDE_SYNC_*` rows (same test file, "with Actions enabled"). Anyone with the user's token can read them through the API, as can the user's Gitea UI.
- **Workflows in the user's repositories may read them: UNPROVEN.** Gitea's page says "Variables will be passed to certain actions and cannot be read otherwise" (text of `/user/settings/actions/variables` on 1.24.6). Whether `${{ vars.WEBIDE_SYNC_* }}` resolves in a repository owned by the user was not tested (no runner in the fixture). The page also says "cannot be read otherwise", yet `GET /user/actions/variables/{name}` returns the value (tests above), so the page text is not a guarantee.
- The payload is gzip, not encrypted. Settings, keybindings, snippets, tasks, extension list and UI state are in it. Do not put secrets in synced settings on an instance where that matters.
- **Extension secrets are not synced.** Sync resources are `settings keybindings snippets prompts tasks mcp extensions globalState profiles machines` (the native "configure" list, `getConfigureSyncQuickPickItems` in the pinned bundle). Secret storage is not among them, and the editor keeps secrets in its own `secretStorageProvider` (`packages/editor-host/src/secret-storage.ts`), outside the workbench storage that the `globalState` resource reads. The browser test decodes every stored payload and asserts the PAT and `secret://` keys are absent.

## Gitea behaviors the store relies on

Asserted by `tests/integration/sync.test.ts` against Gitea 1.24.6.

| Question | Answer | Evidence |
| --- | --- | --- |
| Available on 1.24.6? | Yes: GET list, GET/POST/PUT/DELETE by name. Create answers `204`, a duplicate create `409`. A `404` whose text is `variable not found` means the variable is missing (`sync-variables.ts:61`). | integration "round trip" and "a duplicate create is 409" |
| Older than 1.24 | Not tested (no binary). The store treats a `404` that is not `variable not found`, or a `405`, as "endpoint missing": it answers `405` with a message (the client turns sync off) and the automatic turn-on shows "Settings Sync is unavailable ... Gitea 1.24 or later is required" once and remembers it for 7 days. | `tests/sync-store.test.ts` "a Gitea without the variables API", `tests/sync.test.ts` "a Gitea without the variables API is reported once"; not run against a real old Gitea |
| Value limit | 65,536 characters are accepted; 70,000 give `400 data too long`. | integration "chunks a resource over the 64 KiB variable limit" |
| Variable count limit | None found: 300 variables were created without error. A higher limit is not excluded. | integration "there is no practical limit" |
| Name rules | Letters, digits, underscore, not starting with a digit (`400` for `1ABC`, `A-B`, `A.B`). Names are stored **upper-cased**. `GITEA_` and `GITHUB_` prefixes are rejected (`400`). `WEBIDE_SYNC_` is valid. | integration "names are upper-cased" |
| Token scope | Read: `read:user` or `write:user`. Create, update, delete: `write:user`. `read:user` alone cannot write (`403`); a token with only `write:repository` gets `403` for reads and writes. A PAT with `all` or with `read:user` plus `write:user` works. An OAuth access token from the editor's PKCE flow works. | integration "token scopes", "an OAuth access token from the editor's PKCE flow can sync" |
| `Authorization: Bearer <PAT>` | Accepted on the variables API. | integration "accepts a personal access token as Authorization: Bearer" |

## What the native client needs

Source links are at the pinned commit. `USDS` = `src/vs/platform/userDataSync/common/userDataSyncStoreService.ts`.

- **Store config.** Product key `configurationSync.store` ([product.ts#L271](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/base/common/product.ts#L271)) with `url`, `stableUrl`, `insidersUrl` and `authenticationProviders[id].scopes` ([USDS#L85-L117](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L85-L117)); it requests `<url>v1/...` ([USDS#L217-L219](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L217-L219)). `bootstrap.ts` sets it to `<assets>/sync/` through `syncProductConfiguration` (`sync-config.ts`).
- **`productConfiguration` is deep-merged into Microsoft's defaults** (function `Wp` in the bundle), so a plain `authenticationProviders: { gitea }` would keep `github` and `microsoft`. On web the client spreads a `web` override over the merged object ([USDS#L89-L90](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L89-L90)), which replaces the providers. `syncProductConfiguration` therefore sets the same values at top level and under `web`; `tests/sync.test.ts` replays the merge and asserts `gitea` is the only effective provider.
- **Only declared providers are offered**: the extension manifest contributes `authentication: [{ id: "gitea", label: "Gitea" }]` and `onAuthenticationRequest:gitea`.
- **Token.** The request token is `session.idToken || session.accessToken`, sent as `Authorization: Bearer` plus `X-Account-Type` ([USDS#L566-L571](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L566-L571)). The provider (`sync-auth.ts`) exposes the instance PAT or OAuth token in memory; the account id is the numeric Gitea user id, so the session id `gitea:<id>` is stable across reloads and sign-in methods.
- **Web enablement requires `workspaceProvider.trusted === true`** (`isTrusted` in the web enablement service in the bundle); `bootstrap.ts` sets it.
- `settingsSyncOptions` is left unset: the web enablement service then uses the stored native flag, which the native turn-on and turn-off set and which survives reloads.

## Automatic turn-on

The workbench has no API to enable sync after startup. In the pinned bundle (`out/vs/workbench/workbench.web.main.internal.js`):

- `isEnabled()` of the web enablement service returns `settingsSyncOptions.enabled` when that option is defined, which is read once at startup, and otherwise the stored flag; `setEnablement` is reached only through the workbench service's `turnOn()`, which is reached only through the action `workbench.userDataSync.actions.turnOn` (contribution method `turnOn`: `askToConfigure()` quick pick, then `userDataSyncWorkbenchService.turnOn()` whose `doPick()` shows an account quick pick when the provider has a session).
- Setting `enabled: true` at startup would enable sync before any sign-in, would not persist a native turn-off or a remote "turned off", and has no way to run after a sign-in without a reload.

So `giteaHost.syncTurnOn` (`sync-turn-on.ts`, registered in `bootstrap.ts`) runs that native action and accepts its quick inputs with `workbench.action.acceptSelectedQuickOpenItem` while they are hidden by a style rule (`.quick-input-widget { visibility: hidden }`, in place before the action starts, so nothing is painted). Only quick inputs whose title contains "sync" are accepted. The picker's pre-selection is the native default: all listed resources, including prompts, mcp and profiles (`isResourceEnabled(id, true)`), not a reduced set. The native "Settings Sync is turned on" notification still shows.

`sync-auto.ts` decides when: the provider reports every newly held session (a sign-in, or credentials restored from secret storage at startup, via `provider.refresh()` in `extension.ts`). For an account that has no marker in the extension's `globalState` (`gitea.settingsSync.auto:<instance>:<user id>`) it waits 1.5 s, probes with a create and delete of `WEBIDE_SYNC_PROBE`, and on success records the marker and runs the host command.

| Probe result | Behavior |
| --- | --- |
| Create works (or `409`, the probe variable exists) | marker set, native turn-on runs once |
| `404`/`405` | marker `unsupported:<time>`, warning "Settings Sync is unavailable: ... Gitea 1.24 or later" once; probed again after 7 days (`sync-auto.ts`), so a Gitea upgrade is noticed |
| `403` | warning "needs the read:user and write:user scopes", no marker, so a better token is tried at the next sign-in |
| `401`, network, `5xx` | logged, no marker |

The marker is why the native choice then stays: turning sync off, or another device clearing the cloud (which turns this one off), is never undone automatically. Another Gitea account, or a browser profile with no marker, turns on again. Turn-on failures clear the marker and are retried at the next sign-in.

## Store protocol

Routes are relative to `<scope>sync/v1/`. Behaviors were taken from the client source and the upstream in-memory server of the client's own tests ([userDataSyncClient.ts#L180](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/test/common/userDataSyncClient.ts#L180)). `tests/sync-store.test.ts` has a `NativeClient` that replays the client's request shapes against the handler; it is a reimplementation, not the real client. The browser test runs the real client.

| Route | Client call | Behavior |
| --- | --- | --- |
| `GET manifest` | `manifest` [#L408](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L408) | `200` JSON `{session, latest, collections?, ref}` with `ETag`; `304` on matching `If-None-Match`; `204` plus `ETag: 0` when the user has no data. |
| `GET resource/<name>/latest` | `readResource` [#L348](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L348) | `200` text + `ETag`; `304`; missing resource `204` + `ETag: 0`. |
| `POST resource/<name>` | `writeResource` [#L385](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L385) | `text/plain` body, `200` + new `ETag`. `If-Match` is the last known ref (`0` for a first write); mismatch `412`. No `If-Match` is an unconditional write (`cleanUpRemoteData`). `If-Match: *` and `If-None-Match: *` are supported. |
| `GET resource/<name>` | `getAllResourceRefs` [#L298](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L298) | JSON `[{url, created}]`, newest first, `created` in seconds. |
| `GET resource/<name>/<ref>` | `resolveResourceContent` [#L312](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L312) | `200` text; unknown ref `404`. |
| `DELETE resource/<name>[/<ref>]` | `deleteResource` [#L326](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L326) | Optional `If-Match`; `204`. |
| `DELETE resource` | `deleteResources` [#L337](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L337) | Removes all top-level resources; collections untouched. |
| `GET/POST/DELETE collection` | `getAllCollections`, `createCollection`, `deleteCollection` [#L252-L292](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L252-L292) | List `[{id}]`; create returns a UUID as text; delete all. |
| `DELETE collection/<id>` | `deleteCollection(id)` | Idempotent `204`. |
| `GET\|POST\|DELETE collection/<id>/resource/<name>[/<ref>\|/latest]` | same with a collection | Unknown collection `404`; writes never create a collection. |
| `GET download/latest` | `getLatestData` [#L475](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L475) | `{resources:{<name>:[{ref,content}]}, collections}`; `204` when empty. |
| `GET download` | `getActivityData` [#L525](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L525) | `{resources:{<name>:[{created,content}]}, collections}`. |

Resource names: `settings keybindings snippets prompts tasks mcp extensions globalState profiles machines`; `editSessions` and `workspaceState` return `404`. The manifest `session` is created on the first write and dropped when no data and no collections are left, so other devices see "cleared elsewhere". Refs are random, never reused; `0` is the "no resource" ref.

### Status codes the client reacts to

[USDS#L628-L682](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L628-L682): `401`/`403` drop the client's token and end its session; `405` turns sync off; `409`/`412` retry; `413` is "too large"; `429` with `Retry-After` pauses requests.

| Condition | Status |
| --- | --- |
| Missing or malformed `Authorization: Bearer`, or Gitea `401` | `401` + `WWW-Authenticate: Bearer` |
| Gitea `403` (token scope) | `403` |
| Gitea has no variables API | `405` + message |
| Gitea unreachable, timeout, `429`, `5xx` | `503` + `Retry-After: 5` |
| Gitea refuses a name or value (should not happen) | `502` |
| Unknown route/name/ref/collection | `404` |
| Wrong method (`Allow` header set) | `405` |
| `If-Match`/`If-None-Match` not satisfied | `412` |
| Body not `text/plain` | `415` |
| Empty or non-UTF-8 body, query string, bad precondition header | `400` |
| Over a size or count limit | `413` |
| Stored data unreadable | `500` (never auto-repaired or reset) |

### Limits

| Limit | Default |
| --- | --- |
| One resource body (UTF-8 bytes) | 2 MiB |
| Versions kept per resource | 2 |
| Collections per user | 16 |
| Encoded characters of all retained versions | 8 MiB |
| Manifest (encoded) | 60,000 characters; a larger one gives `413` (`the manifest itself is bounded` test) |

These are this project's limits, not Microsoft's. There is no request-rate limit; the client limits itself to 100 requests per 5 minutes ([USDS#L48-L49](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts#L48-L49)). A request costs a few Gitea calls for the manifest plus one per chunk.

## Security model

- The token is forwarded only to `<instance>/api/v1/user/actions/variables` (`credentials: 'omit'`, `redirect: 'error'`, 15 s timeout), held in memory for the request, never stored, logged or echoed (unit and integration tests check responses, logs and every stored value).
- The service worker only handles requests from pages it controls on the instance origin; every route needs the bearer token.
- Identity is whatever Gitea says the token belongs to; data is per Gitea user because the variables are.
- The worker handles one request at a time; other tabs and devices are covered by the create-only manifest generations.

## Verification and what is not covered

See the test files above. Not covered: a Gitea older than 1.24 (the `405` path is tested against a fake), whether workflows can read the variables, a hostile Actions admin, the OAuth refresh path, one editor with several Gitea instances (the provider is registered for the first open folder's instance), and a crashed write's orphan chunks younger than an hour (kept until a later full clear).
