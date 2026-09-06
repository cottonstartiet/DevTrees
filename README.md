# DevTrees

A desktop application built with **Tauri 2**, **Rust**, **TypeScript**, **Vite**, **React** and **shadcn/ui** (new-york). It manages git worktrees across workspaces, surfaces Azure DevOps pull-request details, reads GitHub Copilot CLI history, and launches external tooling (VS Code, Windows Terminal, the Copilot CLI). It ships with auto-update against GitHub Releases.

DevTrees runs in its own desktop window. The React renderer communicates directly
with Rust through Tauri commands and events; there is no browser-hosted app or
local HTTP/WebSocket API server.

## Stack

- Tauri 2 (Rust backend in `src-tauri/`)
- React 19, TypeScript 5.9, Vite 7 (renderer in `src/renderer/`)
- Tailwind v4 (`@tailwindcss/vite`) + `tw-animate-css`
- shadcn/ui (style: new-york, baseColor: neutral, icons: lucide)
- SQLite via `rusqlite` (bundled); auto-update via `tauri-plugin-updater`

## Prerequisites

- [Rust](https://rustup.rs/) 1.94 or newer and the MSVC build tools on Windows
- Node.js 22 + Yarn (pinned via Corepack from the `packageManager` field)
- WebView2 runtime (preinstalled on current Windows)

## Scripts

```bash
yarn install
yarn dev          # tauri dev (Rust backend + Vite renderer with HMR)
yarn dev:web      # internal renderer dev server (used by tauri dev)
yarn typecheck    # tsc --noEmit (renderer)
yarn lint         # eslint
yarn build:web    # vite build (renderer only -> dist-web)
yarn build        # tauri build (signed NSIS installer + updater artifacts)
```

Validate the Rust backend with `cargo build` / `cargo clippy` from `src-tauri/`.

The `*:web` scripts and `dist-web` directory build the embedded desktop renderer,
not a standalone web application. Use `yarn dev` to run the complete app.

## Tasks and Copilot sessions

Tasks can target the main working copy, an existing worktree, or a planned worktree
created when work starts. Managed Copilot sessions run through the installed
`copilot --acp` executable and support prompts, permissions, and structured input
inside the desktop app. Existing external Windows Terminal sessions can still be
monitored, and the Copilot CLI history and pull-request review features remain
available.

Install and authenticate the Copilot CLI before starting a session. GitHub
operations use `gh`; Azure DevOps operations use Azure CLI with its DevOps extension.
No Copilot SDK or CLI payload is bundled in the installer.

## App data

The desktop app starts with a single version-1 SQLite schema: repositories, tasks,
and terminal sessions. There are no database migrations or legacy JSON imports.
On Windows, its database is `%APPDATA%\com.ritekode.devtrees\devtrees.db`.
The previous prototype's `%APPDATA%\devtrees` data is left untouched and is not loaded,
so the first launch starts with no repositories, tasks, or tracked sessions.
Anything added in this version is saved normally across subsequent launches.

Repository files, worktrees, external Copilot history, and CLI authentication are
independent of this app database and are not reset.

## Auto-update

Updates use Tauri's updater plugin against GitHub Releases. The app checks
`releases/latest/download/latest.json` on launch; if a newer signed release
exists it offers **Restart & update**. Download and installation start only when
the user accepts.

Releasing is automated by `.github/workflows/devtrees-build.yml`: on a push to
`main` that bumps `package.json`'s version above every existing `v*` tag, it
builds and **signs** the installer, generates `latest.json`, and publishes the
installer + `.sig` + `latest.json` to a GitHub Release via the `gh` CLI.

Signing requires a minisign keypair (`yarn tauri signer generate`). The public
key is embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the
private key and its password must be set as repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

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
│  ├─ db.rs                    # rusqlite (devtrees.db, initial schema)
│  ├─ workspaces.rs worktrees.rs repo.rs ado.rs az.rs
│  ├─ system.rs                # external launchers + app info
│  └─ copilot_history.rs       # read-only Copilot CLI store reader
├─ capabilities/default.json   # permission set for the main window
└─ tauri.conf.json             # bundle + updater config
```
