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
Session regression checks use `cargo test --manifest-path src-tauri/Cargo.toml --lib`
and `node --test scripts/pty-terminal.test.mjs` (the installed xterm parser with a
mocked desktop transport; no browser server).

The `*:web` scripts and `dist-web` directory build the embedded desktop renderer,
not a standalone web application. Use `yarn dev` to run the complete app.

## Tasks and Copilot sessions

Tasks can target the main working copy, an existing worktree, or a planned worktree
created when work starts. Managed Copilot sessions run the installed interactive
Copilot CLI in an embedded PTY terminal. Answer questions, approve or reject tools,
and enter prompts directly in **Terminal**. It has a black background in both app
themes. **Transcript** is optional, read-only event-log history; it can lag behind
the terminal and never contains live approval controls.

Dashboard shows attention and opens the corresponding session's Terminal tab.
Question and permission status comes from correlated CLI log events, independently
of the visible page. Missing, unreadable, or stale observations show a warning;
the terminal remains usable. CLI-only dialogs such as authentication and setup
may require inspecting the terminal even without a structured attention event.

Switching pages or sessions keeps each process and terminal alive. Closing
DevTrees ends its owned processes, including child tools on Windows. After reopening,
**Resume** explicitly starts a new process using the same CLI history ID; DevTrees
does not replay an old prompt, permission, or answer. A renderer reconnect restores
the current terminal screen without restarting Copilot. Local scrollback survives
navigation, while a full renderer reload restores the screen rather than all
scrollback. Output replay is bounded and backpressured rather than silently dropped.

No auto-approval flags are added; existing user-controlled CLI permissions remain
in effect. External Windows Terminal sessions remain monitor-only and cannot be
attached to the embedded terminal. History and pull-request review remain available.

Install and authenticate the Copilot CLI before starting a session. GitHub
operations use `gh`; Azure DevOps operations use Azure CLI with its DevOps extension.
No Copilot SDK or CLI payload is bundled in the installer.

## App data

The desktop app uses a version-2 SQLite schema: repositories, tasks, and terminal
sessions. Version-1 records are migrated in place to record session transport and
process generation without losing history or task associations. There are no
legacy JSON imports.
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
