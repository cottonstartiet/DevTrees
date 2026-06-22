# DevTrees

A desktop application scaffold built with **Electron**, **TypeScript**, **Vite**, **React** and **shadcn/ui** (new-york). Includes a collapsible left sidebar with a Settings entry pinned to the bottom.

## Stack

- electron-vite + Electron 39
- React 19, TypeScript 5.9, Vite 7
- Tailwind v4 (`@tailwindcss/vite`) + `tw-animate-css`
- shadcn/ui (style: new-york, baseColor: neutral, icons: lucide)

## Scripts

```bash
yarn install
yarn dev          # run in development
yarn typecheck    # tsc --noEmit (node + web)
yarn lint         # eslint
yarn build        # typecheck + electron-vite build
yarn build:win    # package for Windows
```

## Layout

```
src/
├─ main/index.ts       # Electron main process (BrowserWindow lifecycle)
├─ preload/            # contextBridge stub + typings
└─ renderer/
   ├─ index.html
   └─ src/
      ├─ main.tsx, App.tsx
      ├─ assets/main.css        # Tailwind v4 + shadcn theme tokens
      ├─ lib/utils.ts           # cn() helper
      ├─ components/
      │  ├─ app-sidebar.tsx     # left sidebar w/ Settings at bottom
      │  └─ ui/                 # shadcn primitives
      └─ pages/
         └─ settings.tsx        # placeholder Settings page
```
