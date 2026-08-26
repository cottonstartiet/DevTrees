import * as React from 'react'

import { useTheme } from '@/contexts/theme-context'

export type MermaidResult = { svg: string; error: null } | { svg: null; error: string }

type MermaidModule = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let modulePromise: Promise<MermaidModule | null> | null = null

/**
 * Load mermaid lazily.
 *
 * The library is ~1–2 MB of ESM, so it must never enter the initial chunk — the review workspace
 * has to paint long before a diagram does. A load failure resolves to `null` and callers fall back
 * to showing the fence source.
 */
function loadMermaid(): Promise<MermaidModule | null> {
  modulePromise ??= import('mermaid')
    .then((mod) => (mod.default ?? mod) as unknown as MermaidModule)
    .catch(() => null)
  return modulePromise
}

const cache = new Map<string, Promise<MermaidResult>>()

/**
 * Renders are serialised: mermaid keeps global configuration and measures text by inserting
 * temporary nodes into the document, so concurrent calls interleave and corrupt each other.
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Ids leak into the generated SVG's `<defs>` / `<marker>` references, so a collision between two
 * diagrams on the same page silently breaks arrowheads. A monotonic counter avoids that; the block
 * key cannot, because two documents can produce the same key.
 */
let nextId = 0

function cacheKey(code: string, theme: string): string {
  return `${theme}::${code}`
}

function renderMermaid(code: string, theme: string): Promise<MermaidResult> {
  const key = cacheKey(code, theme)
  const cached = cache.get(key)
  if (cached) return cached

  const promise: Promise<MermaidResult> = queue.then(async (): Promise<MermaidResult> => {
    const mermaid = await loadMermaid()
    if (!mermaid) return { svg: null, error: 'Diagram engine could not be loaded' }

    try {
      // File contents are untrusted PR input, so labels are HTML-encoded and the `click` directive
      // is disabled. `sandbox` would be stronger but renders into an iframe, which breaks sizing
      // and text selection inside the review pane.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'dark' ? 'dark' : 'default',
        // A concrete stack, not `inherit`: mermaid measures label boxes in a detached element
        // where `inherit` resolves to the wrong font and the boxes come out mis-sized.
        fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      })
      nextId += 1
      const { svg } = await mermaid.render(`md-mermaid-${nextId}`, code)
      return { svg, error: null }
    } catch (error) {
      return { svg: null, error: error instanceof Error ? error.message : String(error) }
    }
  })

  queue = promise
  cache.set(key, promise)
  return promise
}

export type MermaidState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; error: string }

/**
 * Render a mermaid diagram, re-rendering when the app theme flips.
 *
 * The result carries the key it was produced for so a stale result is discarded on read rather
 * than cleared from an effect, which `react-hooks/set-state-in-effect` forbids.
 */
export function useMermaid(code: string): MermaidState {
  const { resolvedTheme } = useTheme()
  const key = cacheKey(code, resolvedTheme)
  const [result, setResult] = React.useState<{ key: string; result: MermaidResult } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void renderMermaid(code, resolvedTheme).then((value) => {
      if (!cancelled) setResult({ key: cacheKey(code, resolvedTheme), result: value })
    })
    return () => {
      cancelled = true
    }
  }, [code, resolvedTheme])

  if (result?.key !== key) return { status: 'loading' }
  if (result.result.svg === null) return { status: 'error', error: result.result.error }
  return { status: 'ready', svg: result.result.svg }
}
