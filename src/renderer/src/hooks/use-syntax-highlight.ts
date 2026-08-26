import * as React from 'react'

import { useTheme } from '@/contexts/theme-context'

/** Extension → shiki language id for the languages this app realistically shows in a diff. */
const LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  rs: 'rust',
  css: 'css',
  html: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shellscript',
  ps1: 'powershell',
  py: 'python',
  go: 'go',
  sql: 'sql'
}

export function languageForPath(path: string): string | null {
  const idx = path.lastIndexOf('.')
  if (idx < 0) return null
  return LANGS[path.slice(idx + 1).toLowerCase()] ?? null
}

type Highlighter = {
  codeToTokens: (
    code: string,
    options: { lang: string; theme: string }
  ) => { tokens: { content: string; color?: string }[][] }
}

const highlighterCache = new Map<string, Promise<Highlighter | null>>()

function loadHighlighter(lang: string, theme: string): Promise<Highlighter | null> {
  const key = `${lang}::${theme}`
  const cached = highlighterCache.get(key)
  if (cached) return cached

  // Loaded lazily so the workspace paints before the (large) grammar bundles arrive; a failure
  // just means plain monospace text.
  const promise = import('shiki')
    .then((shiki) => shiki.createHighlighter({ langs: [lang], themes: [theme] }))
    .then((highlighter) => highlighter as unknown as Highlighter)
    .catch(() => null)
  highlighterCache.set(key, promise)
  return promise
}

/** One highlighted line: a list of coloured spans. */
export type HighlightedLine = { content: string; color?: string }[]

/**
 * Syntax-highlight `lines` (already split, in file order) for `path`.
 *
 * Returns `null` while loading, for unsupported languages, or if shiki fails — callers then render
 * the raw text, which is always correct, just uncoloured.
 */
export function useSyntaxHighlight(path: string | null, lines: string[]): HighlightedLine[] | null {
  const { resolvedTheme } = useTheme()
  // The result carries the input it was produced for, so a stale result is discarded on read
  // instead of being cleared from an effect.
  const [result, setResult] = React.useState<{ key: string; lines: HighlightedLine[] } | null>(null)

  const lang = path ? languageForPath(path) : null
  const theme = resolvedTheme === 'dark' ? 'github-dark' : 'github-light'
  const code = React.useMemo(() => lines.join('\n'), [lines])
  const key = `${lang ?? ''}::${theme}::${code}`

  React.useEffect(() => {
    let cancelled = false
    if (!lang || code.length === 0 || code.length > 400_000) return

    void loadHighlighter(lang, theme).then((highlighter) => {
      if (cancelled || !highlighter) return
      try {
        const { tokens } = highlighter.codeToTokens(code, { lang, theme })
        setResult({
          key,
          lines: tokens.map((line) => line.map(({ content, color }) => ({ content, color })))
        })
      } catch {
        // Leave the previous result in place; a stale key means callers fall back to raw text.
      }
    })

    return () => {
      cancelled = true
    }
  }, [lang, theme, code, key])

  return result?.key === key ? result.lines : null
}
