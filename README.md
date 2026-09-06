# DevTrees

DevTrees is a **Windows tray-hosted developer cockpit** for git worktrees. The installed
application has no embedded WebView or main desktop window: a small Tauri/Rust process
runs in the notification area, serves the bundled React application on an authenticated
loopback URL, and opens it in the default browser.

It manages repositories and worktrees, surfaces Azure DevOps and GitHub pull-request
details, reads Copilot CLI history, and launches VS Code, Explorer, Windows Terminal, and
the Copilot CLI.

## Architecture

```text
Windows tray host (Tauri/Rust)
├─ authenticated Axum server on 127.0.0.1:<dynamic-port>
│  ├─ embedded dist-web assets with SPA fallback
│  ├─ typed /api/<domain>/<operation> JSON routes
│  └─ reconnecting /events WebSocket
├─ SQLite/git/Azure DevOps/GitHub services
├─ Copilot session monitor
│  └─ tails ~/.copilot/session-state/<uuid>/events.jsonl
├─ Windows Terminal launch/resume
└─ tray, notifications, autostart, and signed updater

Default browser
└─ React 19 UI preserving window.api through fetch/WebSocket
```

Copilot remains interactive **only in Windows Terminal**. DevTrees assigns the session
UUID before launch (`copilot --session-id=<uuid>`), then streams read-only session
snapshots and deltas to every connected browser tab. Closing all tabs does not stop
monitoring, and exiting DevTrees does not terminate independently running terminal or
Copilot processes.

## Prerequisites

- Windows 10/11
- [Rust](https://rustup.rs/) 1.94+ and MSVC build tools (development only)
- Node.js 22 and Yarn 1.22 (development only)
- [Windows Terminal](https://aka.ms/terminal) (`wt.exe` on `PATH`)
- GitHub Copilot CLI (`copilot` on `PATH`), authenticated before launching a session
- GitHub CLI (`gh`) for GitHub review operations
- Azure CLI plus the Azure DevOps extension for Azure DevOps review operations

Use `copilot --version` and `wt --version` to verify the terminal prerequisites. Their
availability is also shown in **Settings → Terminal prerequisites**.

## Development

```powershell
yarn install
yarn dev          # Vite on 127.0.0.1:1420 + tray host on 127.0.0.1:1430
yarn typecheck    # TypeScript contracts and renderer
yarn lint
yarn build:web    # deterministic browser bundle -> dist-web
yarn build        # embeds dist-web and builds the signed NSIS package
```

From `src-tauri\`:

```powershell
cargo fmt --check
cargo check
cargo clippy --all-targets -- -D warnings
cargo test
```

Vite proxies `/api` and `/events` to the stable development host port. Packaged builds
bind an OS-assigned port on `127.0.0.1` and serve the embedded production bundle.

## Localhost security

- The server binds only to IPv4 loopback, never a LAN interface.
- Every tray/browser launch creates a one-time, unguessable URL token.
- The token is exchanged for an HttpOnly, `SameSite=Strict` session cookie and the
  browser is redirected immediately to a clean URL.
- API and WebSocket requests require that cookie.
- JSON requests also require an exact loopback `Origin` and double-submit CSRF token.
- `Host` is restricted to the active loopback port, request bodies are limited to 2 MiB,
  and responses include a restrictive CSP and `nosniff`.
- Opening the localhost port directly without using the tray is rejected.

## Tray and lifecycle

The tray menu provides **Open DevTrees**, **Open Sessions**, the active Copilot-session
count, **Check for Updates**, **Start at sign-in**, and **Exit DevTrees**. Left-clicking
the tray icon opens the browser UI.

Launch at sign-in is off on a clean install and can be toggled from either the tray or
Settings. Autostart launches only the background host; it does not open a browser tab.
A second application launch reuses the existing process and opens its authenticated URL.

Explicit Exit stops the HTTP server and monitor. Cursor/sequence positions from the last
completed poll are already persisted, so the next launch resumes from that point. Exit
intentionally does not enumerate, signal, or kill Windows Terminal or Copilot processes.

## Session monitoring

The Sessions screen is a read-only mirror of external Copilot work. The host:

- restores non-final watches from the existing `terminal_sessions` SQLite data;
- tails only appended bytes from `events.jsonl`;
- derives `starting`, `working`, `waiting-input`, `idle`, `done`, and `error`;
- reconstructs user, assistant, tool, permission, and notice timeline entries;
- persists cursor and sequence positions;
- sends stable-sequence snapshots and live deltas over one WebSocket.

When Copilot needs input, respond in its existing Windows Terminal tab. DevTrees never
injects terminal input or hosts an in-browser permission/message composer.

## Updates and packaging

Signed update checks run in the Rust host, so they continue with no browser open. Update
state is exposed through the tray and browser API. Installing an update stops the local
server immediately before handing the verified package to the existing passive NSIS
updater; external terminals remain untouched.

`.github/workflows/devtrees-build.yml` verifies that `package.json` and
`src-tauri/tauri.conf.json` versions match, builds `dist-web`, embeds it in the executable,
signs the NSIS installer, and publishes the installer, signature, and `latest.json`.

`install-local.ps1` builds a local unsigned-updater NSIS package. It uses the user's
installed, authenticated `copilot` executable; no Copilot SDK or CLI payload is bundled.

## Troubleshooting

- **Browser says authentication is required:** open DevTrees from the tray again.
- **Host unavailable:** ensure the tray process is running; a packaged host uses a
  dynamic port, while development uses `127.0.0.1:1430`.
- **Copilot/Terminal unavailable:** install the missing executable, restart DevTrees so
  it receives the updated `PATH`, then check Settings.
- **A session needs input:** switch to the existing Copilot tab in Windows Terminal.
- **No live session updates:** keep the tray host running and verify that the session has
  `~\.copilot\session-state\<uuid>\events.jsonl`.
