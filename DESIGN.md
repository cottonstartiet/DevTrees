---
name: DevTrees
description: A fast, developer-native desktop cockpit for git-worktree development.
colors:
  ink: 'oklch(0.1443 0.0191 261.1564)'
  surface: 'oklch(0.9745 0.0079 253.8524)'
  primary: 'oklch(0.2038 0.0264 260.9332)'
  primary-foreground: 'oklch(0.9851 0 0)'
  muted-foreground: 'oklch(0.5195 0.0188 262.6912)'
  border: 'oklch(0.9013 0.0156 257.2001)'
  destructive: 'oklch(0.577 0.245 27.325)'
  dark-surface: 'oklch(0.2292 0.0304 259.0329)'
  dark-card: 'oklch(0.261 0.0307 254.7604)'
  enterprise-primary: 'oklch(0.5565 0.2430 261.9529)'
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: '1rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.01em'
  body:
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  label:
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 'normal'
rounded:
  sm: '6px'
  md: '8px'
  lg: '10px'
  xl: '14px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '24px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.primary-foreground}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
    height: '36px'
  button-outline:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
    height: '36px'
  button-ghost:
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
    height: '36px'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '4px 12px'
    height: '36px'
---

# Design System: DevTrees

## 1. Overview

**Creative North Star: "The Developer Cockpit"**

DevTrees is an instrument panel for parallel development. Every surface is a
readout or a control: worktree lists, branch/PR status, session history, launch
buttons. Like a cockpit, information density is high but never chaotic — the
developer scans it at a glance, reaches for the right control by reflex, and
jumps back into flow. The aesthetic is precise, neutral, and quiet at rest, so
the _data_ (branch names, statuses, diffs) is the loudest thing on screen.

The system is built on shadcn/ui (new-york) with two selectable color themes,
each supporting Light, Dark, and System modes. **Chalk** is the quiet default:
blue-gray tonal surfaces with ink-like controls. **Enterprise** pairs a
violet-blue action color with softer corners and more pronounced elevation.
Color stays functional, with red reserved for destructive actions. Chalk uses
tonal layering for depth; Enterprise combines tonal layers with controlled soft
shadows.

This system explicitly rejects **heavy-enterprise density-without-clarity**
(Jira-style nested panels, modal mazes, config sprawl) and **consumer-chat
softness** (oversized rounded bubbles, avatars, playful color). It's a tool a
developer respects, not an app that entertains them.

**Key Characteristics:**

- Two restrained palettes: Chalk and Enterprise, each coordinated across light and dark
- Compact 36px controls and 0.875rem body text, with theme-specific corner treatment
- Chalk uses flat tonal layering; Enterprise adds deliberate soft elevation
- One semantic token contract across every palette/mode combination
- 3px focus rings on every interactive element — keyboard-first

## 2. Colors

A disciplined cool-neutral system where the selected theme controls the accent,
tuned independently for light and dark modes.

### Chalk

- **Chalk Ink** (`oklch(0.2038 0.0264 260.9332)` light /
  `oklch(0.8993 0.0119 239.9205)` dark): The default primary action and active
  control color.
- **Chalk Surface** (`oklch(0.9745 0.0079 253.8524)` light /
  `oklch(0.2292 0.0304 259.0329)` dark): A subtly blue-gray cockpit foundation.

### Enterprise

- **Enterprise Blue** (`oklch(0.5565 0.2430 261.9529)` light /
  `oklch(0.6449 0.2024 288.1131)` dark): The violet-blue accent for primary
  actions, focus, and active navigation.
- **Enterprise Surface** (`oklch(0.9946 0.0026 286.3519)` light /
  `oklch(0.1457 0.0043 285.8570)` dark): A near-neutral foundation with
  coordinated violet secondary and accent layers.

### Neutral

- Every theme supplies `background`, `card`, `popover`, `muted`, `border`,
  `input`, and sidebar layers through the same semantic token names.
- Components must consume semantic tokens rather than branching on a theme name.
- Charts use each theme's supplied five-color sequence.

### Tertiary

- **Destructive:** Delete worktree, discard, and other irreversible actions.
  Red remains reserved for destructive/error states in both themes.
- Supplied theme values are retained unless a minimal lightness adjustment is
  required for WCAG AA text contrast.

### Named Rules

**The Semantic Accent Rule.** The selected theme's primary color is used for
actions, focus, and current selection—not decoration. Red is reserved for
destructive/error states. Chart colors are exempt only inside data
visualizations.

## 3. Typography

**Body / UI Font:** Chalk uses the system sans stack
(`ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif`). Enterprise
requests Inter with a generic sans-serif fallback and also declares
Merriweather and JetBrains Mono tokens for explicitly serif or code-oriented
content.

**Character:** Product UI stays on the active theme's sans family at compact
sizes for a fast, developer-native feel in WebView2. Hierarchy comes from
**weight and size**, not decorative font pairing.

### Hierarchy

- **Title** (600, 1rem, 1.4): Page and section headings, dialog titles. Slight negative tracking (-0.01em) to feel tight and intentional.
- **Body** (400, 0.875rem/`text-sm`, 1.5): The workhorse — list items, descriptions, most UI text.
- **Label** (500, 0.875rem, 1.4): Button text, form labels, active nav items. Medium weight distinguishes it from body without size change.
- **Metadata** (400, 0.75rem, 1.4, muted-foreground): Timestamps, branch counts, secondary status.

### Named Rules

**The Weight-Not-Family Rule.** Never switch font families merely for emphasis.
Distinguish UI hierarchy with weight (400 → 500 → 600) and the muted foreground
color. Serif is reserved for content that explicitly calls for it; mono is
reserved for code, branches, commands, and terminal-oriented content.

## 4. Elevation

DevTrees uses theme-specific elevation while preserving one semantic shadow
scale. Chalk is **flat by default with tonal layering**: depth comes from
stepping background lightness (base → sidebar → card → popover), with only a
crisp control edge. Enterprise retains those tonal steps and adds soft,
theme-defined shadows (15px blur in light mode, 25px in dark mode) for a more
polished raised treatment.

### Shadow Vocabulary

- **Control edge** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)` / `shadow-xs`): Chalk's resting shadow on buttons and inputs. Reads as definition, not elevation.
- **Enterprise elevation** (`shadow-xs` through `shadow-2xl`): Soft neutral
  shadows with a 4px light-mode or 10px dark-mode vertical offset. Use the
  existing semantic shadow utility appropriate to the component; do not invent
  one-off values.

### Named Rules

**The Theme-Depth Rule.** Always establish hierarchy with tonal layering first.
Chalk stops at hairline definition; Enterprise may add its supplied semantic
shadow after the tonal relationship is clear.

## 5. Components

### Buttons

- **Shape:** `rounded-md`, 36px default height (`h-9`), compact. Chalk resolves
  to 8px; Enterprise resolves from its 1.4rem base radius.
- **Primary:** Solid `primary` fill, `primary-foreground` text, `shadow-xs`. Hover drops to 90% opacity.
- **Outline:** 1px border, transparent/surface background. Hover fills with `accent`.
- **Ghost:** No border or fill at rest; hover fills with `accent`. Used for toolbar and icon actions.
- **Destructive:** Solid `destructive` fill with `destructive-foreground` text. Reserved for irreversible actions.
- **Sizes:** `sm` (32px), default (36px), `lg` (40px), `icon` (36px square).
- **Hover / Focus:** `transition-all`; focus-visible shows a 3px `ring/50` ring plus border shift.

### Inputs / Fields

- **Style:** 1px `input` border, transparent background, `rounded-md`, 36px height, `text-sm`, `shadow-xs`.
- **Focus:** Border shifts to `ring`, plus a 3px `ring/50` glow.
- **Placeholder:** `muted-foreground` (meets 4.5:1, not a faint gray).
- **Error / Disabled:** `aria-invalid` shows destructive ring + border; disabled drops to 50% opacity, no pointer.

### Navigation (Sidebar)

- **Style:** Collapsible left rail on the `sidebar` surface (one step off base background), hairline right border.
- **States:** Ghost menu items; active item takes `sidebar-accent` fill and `sidebar-accent-foreground` text. Icons + labels; collapses to icon-only.

### Dialogs / Popovers

- **Surface:** `popover`/`card` tonal layer with 1px border and the active theme's `rounded-lg` radius.
- **Overlay:** Scrim backdrop; content centered, no heavy shadow.

### Status Bar (signature)

A slim bottom bar surfacing repo/branch/PR state and background task progress — the cockpit's primary readout. Compact `text-xs`, muted foreground, with color only for live/error status.

### Copilot Session Modes

Settings is the only transport launch control: In-app chat or External Copilot terminal.
The SQLite-backed preference defaults to ACP for new installations, migrates SDK
preferences to ACP, and preserves an explicit external choice. It applies to new
and resumed sessions without moving active runtimes. External sessions use compact status and
metadata only, without an in-app terminal or transcript. Their rows disappear on
exit and are not restored after an app restart.

### Native Copilot Sessions

Native sessions use the same compact transcript rows, followed by an inline
request region and Send/Queue composer. The ACP mode is explicit in the session
header; Stop turn, End session, and Resume are distinct.
Do not style this surface as a consumer chat app or introduce approval modals.

When a plan-mode turn completes successfully, show an inline next-step region with
the CLI-equivalent choices: build with default permissions, build on autopilot,
build on autopilot with fleet, or exit plan mode without acting. Preserve the
current Copilot permission configuration, keep the task and session open, and
surface unsupported modes or commands instead of silently falling back.
If a saved session is resumed while still in Plan mode, show a compact
`Choose implementation mode` action that reopens the same next-step region.
Reopening the choices must not change mode or submit work by itself.

Permission details precede the agent's exact offered decisions, with rejection
options before approval options. Approval must never be the
default action of a form or receive automatic focus. Structured fields have
labels, explicit choices, typed values and visible errors; do not silently pick
the first option. Pending request and composer drafts are shared across Session
and Dashboard. Only explicit navigation to a request moves focus.

Typing `/` at the beginning of the composer opens a compact, keyboard-navigable
portal autocomplete populated by the connected agent, not a static
terminal-command list. Agent configuration remains owned by Copilot CLI.
Unsupported actions and content fail visibly. Attachments appear as removable
context rows. Instructions submitted during an active turn are queued
automatically without exposing queue-management controls in the Sessions view.
The composer still distinguishes immediate Send from Queue so delivery timing is
not ambiguous. Stop pauses queued work; reopening requires explicit conversation
and queue resume. Starting, loading, stopping and ending states must not
masquerade as idle.

Dashboard offers compact responses without nested cards. Plan-completion
decisions and plan refinement are actionable in place; complex structured forms
link to the exact Session surface. Transport changes still require ending the
runtime, changing Settings, and resuming. Pending requests do not transfer.

## 6. Do's and Don'ts

### Do:

- **Do** keep controls compact: 36px height and `text-sm`, with radii supplied by the active theme.
- **Do** establish depth with tonal layering, then use only the active theme's semantic shadows.
- **Do** reserve saturated color for action, selection, focus, and data; red is destructive only.
- **Do** distinguish UI hierarchy with weight (400/500/600) and muted foreground; reserve mono for developer content.
- **Do** give every interactive element a visible 3px focus ring; the app is keyboard-first.
- **Do** ensure body and placeholder text hit ≥4.5:1 across both themes and modes.

### Don't:

- **Don't** build heavy-enterprise density-without-clarity: no nested config panels, modal mazes, or Jira-style sprawl.
- **Don't** drift toward consumer-chat softness: no oversized rounded bubbles, avatars, or playful decorative color.
- **Don't** invent one-off shadows or use elevation without a clear tonal hierarchy.
- **Don't** use theme accents decoratively or use red for anything but destructive/error states.
- **Don't** use serif or mono as decorative UI emphasis, or use gradient text.
- **Don't** use side-stripe `border-left` accents on cards or list items.
