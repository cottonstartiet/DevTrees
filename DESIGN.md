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
  velocity-primary: 'oklch(0.5607 0.2181 266.5346)'
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
blue-gray tonal surfaces with ink-like controls. **Velocity** keeps the same
cool neutral discipline but introduces vivid blue for primary actions and
selection. Color stays functional, with red reserved for destructive actions.
Depth is conveyed through tonal layering (sidebar, cards, popovers sit at
subtly different lightness), not shadows.

This system explicitly rejects **heavy-enterprise density-without-clarity**
(Jira-style nested panels, modal mazes, config sprawl) and **consumer-chat
softness** (oversized rounded bubbles, avatars, playful color). It's a tool a
developer respects, not an app that entertains them.

**Key Characteristics:**

- Two restrained palettes: Chalk and Velocity, each coordinated across light and dark
- Compact scale: 36px control height, 0.875rem body text, tight radii (6–10px)
- Flat surfaces with tonal layering for depth; no drop-shadow theater
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

### Velocity

- **Velocity Blue** (`oklch(0.5607 0.2181 266.5346)` in both modes): The vivid
  accent for primary actions, focus, and active navigation.
- **Velocity Surface** (`oklch(0.9713 0.0053 286.3006)` light /
  `oklch(0.1921 0.004 286.0181)` dark): A cooler neutral base that lets state
  and action color read quickly.

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

**Body / UI Font:** System sans stack (`ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif`)

**Character:** No custom or display typeface. DevTrees uses the OS-native system
font at compact sizes for a fast, developer-native feel that renders crisply in
WebView2 on Windows. Hierarchy comes from **weight and size**, not from font
pairing.

### Hierarchy

- **Title** (600, 1rem, 1.4): Page and section headings, dialog titles. Slight negative tracking (-0.01em) to feel tight and intentional.
- **Body** (400, 0.875rem/`text-sm`, 1.5): The workhorse — list items, descriptions, most UI text.
- **Label** (500, 0.875rem, 1.4): Button text, form labels, active nav items. Medium weight distinguishes it from body without size change.
- **Metadata** (400, 0.75rem, 1.4, muted-foreground): Timestamps, branch counts, secondary status.

### Named Rules

**The Weight-Not-Family Rule.** Never introduce a second font family for
emphasis. Distinguish hierarchy with weight (400 → 500 → 600) and the muted
foreground color. No display serifs, no decorative type.

## 4. Elevation

DevTrees is **flat by default with tonal layering**. Depth is conveyed by
stepping background lightness (base → sidebar → card → popover), not by casting
shadows. The only shadow in the system is `shadow-xs` on buttons and inputs — a
1px hairline that reads as a crisp edge, not a lift. Overlays (dialogs,
dropdowns, tooltips) sit on the popover surface with a border, relying on a
scrim rather than a large blurred shadow.

### Shadow Vocabulary

- **Control edge** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)` / `shadow-xs`): The sole resting shadow, on buttons and inputs. Reads as definition, not elevation.

### Named Rules

**The Tonal-Depth Rule.** Layer surfaces by lightness, not by shadow. A raised
element is one lightness step off its parent, bordered with a hairline — never
floated on a soft drop-shadow.

## 5. Components

### Buttons

- **Shape:** `rounded-md` (8px), 36px default height (`h-9`), compact.
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

- **Surface:** `popover`/`card` tonal layer with 1px border, `rounded-lg` (10px).
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

- **Do** keep controls compact: 36px height, `text-sm`, 6–10px radii.
- **Do** convey depth with tonal layering (step background lightness), bordered with hairlines.
- **Do** reserve saturated color for action, selection, focus, and data; red is destructive only.
- **Do** distinguish hierarchy with weight (400/500/600) and muted foreground, never a second font family.
- **Do** give every interactive element a visible 3px focus ring; the app is keyboard-first.
- **Do** ensure body and placeholder text hit ≥4.5:1 across both themes and modes.

### Don't:

- **Don't** build heavy-enterprise density-without-clarity: no nested config panels, modal mazes, or Jira-style sprawl.
- **Don't** drift toward consumer-chat softness: no oversized rounded bubbles, avatars, or playful decorative color.
- **Don't** float surfaces on soft drop-shadows — use tonal layers and hairline borders.
- **Don't** use theme accents decoratively or use red for anything but destructive/error states.
- **Don't** add a display/serif font or gradient text; hierarchy is weight and size.
- **Don't** use side-stripe `border-left` accents on cards or list items.
