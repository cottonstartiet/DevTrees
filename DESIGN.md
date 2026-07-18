---
name: DevTrees
description: A fast, developer-native desktop cockpit for git-worktree development.
colors:
  ink: "oklch(0.145 0 0)"
  surface: "oklch(1 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  border: "oklch(0.922 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  dark-surface: "oklch(0.205 0 0)"
  dark-card: "oklch(0.255 0 0)"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
---

# Design System: DevTrees

## 1. Overview

**Creative North Star: "The Developer Cockpit"**

DevTrees is an instrument panel for parallel development. Every surface is a
readout or a control: worktree lists, branch/PR status, session history, launch
buttons. Like a cockpit, information density is high but never chaotic — the
developer scans it at a glance, reaches for the right control by reflex, and
jumps back into flow. The aesthetic is precise, neutral, and quiet at rest, so
the *data* (branch names, statuses, diffs) is the loudest thing on screen.

The system is built on shadcn/ui (new-york, neutral base) with two themes:
a clean light mode and a neutral dark mode. Color is used sparingly and
functionally — near-black/white for primary/active, red for destructive,
otherwise a disciplined grayscale. Depth is
conveyed through tonal layering (sidebar, cards, popovers sit at subtly
different lightness), not shadows.

This system explicitly rejects **heavy-enterprise density-without-clarity**
(Jira-style nested panels, modal mazes, config sprawl) and **consumer-chat
softness** (oversized rounded bubbles, avatars, playful color). It's a tool a
developer respects, not an app that entertains them.

**Key Characteristics:**
- Neutral grayscale foundation; color is functional, not decorative
- Compact scale: 36px control height, 0.875rem body text, tight radii (6–10px)
- Flat surfaces with tonal layering for depth; no drop-shadow theater
- Two coordinated themes sharing one token contract
- 3px focus rings on every interactive element — keyboard-first

## 2. Colors

A disciplined neutral palette where a single accent carries state, tuned across two themes.

### Primary
- **Cockpit Ink** (`oklch(0.205 0 0)` light / `oklch(0.922 0 0)` dark): The
  primary action color — solid fill on default buttons, active nav, key
  toggles. In light mode it's near-black; in dark it inverts to near-white.

### Neutral
- **Ink** (`oklch(0.145 0 0)`): Primary body and heading text on light surfaces.
- **Surface** (`oklch(1 0 0)` light / `oklch(0.205 0 0)` dark): The base background.
- **Card / Popover** (`oklch(1 0 0)` light / `oklch(0.255 0 0)` dark): Raised tonal layer, one step off the base background.
- **Muted Foreground** (`oklch(0.556 0 0)` light / `oklch(0.708 0 0)` dark): Secondary text, timestamps, metadata, placeholder text.
- **Border** (`oklch(0.922 0 0)` light / `oklch(1 0 0 / 10%)` dark): Hairline dividers, input strokes, card edges.

### Tertiary
- **Destructive** (`oklch(0.577 0.245 27.325)`): Delete worktree, discard, and other irreversible actions. The only red in the system.

### Named Rules
**The One Accent Rule.** Only one saturated hue is live per theme
(near-black/white). Red is reserved exclusively for
destructive actions. If a screen has more than one vivid color competing for
attention, one of them is wrong.

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
- **Destructive:** Solid `destructive` fill, white text. Reserved for irreversible actions.
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

## 6. Do's and Don'ts

### Do:
- **Do** keep controls compact: 36px height, `text-sm`, 6–10px radii.
- **Do** convey depth with tonal layering (step background lightness), bordered with hairlines.
- **Do** reserve saturated color for state — red for destructive only.
- **Do** distinguish hierarchy with weight (400/500/600) and muted foreground, never a second font family.
- **Do** give every interactive element a visible 3px focus ring; the app is keyboard-first.
- **Do** ensure body and placeholder text hit ≥4.5:1 across both themes.

### Don't:
- **Don't** build heavy-enterprise density-without-clarity: no nested config panels, modal mazes, or Jira-style sprawl.
- **Don't** drift toward consumer-chat softness: no oversized rounded bubbles, avatars, or playful decorative color.
- **Don't** float surfaces on soft drop-shadows — use tonal layers and hairline borders.
- **Don't** introduce a second accent hue or use red for anything but destructive actions.
- **Don't** add a display/serif font or gradient text; hierarchy is weight and size.
- **Don't** use side-stripe `border-left` accents on cards or list items.
