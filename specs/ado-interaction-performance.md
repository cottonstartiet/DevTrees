# Azure DevOps Interaction Performance

## Status

Proposed

## Summary

DevTrees currently uses the Azure CLI and Azure DevOps extension for Azure
DevOps pull-request reads and writes. The integration is functionally correct,
but common review workflows start several `git` and `az` child processes and
repeat the same remote, identity, PR, and iteration lookups.

This specification reduces latency by:

- caching stable Azure DevOps context in the Tauri process;
- requesting only the PR fields consumed by DevTrees;
- resolving PR base and head commits once;
- fetching missing PR commits into the local Git object database;
- using local Git for changed files, textual diffs, and file contents;
- retaining Azure DevOps requests for server-owned state such as comments,
  votes, and thread mutations.

The renderer remains provider-agnostic. No new settings or primary UI are
required.

## Goals

1. Make the active-PR list require no more than one `az` invocation after the
   current Azure identity has been cached.
2. Make initial ADO review loading resolve PR metadata and commits once.
3. Make opening a changed file use local Git rather than downloading both file
   versions through separate Azure DevOps requests.
4. Preserve the current PR review types and user-visible behavior, including:
   - change types and rename paths;
   - addition and deletion counts;
   - binary-file handling;
   - diff and file size limits;
   - markdown preview and raw content;
   - comment anchors and line numbers;
   - explicit authentication and command errors.
5. Never modify the repository working tree, index, checked-out branch, or
   user-created refs while loading a review.
6. Keep comments, votes, thread status, and other server-owned state fresh.

## Non-goals

- Replacing the Azure CLI as the authentication prerequisite.
- Adding a PAT or other credential store.
- Reimplementing all Azure DevOps REST operations with a new HTTP client.
- Changing GitHub review behavior except where a provider-neutral contract
  must be extended.
- Persisting cached PR data across application restarts.
- Adding a settings screen for cache controls.
- Supporting Azure DevOps Server/on-premises remotes. Existing Azure DevOps
  Services support remains unchanged.

## Current Architecture

The renderer invokes provider-neutral review functions through
`src/renderer/src/lib/api.ts`. Azure DevOps commands are implemented in
`src-tauri/src/ado.rs`, with child-process execution in:

- `src-tauri/src/az.rs` for `az`;
- `src-tauri/src/git.rs` for `git`.

The current review load performs independent requests for detail, changed
files, and threads. Those requests independently resolve the repository remote.
Detail and changed-files loading also independently resolve the latest PR
iteration.

For every ADO file diff, the backend currently:

1. resolves the repository remote;
2. resolves the latest PR iteration;
3. downloads the base-side file through Azure DevOps;
4. downloads the head-side file through Azure DevOps;
5. computes a text diff in Rust.

The Azure CLI is implemented in Python and has meaningful cold-start cost on
Windows. Starting it several times dominates the latency for small responses.

## Proposed Architecture

### 1. Process-local ADO state

Add a Tauri-managed `AdoClientState`. The state owns bounded, process-local
caches and synchronization for duplicate requests.

Suggested model:

```rust
pub struct AdoClientState {
    remote_by_folder: Mutex<HashMap<String, AdoRemote>>,
    current_user: Mutex<Option<Cached<String>>>,
    open_prs: Mutex<HashMap<String, Cached<Vec<RepoPr>>>>,
    pr_contexts: Mutex<HashMap<AdoPrKey, Cached<AdoPrContext>>>,
    prepared_commits: Mutex<HashSet<PreparedCommitKey>>,
}
```

The exact lock types may change during implementation. Do not hold a standard
mutex across an `.await`. Values needed for an async operation must be cloned
before awaiting, or the state must use an async-aware synchronization
primitive.

`AdoPrKey` must include enough repository identity to avoid collisions between
organizations:

```text
organization + project + repository + pull-request ID
```

`AdoPrContext` should contain:

- parsed `AdoRemote`;
- pull-request ID;
- title, description, author, status, draft flag, reviewers, and branch refs;
- base commit SHA;
- head commit SHA;
- latest iteration ID;
- generated web URL.

### 2. Cache behavior

The caches are performance aids, not sources of durable truth.

| Entry | Lifetime | Refresh behavior |
|---|---:|---|
| Parsed repository remote | Process lifetime | Replace if origin URL changes |
| Current Azure identity | Process lifetime | Clear after an authentication error |
| Open PR list | 5 seconds | Manual refresh bypasses the cached value |
| PR context | 5 seconds | Mutations and manual refresh invalidate it |
| Prepared commit pair | Until the SHA pair changes | No refetch while both objects remain available |

Concurrent requests for the same missing PR context should be coalesced. Detail
and changed-files loading must not start two identical iteration requests when
they arrive at the same time.

Do not return stale cached data after a manual refresh fails. Surface the
failure through the existing result union.

### 3. Narrow open-PR query

Keep `az repos pr list`, but add a JMESPath `--query` that emits only fields
used by `RepoPr` categorization and display:

- `pullRequestId`;
- `title`;
- `createdBy.displayName`;
- `createdBy.uniqueName`;
- `sourceRefName`;
- `targetRefName`;
- `isDraft`;
- `creationDate`;
- reviewer `uniqueName` and team/container information if required;
- the web link, or generate it locally from `AdoRemote`.

Continue to pass explicit organization, project, repository, active status, and
maximum result count. Do not depend on global `az devops configure` defaults,
because DevTrees can contain repositories from different organizations and
projects.

Resolve `az account show` once per application process. Identity lookup is
best-effort for categorization, as it is today; failures must not prevent the
PR list from loading.

### 4. Provider-neutral review bootstrap

Introduce a provider-neutral bootstrap operation that returns PR detail and
changed files together:

```ts
export type PrReviewBootstrap = {
  detail: PrReviewDetail
  files: PrChangedFile[]
}

export type PrReviewBootstrapResult =
  | { ok: true; review: PrReviewBootstrap }
  | { ok: false; code: ReviewsErrorCode; message?: string }
```

Add corresponding backend commands for both providers:

- ADO resolves metadata, commits, and changed files once.
- GitHub may compose its existing detail and changed-file operations.

Update `use-pr-review.ts` to call bootstrap instead of starting separate detail
and changed-file requests. Threads should continue loading independently so a
slow comments request does not delay the code surface.

The existing detail and changed-files commands may remain temporarily for
compatibility, but they should delegate to shared provider helpers rather than
duplicate logic.

### 5. Preparing PR commits locally

Before reading changed files or file content, ensure that both PR commits exist
in the local Git object database.

First test each object without network access:

```text
git cat-file -e <sha>^{commit}
```

If either commit is unavailable, fetch the source and target branch refs:

```text
git fetch --quiet --no-tags origin <source-ref> <target-ref>
```

Requirements:

- Run the command in `folderPath`.
- Use refs obtained from ADO PR metadata, not user-provided arbitrary options.
- Pass each command argument separately; do not construct a shell command.
- Do not checkout, merge, reset, update the index, or modify files.
- Do not create permanent `refs/heads/*` or `refs/remotes/*` names.
- After fetching, verify both commit objects again.
- If either SHA is still unavailable, return `git-failed` with the Git error.
- Mark the `{folderPath, baseSha, headSha}` pair prepared only after successful
  verification.

Do not use a shallow fetch by default. The exact common/base commit might be
outside a shallow boundary. Do not use `--filter=blob:none`, because the next
operation normally requires file blobs.

### 6. Changed files from local Git

Replace ADO iteration-change entries with local Git output after the commit
pair has been prepared.

Use NUL-delimited output so spaces, quotes, Unicode, and unusual path
characters are parsed safely:

```text
git diff --name-status -z -M <baseSha> <headSha>
git diff --numstat -z -M <baseSha> <headSha>
```

Map Git status to the existing contract:

| Git status | DevTrees change type |
|---|---|
| `A` | `add` |
| `D` | `delete` |
| `R*` | `rename` |
| Other tracked modifications | `edit` |

For renames, set `previousPath` to the old path and `path` to the new path.
Treat `-` values in `--numstat` as binary. Set binary addition and deletion
counts to zero.

Merge status and numstat records by normalized path. Files must remain sorted
by the current path. Preserve forward-slash repository-relative paths and
markdown detection.

This change improves the sidebar by providing addition and deletion counts
before a file is opened.

### 7. File diffs from local Git

Replace the two ADO item downloads and Rust blob-to-blob diff with:

```text
git diff \
  --no-color \
  --no-ext-diff \
  --no-textconv \
  --unified=3 \
  <baseSha> \
  <headSha> \
  -- \
  <path>
```

On Windows the arguments remain separate `Command` arguments; the displayed
multiline form is illustrative only.

Parse the unified output with the existing `parse_unified_patch` plumbing.
The parser already ignores Git preamble lines, but tests must cover complete
`git diff` output rather than only a hunk body.

Requirements:

- Disable external diff drivers and text conversion.
- Never invoke a shell.
- Preserve existing context-line behavior.
- Detect Git's binary-diff marker and return `isBinary: true`.
- Enforce `MAX_FILE_BYTES` before retaining an unbounded patch.
- Enforce `MAX_FILE_LINES` while producing the renderer model.
- Set `truncated: true` whenever either guard is reached.
- An unchanged or missing-on-both-sides path returns an empty non-binary diff.

### 8. File content from local Git

Replace ADO item content requests with local object reads:

```text
git show <sha>:<repository-relative-path>
```

The Git executor must support byte output for this operation. Converting child
output with `String::from_utf8_lossy` before binary detection can corrupt binary
data and makes NUL detection unreliable.

Add a byte-oriented Git result/helper while preserving the existing text helper
for other callers:

```rust
pub struct GitBytesOutput {
    pub stdout: Vec<u8>,
}
```

Behavior:

- Select `baseSha` or `headSha` from the cached PR context.
- Treat a missing path on one side as the existing expected missing-file
  result, not as a generic crash.
- Detect binary content from the raw bytes.
- Decode text only after binary detection.
- Apply the existing text and line guards.
- Preserve the `PrFileContent` response shape.

### 9. Server-owned data remains remote

Continue using Azure DevOps for:

- PR threads and comments;
- creating and replying to threads;
- resolving or reopening threads;
- reviewer votes;
- PR metadata refreshes.

These operations represent current server state and cannot be inferred from
Git. A successful mutation must invalidate the relevant PR context and thread
cache before refetching.

Direct REST calls using a cached Azure CLI access token are a possible future
optimization, but are not part of this implementation.

## Error Handling

Preserve existing error codes:

- `no-origin`;
- `unsupported-remote`;
- `az-not-installed`;
- `az-extension-missing`;
- `az-not-logged-in`;
- `az-failed`;
- `git-failed`.

Additional rules:

- Never silently fall back to stale data after an explicit refresh.
- If local commit preparation fails, return `git-failed` with an actionable
  message.
- If Azure authentication fails, clear cached identity and PR context.
- Added/deleted files missing on one side are expected and must not be reported
  as failures.
- Malformed Git output must produce an explicit parsing error rather than an
  incomplete success response.
- Do not broadly catch and convert unrelated failures into empty lists or empty
  diffs.

## Data and Security Considerations

- Do not log access tokens, Azure CLI environment variables, file contents, or
  complete comment bodies.
- Repository and branch names may appear in diagnostic logs, consistent with
  existing behavior.
- All Git and Azure CLI arguments must use `Command::args`; never interpolate
  them into a shell command.
- Keep the existing no-console-window behavior on Windows.
- Cache only non-secret metadata and Git object availability.

## User Experience

No new UI is required. The existing skeleton, error, empty, and review states
remain in place.

Manual refresh must:

1. bypass the open-PR or PR-context TTL;
2. invalidate renderer file caches when the PR head SHA changes;
3. retain cached file diffs when the base/head SHA pair is unchanged.

The third behavior is optional for the first implementation if it would
substantially complicate the renderer. Correctness takes priority over
retaining the cache.

## Implementation Sequence

### Phase 1: Shared state and command reduction

1. Add and register `AdoClientState`.
2. Cache parsed remotes and the current Azure identity.
3. Narrow `az repos pr list` output.
4. Add short-lived open-PR caching and concurrent-request coalescing.

This phase improves both the Reviews tab and the repository detail panel
without changing review diff behavior.

### Phase 2: PR context and local objects

1. Extract PR metadata/iteration resolution into an `AdoPrContext` helper.
2. Add commit-existence checks and fetch-on-miss.
3. Add byte-oriented Git execution.
4. Add parser tests before replacing production call sites.

### Phase 3: Local changed files, diffs, and content

1. Implement changed-file parsing from name-status and numstat.
2. Implement local unified file diffs.
3. Implement local base/head file content.
4. Remove now-unused ADO item-content helpers.
5. Keep server-owned thread and mutation operations unchanged.

### Phase 4: Bootstrap contract

1. Add shared TypeScript and Rust bootstrap types.
2. Add provider commands and API bridge entries.
3. Update `use-pr-review.ts`.
4. Retain or delegate legacy commands until all call sites are migrated.

## Test Plan

### Rust unit tests

Add focused tests for:

- complete Git unified-patch parsing;
- added, edited, deleted, and renamed files;
- rename scores such as `R100` and `R087`;
- NUL-delimited paths containing spaces and tabs;
- Unicode paths;
- binary numstat records;
- files without a trailing newline;
- empty files;
- added and deleted files missing on one side;
- diff byte and line truncation;
- cache key isolation across organizations and repositories;
- cache expiry and manual-refresh bypass;
- concurrent PR-context request coalescing;
- authentication failure invalidation.

### Integration tests with a temporary Git repository

Create commits in a temporary repository covering:

- text edit;
- file addition;
- file deletion;
- rename with and without content changes;
- binary file;
- markdown file;
- unusual valid path characters.

Verify that local Git helpers produce the same `PrChangedFile`,
`PrFileDiff`, and `PrFileContent` contracts expected by the renderer.

The tests must not require Azure credentials or network access.

### Existing project checks

Run:

```text
cargo test --manifest-path src-tauri\Cargo.toml
yarn typecheck
yarn lint
yarn build:web
```

### Manual validation

With an authenticated Azure CLI and a real ADO repository:

1. Open the active PR list.
2. Confirm mine/assigned/other categorization remains correct.
3. Open a PR and compare the file list with Azure DevOps.
4. Compare addition/deletion counts.
5. Open edited, added, deleted, renamed, binary, and markdown files.
6. Create and resolve a comment thread.
7. Change the reviewer vote.
8. Push another commit to the PR and use manual refresh.
9. Confirm the new head and changed files appear.
10. Confirm the working tree, index, current branch, and named refs are
    unchanged after review navigation.

## Performance Instrumentation

During implementation, record elapsed time and child-process counts around:

- open PR list;
- PR bootstrap;
- first changed-file open;
- subsequent changed-file open;
- thread refresh.

Use debug-level application logs and avoid logging response bodies. Temporary
instrumentation may be removed after comparison, or retained if it follows the
existing logging conventions.

## Acceptance Criteria

1. After identity warm-up, loading active ADO PRs starts at most one `az`
   process per uncached refresh.
2. Initial ADO review loading does not request the latest PR iteration more
   than once.
3. After required commits are available locally, opening a file diff starts no
   `az` process and performs no network request.
4. Opening base/head file content starts no `az` process and performs no
   network request.
5. Navigating between already loaded files remains instant through the
   renderer's existing per-PR cache.
6. Changed-file results correctly represent add, edit, delete, and rename
   operations, including binary files and unusual paths.
7. Diff and content size guards continue preventing oversized renderer
   payloads.
8. Thread, comment, and vote operations behave as before.
9. Manual refresh shows a changed PR head rather than serving stale context.
10. Review loading never changes the working tree, index, current branch, or
    user-created refs.
11. Existing GitHub review behavior remains unchanged.
12. Rust tests, TypeScript type checking, linting, and the web build pass.

## Expected Impact

| Interaction | Current behavior | Target behavior |
|---|---|---|
| Active PR list | Git remote lookup, identity lookup, full PR-list command | Cached remote/identity and one narrow PR-list command |
| Initial review | Duplicate remote and iteration resolution across requests | One shared PR context and one bootstrap |
| First file diff | Iteration lookup and two ADO item downloads | Local object check, optional one-time fetch, local Git diff |
| Subsequent file diff | Repeated ADO reads per file | Local Git only |
| Markdown preview/raw | ADO item request per side | Local `git show` |
| Threads and mutations | Azure DevOps request | Unchanged |

The dominant expected improvement is removal of repeated Azure CLI cold starts
while navigating files. Network cost becomes a one-time fetch only when the
required PR commit objects are not already available locally.
