import MarkdownIt from 'markdown-it'

/**
 * Markdown rendering for the review workspace.
 *
 * `html: false` is deliberate: PR bodies and file contents are untrusted input, so raw HTML is
 * escaped rather than rendered. Links are never navigated in-app — the preview component
 * intercepts clicks and hands the URL to `system.openExternal`.
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

/**
 * The token type is derived from `parse` rather than imported: markdown-it ships its own types
 * while `@types/markdown-it` is also installed, and the two disagree about `Token.attrs`.
 */
type Token = ReturnType<(typeof md)['parse']>[number]

/** Attribute carrying the 1-based first source line of a rendered block. */
export const SRC_START_ATTR = 'data-src-start'
/** Attribute carrying the 1-based last source line of a rendered block. */
export const SRC_END_ATTR = 'data-src-end'

/**
 * Render markdown, stamping every block with the raw line range it came from.
 *
 * `markdown-it` gives each block token a `map` of `[startLine, endLine)` in 0-based lines; those
 * become inclusive 1-based `data-src-start` / `data-src-end` attributes. This is what lets a
 * comment made on the rendered preview be posted as an ordinary file + line-range comment.
 *
 * Nested blocks are stamped too, so clicking a single list item anchors to that item rather than
 * to the whole list.
 */
function stampSourceMap(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.nesting === -1 || !token.map) continue
    const [start, end] = token.map
    token.attrSet(SRC_START_ATTR, String(start + 1))
    token.attrSet(SRC_END_ATTR, String(Math.max(start + 1, end)))
  }
}

export function renderMarkdownWithSourceMap(text: string): string {
  const env = {}
  const tokens = md.parse(text, env)
  stampSourceMap(tokens)
  return md.renderer.render(tokens, md.options, env)
}

/** Fields every block carries, whatever it renders as. */
type MarkdownBlockBase = {
  /** Stable within one render of one document. */
  key: string
  startLine: number
  endLine: number
}

/**
 * One top-level markdown block and the raw lines it was generated from.
 *
 * The line range is derived from `token.map`, never from the rendered output, so a `mermaid` block
 * anchors comments exactly like any other block.
 */
export type MarkdownBlock =
  | (MarkdownBlockBase & { kind: 'html'; html: string })
  | (MarkdownBlockBase & { kind: 'mermaid'; code: string; info: string })

/**
 * A fenced block that should render as a diagram rather than as code.
 *
 * The info string may carry trailing metadata (```` ```mermaid title="x" ````), so only the first
 * word is matched.
 */
function mermaidFenceOf(group: Token[]): Token | null {
  if (group.length !== 1) return null
  const token = group[0]
  if (token.type !== 'fence') return null
  const lang = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return lang === 'mermaid' ? token : null
}

/**
 * Split a markdown document into separately-rendered top-level blocks.
 *
 * The document is parsed **once** with a single `env` and only the token stream is split; each
 * group is then rendered with that same `env`. Parsing per block instead would lose everything
 * that lives in `env` — link reference definitions and footnotes — and silently break those
 * documents.
 *
 * Rendering block by block is what lets the preview interleave React nodes (comment threads, the
 * composer) between blocks instead of emitting the document as one opaque HTML string.
 */
export function renderMarkdownBlocks(text: string): MarkdownBlock[] {
  const env = {}
  const tokens = md.parse(text, env)
  stampSourceMap(tokens)

  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < tokens.length) {
    const start = index
    let depth = 0

    // A group runs from a top-level opening token until nesting returns to zero, so container
    // blocks (lists, blockquotes, tables) render whole and produce valid HTML.
    do {
      depth += tokens[index].nesting
      index += 1
    } while (index < tokens.length && depth > 0)

    const group = tokens.slice(start, index)
    const mapped = group.find((token) => token.map)
    if (!mapped?.map) continue

    const [mapStart, mapEnd] = mapped.map
    const base: MarkdownBlockBase = {
      key: `${start}:${mapStart}`,
      startLine: mapStart + 1,
      endLine: Math.max(mapStart + 1, mapEnd)
    }

    const mermaid = mermaidFenceOf(group)
    if (mermaid) {
      // An empty fence has nothing to render and no useful source to show; drop it like any other
      // block that renders to nothing.
      if (!mermaid.content.trim()) continue
      blocks.push({ ...base, kind: 'mermaid', code: mermaid.content, info: mermaid.info.trim() })
      continue
    }

    const html = md.renderer.render(group, md.options, env)
    if (!html.trim()) continue

    blocks.push({ ...base, kind: 'html', html })
  }

  return blocks
}

/**
 * Index of the block a raw line belongs to.
 *
 * Falls back to the nearest preceding block when the line sits between blocks (blank lines) or the
 * comment has drifted past the end of the document, so an existing comment is never silently
 * dropped from the preview.
 */
export function blockIndexForLine(blocks: MarkdownBlock[], line: number): number {
  let fallback = -1
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (line >= block.startLine && line <= block.endLine) return index
    if (block.startLine <= line) fallback = index
  }
  return fallback
}

/** Render markdown without source maps — used for comment bodies and the PR description. */
export function renderMarkdown(text: string): string {
  return md.render(text)
}

/**
 * Walk up from `element` to the nearest block carrying a source range.
 *
 * Returns `null` when the node is outside any mapped block (e.g. the preview's own padding).
 */
export function sourceRangeOf(
  element: Element | null,
  root: Element
): { startLine: number; endLine: number } | null {
  let current: Element | null = element
  while (current && current !== root) {
    const start = current.getAttribute(SRC_START_ATTR)
    const end = current.getAttribute(SRC_END_ATTR)
    if (start && end) {
      const startLine = Number.parseInt(start, 10)
      const endLine = Number.parseInt(end, 10)
      if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
        return { startLine, endLine: Math.max(startLine, endLine) }
      }
    }
    current = current.parentElement
  }
  return null
}

/**
 * Resolve a DOM selection to the tightest source-line range that covers it.
 *
 * Inline tokens carry no map, so a selection inside a paragraph resolves to that whole paragraph.
 * The composer always shows the resolved range so the anchor is never a surprise.
 */
export function selectionSourceRange(
  selection: Selection | null,
  root: Element
): { startLine: number; endLine: number } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const startEl = elementOf(range.startContainer)
  const endEl = elementOf(range.endContainer)
  const start = sourceRangeOf(startEl, root)
  const end = sourceRangeOf(endEl, root) ?? start
  if (!start || !end) return null

  return {
    startLine: Math.min(start.startLine, end.startLine),
    endLine: Math.max(start.endLine, end.endLine)
  }
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}
