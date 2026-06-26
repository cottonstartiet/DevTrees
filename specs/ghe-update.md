# DevTrees auto-update on a private GitHub Enterprise Cloud repo

Status: Proposed
Owner: DevTrees
Applies to: Tauri v2 desktop app (Windows-only, NSIS installer)

## 1. Problem & goals

DevTrees currently ships from a **public** `github.com/cottonstartiet/DevTrees` repository and
auto-updates with Tauri's updater plugin, which fetches
`releases/latest/download/latest.json` **anonymously**. We are moving the project to a
**private/internal** repository on **GitHub Enterprise Cloud (GHEC)**.

GHEC is still hosted on `github.com`, so most of the release pipeline is unaffected. The single
breaking change is **authentication**: a private repo's release manifest and installer can no longer
be downloaded without a token.

Goals:

- Keep auto-update working after the move to a private GHEC repo.
- Authenticate downloads **per user** without embedding any shared secret in the shipped app.
- Keep the existing signed-update integrity guarantees (minisign signature verification).
- Minimize disruption to the build/release workflow.

Non-goals:

- Cross-platform packaging (DevTrees remains Windows/NSIS only).
- Replacing the signing scheme or the updater plugin.

## 2. What stays the same

Because GHEC is still `github.com`:

- **Signing keypair and embedded `pubkey`** in `tauri.conf.json` (`plugins.updater.pubkey`) — unchanged.
- **NSIS bundle**, `createUpdaterArtifacts: true`, `installMode: passive` — unchanged.
- **CI host** for asset URLs is still `github.com` / `api.github.com`.
- The **version-consistency check** (`package.json` vs `tauri.conf.json`) and the signing step in
  `.github/workflows/devtrees-build.yml`.
- Enterprise **Actions policy** compliance (workflow already uses only `actions/checkout`,
  `actions/setup-node`, `actions/cache`, and the `gh` CLI).

## 3. What changes (summary)

1. Add **in-app GitHub OAuth device-flow sign-in**; store the resulting access token in the **Windows
   Credential Manager** via the `keyring` crate. The token lives only in the Rust backend.
2. Move the **update check + install into Rust**, attaching an `Authorization: Bearer <token>` header
   (via `app.updater_builder().header(...)`) to **both** the manifest fetch and the installer download.
3. Resolve releases through the **GitHub REST API asset endpoints**
   (`api.github.com/repos/<owner>/<repo>/releases/...`) rather than the private
   `releases/latest/download/...` path.
4. Update **CI** to write API asset URLs into `latest.json`.
5. Update **renderer** (sign-in UI + reworked auto-update hook) and **docs**.

## 4. Detailed design

### 4.1 Authentication — OAuth device flow

The app uses the [GitHub OAuth **device flow**](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow),
which needs only a **public `client_id`** (no client secret), making it safe for a distributed desktop
app.

Flow:

1. App → `POST https://github.com/login/device/code` with `client_id` and `scope=repo`.
   Response: `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`.
2. App shows `user_code` and opens `verification_uri` in the browser. The user authorizes the app.
3. App polls `POST https://github.com/login/oauth/access_token` (grant
   `urn:ietf:params:oauth:grant-type:device_code`) at `interval` seconds, handling
   `authorization_pending`, `slow_down`, `expired_token`, `access_denied`.
4. On success, the `access_token` is written to the OS keychain. `device_code` and the token never
   leave the Rust backend.

```
+--------+        device/code         +------------+
|  App   | -------------------------> |  github.com|
| (Rust) | <--- user_code, uri ------ |   OAuth    |
+--------+                            +------------+
    |  show user_code + open uri (browser)
    v
+--------+        poll access_token    +------------+
|  App   | -------------------------> |  github.com|
| (Rust) | <--- access_token -------- |   OAuth    |
+--------+                            +------------+
    | store token in Windows Credential Manager (keyring)
    v
 signed in
```

**Scope.** Reading a **private** repo's releases through an **OAuth App** token requires the broad
classic `repo` scope. See the security tradeoff in §6.

**Token lifetime.** Default OAuth App tokens do not expire. If the org enforces token expiry, GitHub
returns `refresh_token` / `expires_in`; the app should persist and use them, and fall back to
re-authentication on `401/403`.

### 4.2 Update flow — Rust-side, authenticated

The update flow runs in Rust so the token is never exposed to the renderer and the same auth header is
applied to **both** requests the updater makes.

`update_check`:

1. Read the token from the keychain. If absent → return `{ signedIn: false }`.
2. `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`
   (`Authorization: Bearer`, `Accept: application/vnd.github+json`) and locate the asset named
   `latest.json`; read its asset `id`.
3. Build the updater:
   ```
   app.updater_builder()
      .endpoints(["https://api.github.com/repos/<owner>/<repo>/releases/assets/{id}"])?
      .header("Authorization", "Bearer <token>")?
      .header("Accept", "application/octet-stream")?
      .build()?
      .check().await?
   ```
4. Store the returned `Update` in managed Rust state (`Mutex<Option<Update>>`) and return
   `{ available, version }`. (The `Update` object cannot be serialized to the renderer, so we keep it
   server-side.)

`update_install`:

1. Take the stored `Update`, **verify its version matches** the one the UI confirmed (guards against a
   race where a newer release appears between check and install).
2. `download_and_install().await` — the installer URL embedded in `latest.json` is itself an
   `api.github.com/.../releases/assets/{id}` URL, so it is fetched with the same auth header.
3. `app.restart()`.

Error mapping: treat `401/403/404` from the private repo as "auth unavailable / no access" (prompt
sign-in), not "no update".

### 4.3 Why the REST API asset scheme

The private `https://github.com/OWNER/REPO/releases/latest/download/latest.json` path is unreliable for
private repos. The documented, robust contract is the REST asset endpoint
`GET /repos/{owner}/{repo}/releases/assets/{id}` with `Accept: application/octet-stream`, which returns
a `302` to a **pre-signed** `objects.githubusercontent.com` URL. The HTTP client (reqwest, as used by
the Tauri updater) **strips the `Authorization` header on cross-host redirects**, so the pre-signed S3
request succeeds and we avoid the "only one auth mechanism allowed" `400`.

The asset `id` is dynamic per release, so Rust discovers the `latest.json` id from `releases/latest`
before building the updater, and CI writes the installer's API asset URL into `latest.json`.

### 4.4 Renderer

- `lib/api.ts`: add `githubAuth` (`status`, `startDeviceFlow`, `poll`, `signOut`) and `updater`
  (`check`, `install`) wrappers over the new commands.
- `pages/settings.tsx`: a **"GitHub account"** section — sign-in button that displays the `user_code`,
  opens `verification_uri`, polls to completion, and shows signed-in state + sign-out.
- `hooks/use-auto-update.ts`: replace `@tauri-apps/plugin-updater` calls with the new Rust commands. On
  launch, if signed in → `update_check`; if an update exists → "Restart & update" toast →
  `update_install`. If **not** signed in → a non-blocking "Sign in to receive updates" prompt (never a
  silent skip).

### 4.5 Config & capabilities

- `tauri.conf.json`: the dynamic per-release endpoint is now supplied by the Rust `updater_builder`.
  Keep `pubkey`, `createUpdaterArtifacts`, NSIS target, `installMode: passive`. Reconcile whether a
  static `plugins.updater.endpoints` entry is still required by the plugin or can be dropped.
- `capabilities/default.json`: keep `process` (restart). Drop `updater:default` (JS plugin permission)
  if the renderer no longer calls the JS plugin — verify the builder path does not require it.

### 4.6 CI (`.github/workflows/devtrees-build.yml`)

- Repo path updates automatically via `github.repository`; host stays `github.com`.
- Change `latest.json` generation: after `gh release create`, query the uploaded **installer asset id**
  and write the installer `url` as
  `https://api.github.com/repos/<repo>/releases/assets/{installer_asset_id}` instead of the
  `releases/download/...` browser URL. Order: upload installer + `.sig` → fetch asset id → regenerate
  `latest.json` with API URLs → upload `latest.json` → mark `--latest`.
- Keep the version-consistency check and signing step unchanged.

## 5. Prerequisites (manual, outside the codebase)

- **Register a GitHub OAuth App** in the enterprise org with **Device Flow enabled**; record the public
  `client_id` (embedded in the app as a constant/config). No client secret required.
- Org owners **approve the OAuth App** and authorize **SSO** if enforced — otherwise sign-in succeeds
  but repo access is denied.
- Re-add release secrets in the new repo: `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (signing keypair / `pubkey` unchanged).
- Confirm the enterprise Actions policy permits the existing actions (already compliant).

## 6. Security tradeoff & alternatives considered

- **Chosen:** OAuth device flow + private repo. Simple for users (browser sign-in), no shared secret in
  the app. **Cost:** reading private releases via an OAuth App requires the broad classic `repo` scope,
  so each install holds a high-value token. Mitigations: store only in the OS keychain, never in
  plaintext; provide sign-out; treat auth errors as re-auth prompts.
- **Alternative A — separate artifact endpoint/CDN:** keep the repo private but publish signed updater
  artifacts to an access-controlled/public CDN. Avoids broad GitHub tokens entirely; Tauri signature
  verification still guarantees integrity. Heavier infra; not chosen.
- **Alternative B — GitHub App + short-lived URLs / update proxy:** finer-grained `Contents:read`
  access via a backend that mints short-lived download URLs. Most secure, most complex; not chosen.

## 7. Risks & de-risking spike

Before wiring the full UI, run a **spike against a real private GHEC repo** to verify:

1. Device flow yields a working token with `repo` scope.
2. The Tauri updater downloads the `api.github.com/.../releases/assets/{id}` manifest and installer with
   `Authorization: Bearer` + `Accept: application/octet-stream`.
3. The `Authorization` header is **stripped on the cross-host S3 redirect** (no `400` "only one auth
   mechanism allowed").
4. minisign **signature verification still passes** with auth in place.

Other risks:

- The updater must accept builder-supplied API-asset endpoints + the `Accept: octet-stream` header for
  the manifest fetch — confirm in the spike.
- Org OAuth App approval / SSO gating may block repo access despite a successful sign-in — validate with
  `GET /repos/<owner>/<repo>` after sign-in.
- Enterprise proxy / custom root certs: use reqwest with native-root TLS
  (`rustls-tls-native-roots`) so the Windows trust store and proxies are honored.
- Windows Credential Manager unavailability: handle keyring errors explicitly; never fall back to
  plaintext.

## 8. Implementation plan (work items)

1. **Spec** — this document (`specs/ghe-update.md`).
2. **Prerequisites** — register OAuth App, org/SSO approval, re-add signing secrets (§5).
3. **Rust deps** — add `reqwest` (`default-features=false`, `["json","rustls-tls-native-roots"]`) and
   `keyring = "3"` to `src-tauri/Cargo.toml`.
4. **`github_auth.rs`** — device-flow commands (`start_device_flow`, `poll`, `status`, `sign_out`);
   keyring storage; register in `lib.rs`. Hardcode/allowlist `owner`/`repo`/host.
5. **Rust update flow** — `update_check` / `update_install` commands with `updater_builder` + auth
   header + Rust-held `Update` state + version guard.
6. **`lib/api.ts`** — `githubAuth` and `updater` wrappers.
7. **`settings.tsx`** — GitHub sign-in/sign-out UI.
8. **`use-auto-update.ts`** — rewire to Rust commands; sign-in prompt when unauthenticated.
9. **Config/capabilities** — reconcile updater endpoint config; trim unused JS updater permission.
10. **CI** — write API asset URLs into `latest.json`; reorder upload steps.
11. **Docs** — update `README.md` updater section.

## 9. Validation

- Renderer/build: `yarn typecheck`, `yarn lint`, `yarn build`.
- Backend: clear `NoDefaultCurrentDirectoryInExePath`
  (`Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue`) then
  `cargo build` in `src-tauri/`.
- Manual: device-flow sign-in, an authenticated `update_check`/`update_install` round-trip against the
  private repo, and the §7 spike. No unit-test framework in this repo.
