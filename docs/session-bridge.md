# Gitea session bridge

This document is the contract for an optional session bridge: a Gitea backend patch that lets the editor use the signed-in web session instead of a token. The bridge is not built, and no Gitea build implements it. `GiteaSessionBridgeAuth` (`packages/gitea-repository/src/auth/session-bridge.ts`) probes for the bridge and fails closed: against stock Gitea it throws `SessionBridgeUnavailableError` (`code: 'unsupported'`), and it never falls back to a PAT, OAuth token, cookie-only request, or any other credential. The editor extension does not use this adapter: it is only exported from `packages/gitea-repository/src/index.ts`, and sign-in uses OAuth PKCE or a PAT (`packages/gitea-vscode-web/src/auth.ts`).

## Why stock Gitea cannot do this

Evidence is from the v1.24.6 source tarball (`https://codeload.github.com/go-gitea/gitea/tar.gz/refs/tags/v1.24.6`).

| Claim | Source |
| --- | --- |
| The API auth group is OAuth2 (Bearer or `token` header, or `access_token` query), HTTPSign, Basic, and optional reverse-proxy auth. It has no session method. | `routers/api/v1/api.go:774-789` |
| `auth.Session` is registered only for the web router. | `routers/web/web.go:108` |
| The Authorization header accepts `token <x>` or `bearer <x>`. | `services/auth/oauth2.go:99-102` |
| The CSRF header name is `X-Csrf-Token`. | `services/context/csrf.go:33` |
| `routers/api/v1/api.go` has no CSRF reference (`grep -i csrf` finds none); contents mutations only require `reqToken()`. | `routers/api/v1/api.go:1414-1423` |

A static `$GITEA_CUSTOM` template therefore cannot reuse the web login for `/api/v1`. A cookie-bearing `fetch` to `/api/v1` is anonymous.

## Contract, version 1

The bridge is a small backend change. Everything below is a requirement on that change, not something stock Gitea provides.

### Descriptor endpoint

`GET {instance}/-/web-ide/session`, sent with `credentials: 'same-origin'`, no `Authorization` header.

| Status | Meaning | Client result |
| --- | --- | --- |
| 200 + JSON below | Signed in, bridge available | CSRF header returned |
| 401 or 403 | Not signed in | `RepositoryError('unauthenticated')` |
| 404, 5xx, network error, bad JSON, wrong `version`, bad token shape | No bridge | `SessionBridgeUnavailableError` |

```json
{ "version": 1, "csrfToken": "<16-512 printable ASCII>", "expiresIn": 600 }
```

- `csrfToken` is bound to the session, is not an API credential, and must not authorize anything without the session cookie.
- `expiresIn` is optional, in seconds. The client caches the descriptor for at most 5 minutes and re-probes after `invalidate()`, `logout()` or expiry.
- The path is configurable with `descriptorPath`.

### Authenticated operations

With the bridge, `HttpGiteaRepository` sends the same requests it sends to stock Gitea, with the provider's `credentials: 'same-origin'` and header `X-Csrf-Token: <csrfToken>` instead of `Authorization`. The patched server must authenticate these from the session cookie, and only for this allowlist:

| Method | Path below `/api/v1` | Purpose |
| --- | --- | --- |
| GET | `/repos/{owner}/{repo}` | permissions, archived, mirror, empty |
| GET | `/repos/{owner}/{repo}/branches/*` | branch head, `user_can_push` |
| GET | `/repos/{owner}/{repo}/tags/*` | tag target |
| GET | `/repos/{owner}/{repo}/git/commits/{sha}` | root tree id |
| GET | `/repos/{owner}/{repo}/git/trees/{sha}` | directory listing |
| GET | `/repos/{owner}/{repo}/git/blobs/{sha}` | file content |
| GET | `/repos/{owner}/{repo}/raw/*?ref=` | blobs above the API size limit |
| POST | `/repos/{owner}/{repo}/contents` | one atomic multi-file commit |

### Server requirements

1. Use the existing session user as `ctx.Doer` and run the normal repository permission checks (`reqRepoReader`, `reqRepoBranchWriter`, `mustNotBeArchived`, branch protection). No bridge-specific permission model.
2. Reject any route or method outside the allowlist when authenticated by session.
3. Require a valid `X-Csrf-Token` on every non-GET request, compared in constant time against the session's CSRF token.
4. Check `Origin` or `Sec-Fetch-Site` and reject cross-site requests. Send no permissive CORS headers for session-authenticated responses.
5. Never return a reusable access token, and never put the CSRF token in a URL.
6. Do not enable force-push or accept `new_branch` from this path unless a later contract version adds it.

### Patch targets (v1.24.6)

- `routers/api/v1/api.go:774-789` (`buildAuthGroup`): add a session-based method restricted to the allowlist.
- `routers/api/v1/api.go:1414-1423`: CSRF validation for the contents mutation under session auth.
- A new route for the descriptor, outside `/api/v1`.

Open: how to validate CSRF inside `APIContexter`, since `services/context/csrf.go` is wired for the web context. A patched Gitea tree is needed to settle it.

## Client behavior

- `headers()` returns `{ 'X-Csrf-Token': ... }` only. `credentials` is `'same-origin'`, which `HttpGiteaRepository` forwards to `fetch`.
- `logout()` forgets the CSRF token. The Gitea web session is ended in Gitea.
- Concurrent callers share one probe. Failures are not cached.

## Choosing a mode

| Mode | Works on stock Gitea | Credential in browser JS |
| --- | --- | --- |
| `OAuthPkceAuth` | Yes, after one OAuth app registration (public client, redirect URI registered) | Access token, held in memory only (`auth.ts` `#oauthTokens`); the Gitea session restores it silently when the app has `skip_secondary_authorization` |
| `PersonalAccessTokenAuth` | Yes | Token held in memory by the adapter; the extension also keeps it in the editor's secret store (`auth.ts`) |
| `GiteaSessionBridgeAuth` | No, needs the patch above or an accepted upstream change | None |

Gitea v1.24.6 OAuth facts used by `OAuthPkceAuth`: public clients must use PKCE (`routers/web/auth/oauth2_provider.go:243-274`); the token endpoint is `POST /login/oauth/access_token` (`routers/web/web.go:573`) and supports `authorization_code` and `refresh_token` grants (`oauth2_provider.go:513-521`); there is no token revocation route, so `logout()` is local only and grants are revoked in Gitea user settings. Since 1.22 OAuth tokens grant full API access, so scope cannot narrow them (`services/oauth2_provider/access_token.go:92`). The token endpoint only answers cross-origin requests when `[cors]` is enabled for the editor origin; serving the editor from the Gitea origin avoids this.
