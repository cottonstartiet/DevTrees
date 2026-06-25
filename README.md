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

Updates use Tauri's updater plugin against GitHub Releases. The app checks
`releases/latest/download/latest.json` on launch; if a newer signed release
exists it downloads and installs it in the background and offers a restart.

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
│  ├─ db.rs                    # rusqlite (devtrees.db, migrations)
│  ├─ workspaces.rs worktrees.rs repo.rs ado.rs az.rs
│  ├─ system.rs                # external launchers + app info
│  └─ copilot_history.rs       # read-only Copilot CLI store reader
├─ capabilities/default.json   # permission set for the main window
└─ tauri.conf.json             # bundle + updater config
```
