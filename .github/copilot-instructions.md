# Copilot Instructions

## Design Context

This project has captured design context for frontend/UI work:

- **PRODUCT.md** (root) — strategic context: register (`product`), platform
  (`web`), target users, product purpose, brand personality
  (*fast, developer-native, AI-forward*), anti-references, and design principles.
- **DESIGN.md** (root) — the visual system: OKLCH color tokens, two themes
  (light / dark), typography, flat + tonal-layering elevation, and
  component specs. North Star: **"The Developer Cockpit."**
- **.impeccable/design.json** — machine-readable sidecar (tonal ramps, motion,
  drop-in component snippets) extending DESIGN.md.

Read PRODUCT.md and DESIGN.md before designing or changing any UI so new screens
stay on-brand. Use the `impeccable` skill (`.github/skills/impeccable`) for
design work; it reads these files automatically.
