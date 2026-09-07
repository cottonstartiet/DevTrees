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
and `node --test scripts/session-launch.test.mjs scripts/session-interactions.test.mjs`
(session routing/status contracts and native interaction state; no browser server).

The `*:web` scripts and `dist-web` directory build the embedded desktop renderer,
not a standalone web application. Use `yarn dev` to run the complete app.

## Tasks and Copilot sessions

Tasks can target the main working copy, an existing worktree, or a planned worktree
created when work starts. **In-app chat** uses the official Rust Copilot SDK to
connect the installed CLI to the app's transcript, permission controls, questions,
and forms. Choose it or **External Copilot terminal** under **Settings > Copilot
sessions**. The setting is saved in SQLite and applies to every new and resumed
session; external is the default. Changing it never moves a running session.

Native requests are answered in the originating operation, not converted to a
follow-up message. **Deny** and **Allow once** are explicit; no permanent grants
or automatic approvals are added. Session-wide approval is intentionally hidden
until its live scope is verified. Forms preserve text, numbers, booleans and
single/multiple choices. Unsupported schemas and sensitive credential fields
show an explanation rather than a misleading empty form. URL authorization uses
an external Copilot terminal until its completion tracking is supported; native forms never
collect credentials.

The **Dashboard** shares pending requests, submissions and drafts with the Session
view. Simple requests can be answered there; larger forms open the exact Session
request. All pending requests remain visible, and competing responses are accepted
only once. Drafts survive page navigation and recoverable errors within the app;
they are not saved to disk.

Send follow-up instructions when Copilot is idle. **Stop turn** cancels current
work and pending requests; **End session** releases the runtime. **Resume** starts
a new runtime with the same saved conversation. **Enter plan mode** (or `/plan`)
enables supported plan decisions; `/interactive` returns to interactive mode.
Other slash commands and terminal-only setup flows require an external Copilot terminal.

To change a conversation's mode, **End session** in native chat (or end Copilot in
its external terminal), change Settings, and resume the conversation. Pending
questions and in-flight tool calls do not transfer. Resume uses the same saved
conversation ID without replaying the initial prompt. Active owners are rejected
rather than starting a second controller.

External mode opens the installed Copilot CLI in Windows Terminal. DevTrees shows
live status and attention messages only, not a terminal viewport or transcript.
Respond in the external terminal. Status observation can lag; unavailable status
is shown explicitly. External rows disappear when Copilot ends, and external
watches are not persisted or restored after an app restart. A renderer reconnect
within the same app run restores current live status.

Switching pages keeps native and external sessions running. Closing DevTrees ends
its native SDK runtimes but leaves external terminals running. Native conversations
can be resumed after reopening. Global **History** and **Analytics** continue to
read CLI history independently, including external sessions; removing a live status
row never deletes a conversation or its task link.

No auto-approval flags are added; existing user-controlled CLI permissions remain
in effect. External launch is Windows-only. Missing tools or launch failures
produce an error rather than silently changing the selected mode.

Install and authenticate the Copilot CLI before starting a session. GitHub
operations use `gh`; Azure DevOps operations use Azure CLI with its DevOps extension.
The evaluated native baseline is Rust SDK **1.0.13** with installed CLI
**1.0.84-1** (SDK protocol 3). The SDK negotiates compatibility at startup; a
missing or incompatible runtime produces an error, not an automatic upgrade.
Native mode resolves `copilot.exe` (`copilot` elsewhere) from PATH, or an explicit
`COPILOT_CLI_PATH`. End users do not install Rust or the SDK: its code is compiled
into DevTrees. No Copilot executable is bundled or automatically downloaded.

Developer and CI Cargo builds use `.cargo/config.toml` to force
`COPILOT_SKIP_CLI_DOWNLOAD=1`, alongside the SDK's disabled default features.
Keep both settings: disabling bundling alone does not disable the SDK build-time
runtime download. Normal Cargo crate dependencies are still restored when needed.

## Local Copilot analytics

**Analytics** analyzes **Copilot CLI** history, with repository and 7/30/90-day filters.
It retains the colourful usage graph, token-mix donut and cost-by-model bars, alongside:

- **Overview:** activity trends, preceding-period comparisons, model/token/credit
  records, latency percentiles, file observations and explicit source coverage.
- **Flow:** local-hour and calendar heatmaps, weekend/night activity, streaks,
  breaks, prompt cadence and long/single-turn session observations.
- **Practices:** explainable prompt-structure dimensions, session intent,
  spec-like task starts, evidence-based suggestions and recurring prompt workflows.
  Expand a pattern to inspect examples and copy a draft; nothing is installed automatically.

Rust reads `~/.copilot/session-store.db` read-only. Repository paths map to recorded
repository labels only when an unambiguous working-directory mapping exists.
VS Code chat history is not scanned; its analytics integration is deferred.

Reports are calculated locally through Tauri, without uploading prompts, calling
an LLM, or writing analytics to disk. Prompt excerpts are hidden until expanded.
English-keyword coaching uses up to the latest 5,000 current-period turns in the
repository selection, each limited to 8,000 characters. Activity counts still cover
the full selection. Missing optional fields produce visible warnings; oversized
reports ask for a smaller selection. Refresh reads saved history again.

Today is partial and comparisons use the preceding full local-calendar period.
Model calls and user turns remain separate metrics. Recorded credits are not an
invoice or complete account-wide billing history. Cadence is not hours worked, concentration,
burnout or productivity; prompt structure is not a judgment of engineering skill.
The separate **Copilot CLI commands** area explicitly launches CLI sessions and
may use AI credits; its repository target does not change the report filter.

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
