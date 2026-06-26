# DevTrees

A desktop application built with **Tauri 2**, **Rust**, **TypeScript**, **Vite**, **React** and **shadcn/ui** (new-york). It manages git worktrees across workspaces, surfaces Azure DevOps pull-request details, reads GitHub Copilot CLI history, and launches external tooling (VS Code, Windows Terminal, the Copilot CLI). It ships with auto-update against GitHub Releases.

## Stack

- Tauri 2 (Rust backend in `src-tauri/`)
- React 19, TypeScript 5.9, Vite 7 (renderer in `src/renderer/`)
- Tailwind v4 (`@tailwindcss/vite`) + `tw-animate-css`
- shadcn/ui (style: new-york, baseColor: neutral, icons: lucide)
- SQLite via `rusqlite` (bundled); auto-update via `tauri-plugin-updater`

## Prerequisites

- [Rust](https://rustup.rs/) (stable) and the MSVC build tools on Windows
- Node.js 22 + Yarn (pinned via Corepack from the `packageManager` field)
- WebView2 runtime (preinstalled on current Windows)

## Scripts

```bash
yarn install
yarn dev          # tauri dev (Rust backend + Vite renderer with HMR)
yarn dev:web      # vite only (renderer in a browser, no Tauri APIs)
yarn typecheck    # tsc --noEmit (renderer)
yarn lint         # eslint
yarn build:web    # vite build (renderer only -> dist-web)
yarn build        # tauri build (signed NSIS installer + updater artifacts)
```

Validate the Rust backend with `cargo build` / `cargo clippy` from `src-tauri/`.

## Auto-update

DevTrees ships from a **private** GitHub Enterprise Cloud repository, so update
downloads are **authenticated**. Users sign in once via GitHub **OAuth device
flow** (Settings → GitHub account); the token is stored in the Windows
Credential Manager and never leaves the Rust backend.

The update **check and install run in Rust** (`update_check` / `update_install`
in `src-tauri/src/updater.rs`), which attaches the signed-in user's token to both
the manifest fetch and the installer download. Releases are resolved through the
GitHub REST **asset** API (`api.github.com/repos/<owner>/<repo>/releases/...`):
the backend discovers the `latest.json` asset id from `releases/latest`, then
downloads the manifest and the installer (whose URL is itself an API asset URL).
On launch the app prompts to sign in if needed, and offers a restart when a newer
signed release is available.

Releasing is automated by `.github/workflows/devtrees-build.yml`: on a push to
`main` that bumps `package.json`'s version above every existing `v*` tag, it
builds and **signs** the installer, publishes the installer + `.sig` to a GitHub
Release via the `gh` CLI, then writes `latest.json` (with the installer's REST
**asset API** URL) and uploads it as the final asset.

### Prerequisites for the private-repo move

- Register a GitHub **OAuth App** in the enterprise org with **Device Flow**
  enabled; set its public `client_id` in `src-tauri/src/github_auth.rs`
  (`DEFAULT_CLIENT_ID`, or the `DEVTREES_GH_CLIENT_ID` env override). Also set the
  release owner/repo (`DEFAULT_OWNER` / `DEFAULT_REPO`, or `DEVTREES_GH_OWNER` /
  `DEVTREES_GH_REPO`) and the endpoint org in `tauri.conf.json`.
- Org owners must approve the OAuth App (and authorize SSO if enforced), otherwise
  sign-in succeeds but release access is denied.
- Reading a private repo's releases via an OAuth App requires the classic `repo`
  scope (see the security tradeoff in `specs/ghe-update.md`).

Signing requires a minisign keypair (`yarn tauri signer generate`). The public
key is embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the
private key and its password must be set as repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

See `specs/ghe-update.md` for the full design and the de-risking spike.

## Layout

```
src/
├─ renderer/
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx, App.tsx
│     ├─ lib/api.ts            # window.api shim over Tauri `invoke`
│     ├─ lib/*.ts              # repo/worktrees/workspaces/ado/system facades
│     ├─ hooks/                # use-auto-update, use-repo-status, ...
│     ├─ components/           # app-sidebar + shadcn ui primitives
│     └─ pages/                # detail-view, history, settings
└─ shared/                     # TypeScript request/response types

src-tauri/
├─ src/
│  ├─ lib.rs                   # builder, plugins, command registration
│  ├─ db.rs                    # rusqlite (devtrees.db, migrations)
│  ├─ workspaces.rs worktrees.rs repo.rs ado.rs az.rs
│  ├─ system.rs                # external launchers + app info
│  ├─ github_auth.rs           # GitHub OAuth device-flow sign-in + token store
│  ├─ updater.rs               # authenticated auto-update (private repo)
│  └─ copilot_history.rs       # read-only Copilot CLI store reader
├─ capabilities/default.json   # permission set for the main window
└─ tauri.conf.json             # bundle + updater config
```
