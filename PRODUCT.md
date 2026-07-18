# Product

## Register

product

## Platform

web

## Users

Developers (primarily on Windows) who juggle multiple parallel work streams
across git worktrees, branches, and repositories. Their context is an active
coding session: switching between tasks, inspecting branch/PR state, and
launching their real tools (VS Code, Windows Terminal, the GitHub Copilot CLI)
without leaving flow. The job to be done is fast context-switching — spin up,
inspect, and jump into the right worktree with minimal friction, and keep an
eye on Azure DevOps pull-request status and Copilot CLI history along the way.

## Product Purpose

DevTrees is a desktop control center for git-worktree-based development. It
manages worktrees across workspaces, surfaces Azure DevOps pull-request details,
reads GitHub Copilot CLI history, and launches external tooling. Success looks
like a developer moving between parallel tasks in seconds, always seeing true
git/PR state, and treating the AI CLI as a first-class part of the loop — with
the app staying out of the way rather than becoming another thing to manage.

## Brand Personality

Fast, developer-native, AI-forward. The voice is direct and technical without
being terse-to-the-point-of-cryptic — it speaks the language of branches, PRs,
and terminals. It should feel like a sharp tool a developer reaches for by
reflex: quick, precise, and confident, never chatty or hand-holdy.

## Anti-references

- **Heavy enterprise apps / IDEs** (Jira-style ceremony, dense config panels,
  nested settings, modal-heavy workflows). DevTrees is a focused utility, not a
  platform.
- **Consumer chat apps** (bubbly, conversational-first UI, oversized avatars,
  playful rounded everything). The AI is a tool surface, not a chat companion.

## Design Principles

- **Speed over ceremony.** Every primary action should be one glance and one
  click/keystroke away. Cut confirmation steps and chrome that don't earn their
  place.
- **Developer-native.** Dense-but-clean information, keyboard-friendly, terminal
  and git vocabulary used honestly. Respect that the user reads code all day.
- **Show true state.** Never fake or stale git/PR/session status. Trust is built
  by reflecting reality accurately and immediately.
- **Get out of the way.** The app serves the workflow; it is not the
  destination. Launch the real tool and step aside.
- **AI as a first-class collaborator.** Copilot/CLI surfaces are integrated into
  the workflow, not bolted on — present, but never demanding.

## Accessibility & Inclusion

Target WCAG 2.1 AA: body text ≥4.5:1 contrast, large/UI text ≥3:1, visible focus
states across both themes (light, dark). Honor
`prefers-reduced-motion` with crossfade/instant fallbacks for every animation.
Theme-aware color tokens (OKLCH) keep contrast consistent across themes.
