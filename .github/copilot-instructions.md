# Copilot Instructions

## Design Context

This project has captured design context for frontend/UI work:

- **PRODUCT.md** (root) — strategic context: register (`product`), platform
  (`desktop`, with an embedded React/WebView2 renderer), target users, product purpose, brand personality
  (_fast, developer-native, AI-forward_), anti-references, and design principles.
- **DESIGN.md** (root) — the visual system: OKLCH color tokens, two themes
  (light / dark), typography, flat + tonal-layering elevation, and
  component specs. North Star: **"The Developer Cockpit."**
- **.impeccable/design.json** — machine-readable sidecar (tonal ramps, motion,
  drop-in component snippets) extending DESIGN.md.

Read PRODUCT.md and DESIGN.md before designing or changing any UI so new screens
stay on-brand. Use the `impeccable` skill (`.github/skills/impeccable`) for
design work; it reads these files automatically.

Keep DevTrees a desktop application. Use Tauri commands and events for renderer/backend
communication, not a standalone browser UI or a local HTTP/WebSocket server.
