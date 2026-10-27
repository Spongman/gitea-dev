# @gitea-dev/gitea-repository

Browser-compatible client for the Gitea v1.24.6 REST API. Uses `fetch`, `Uint8Array`, `crypto.subtle`, `AbortSignal` and other Web APIs only. Entry point: `src/index.ts`.

## How reads work

After `initialize()` pins the ref to a full commit id, every read is addressed by git object id:

1. `GET /git/commits/{commit}` gives the root tree id.
2. `GET /git/trees/{sha}` (paged, 1000 per page) lists a directory.
3. `GET /git/blobs/{sha}` gives file content as base64.

`readTree(path)` lists a whole subtree with `GET /git/trees/{sha}?recursive=true` (paged, up to `maxTreeEntries`, 100,000 by default) and fills the directory cache, so later `readDirectory` calls below that path need no request (`src/repository.ts`, `src/recursive-tree.ts`).

Full-length ids are used literally by Gitea (`modules/git/repo_commit_nogogit.go:148-158`, `modules/git/repo_tree_nogogit.go:82-95`), so a branch or tag named like a hash cannot redirect a read. Trees and blobs are immutable by id, so the cache never goes stale and survives `refresh()`.

Blobs above the server's API limit (`setting.API.DefaultMaxBlobSize`, 10 MiB by default) come back with `content: null` (`services/repository/files/content.go:242-248`). Those are read from `GET /raw/{path}?ref={commit}`. That endpoint resolves `ref` and path together and falls back to the default branch for unknown refs (`services/context/repo.go:689-707`), so the bytes are verified against the blob id and the size before use.

## Commit guards on stock Gitea v1.24.6

`POST /repos/{owner}/{repo}/contents` is the only atomic multi-file write. What the official source supports:

- **`last_commit_id` is not exposed.** `FileOptions` (`modules/structs/repo_file.go:10-24`) has `message`, `branch`, `new_branch`, `author`, `committer`, `dates`, `signoff` only. The `ChangeFiles` handler builds `ChangeRepoFilesOptions` without `LastCommitID` (`routers/api/v1/repo/file.go:483-501`). The internal field exists (`services/repository/files/update.go:53`) but no REST path sets it, and this package does not send it.
- **Per-file blob guard.** For `update` and `delete`, the request `sha` must equal the blob id at the head the server cloned, else `422 sha does not match [given, expected]` (`update.go:380-388`, mapped at `file.go:726`). With no `sha` and no `last_commit_id`, the server answers a 500 (`update.go:403-406`). This package therefore requires `originalSha` for every update, delete and rename source.
- **Create guard.** `create` fails with `422 repository file already exists [path: ...]` if the path exists at head, and the same happens for a rename destination (`update.go:450-453`).
- **Head guard at push time.** The server clones the branch head (`update.go:176`), uses the head it read as the commit parent (`update.go:228-231, 271`), and pushes without force (`temp_repo.go:353-360`; `-f` only when `PushOptions.Force`, `modules/git/repo.go:198`). If the branch moves between that clone and the push, git rejects it as non-fast-forward and `ErrPushOutOfDate` is returned (`modules/git/repo.go:212-213`). The handler does not map that error, so it surfaces as a 500 (`file.go:721-737`). Clients cannot tell it from other 500s, so 5xx on commit becomes `CommitOutcomeUnknownError`.
- **Branch protection and archive.** 403 for protected branches and protected paths, 423 for archived repositories (`file.go:722-725`, route `mustNotBeArchived`).

### What this means for races

The client preflight reads the branch head, requires it to equal `baseCommit` (else `StaleHeadError`), then posts. Stock Gitea cannot make that check atomic with the commit:

- A commit that lands **after the preflight and before the server clones** is built into the new commit silently. If it touches a file this commit updates or deletes, the per-file `sha` check fails (`StaleBlobError`, with `paths` found by re-reading the new head). If it touches only other files, **the commit succeeds on top of it**; the unrelated commit is not rejected. That is the documented limitation and is covered by the `LIMITATION` test in `tests/repository.test.ts`.
- A commit that lands **between the server's clone and push** is rejected by git (non-fast-forward) with an unmapped 500.
- Cross-file semantic conflicts (for example a file this commit creates inside a directory they replaced with a file) are checked by path rules only (`update.go:410-456`).

Closing the window needs a Gitea change that exposes `last_commit_id` on `POST /contents`, which is not invented here.

## Contracts

```ts
class HttpGiteaRepository implements InitializableGiteaRepository {
  constructor(options: HttpGiteaRepositoryOptions);
  initialize(options?: RequestOptions): Promise<RepositoryState>; // { commit, branch, canWrite, canBranch }
  refresh(commit?: string, options?: RequestOptions): Promise<void>;
  getEntry(path: string, options?: RequestOptions): Promise<RepositoryEntry>;
  readDirectory(path: string, options?: RequestOptions): Promise<RepositoryEntry[]>;
  readFile(path: string, options?: ReadFileOptions): Promise<RepositoryFile>;
  readTree(path?: string, options?: RequestOptions): Promise<RepositoryEntry[]>;
  commit(change: RepositoryCommit, options?: RequestOptions): Promise<CommitResult>;
  logout(): Promise<void>;
}
```

See `src/types.ts` for every type and `src/errors.ts` for the error codes.

## Limitations

- LFS: `readFile` replaces a pointer by the object from `GET /repos/{owner}/{repo}/media/{path}?ref={commit}`, checked against the pointer's size and SHA-256, and sets `lfs: { oid, size, resolved: true }`. `readFile(path, { lfs: 'pointer' })` returns the pointer and never fetches the object. When the server answers with the pointer itself (its LFS server is off, or it never received the object) the pointer is returned with `resolved: false`. An object over `maxFileSize` throws `file-too-large` before any download. Commits refuse LFS-pointer content, because the server would re-wrap it when the path is LFS-tracked (`update.go:493-512`).
- Symlinks read as their target path text and are never followed here; a submodule is not readable (`unsupported`, naming its commit). The editor layer follows links inside the repository (`plan.md`, Behavior reference).
- Executable bit and symlink or submodule writes are not supported; updates preserve the existing mode on the server.
- A rename must not reuse a path another change in the same commit deletes or creates.
- Writes target the opened branch, or with `newBranch` a new branch cut from it (`new_branch` on `POST /contents`; that skips the opened branch's protection, so `canBranch` is only repository write access). No force-push.
- `GiteaRefs` (`src/refs.ts`) lists branches and tags, creates branches, reads a branch head, counts commits with `compare`, and creates pull requests. It is separate from the pinned reads.
- Authentication is by header only; cookies are sent only when the provider sets `credentials`.
- The instance URL must be `https`, or `http` on a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`).
- `timeoutMs` bounds the wait for the response head and, separately, each gap between body chunks, so large blobs and LFS objects are not cut off by a total timeout. A `Retry-After` longer than `retryMaxDelayMs` is not slept through: the request fails with `rate-limited` and `retryAfterMs` set.
- One byte budget (`cacheBytes`) covers cached trees, recursive listings and blobs. A commit may carry at most `maxCommitBytes` (100 MiB) of content; renamed files count, and are checked as their sources are downloaded (up to 6 in parallel).
- `GiteaRefs.listBranches` and `listTagRefs` page until an empty page and report `truncated` when the page cap stops them; both return `{ branches, truncated }` (for tags, `branches` holds the tag refs). `branchHead` and `compare` validate their refs like `createBranch` does.
