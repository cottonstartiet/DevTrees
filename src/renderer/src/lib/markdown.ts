import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

/**
 * Markdown rendering for the review workspace.
 *
 * Raw HTML is supported because providers and bots commonly use it in PR content. Every rendered
 * result is sanitized before it reaches the DOM. Links are never navigated in-app — preview
 * components intercept clicks and hand HTTP(S) URLs to `system.openExternal`.
 */
const md = new MarkdownIt({ html: true, linkify: true, typographer: false })
const SOURCE_MAP_NONCE = crypto.randomUUID()

const SAFE_STYLE_PROPERTIES = new Set([
  'align-items',
  'background-color',
  'border',
  'border-bottom',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-color',
  'border-left',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-radius',
  'border-right',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-style',
  'border-top',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-top-style',
  'border-top-width',
  'border-width',
  'color',
  'column-gap',
  'display',
  'flex-direction',
  'flex-wrap',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'height',
  'justify-content',
  'letter-spacing',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'row-gap',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space'
])

const BLOCKED_STYLE_VALUE = /(?:url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:)/i
const DISPLAY_VALUES = new Set(['block', 'flex', 'inline', 'inline-block', 'inline-flex', 'none'])
const SAFE_LENGTH = /^0$|^(?:\d+(?:\.\d+)?)(?:px|rem|em)$/
const SPACING_PROPERTY = /^(?:column-gap|gap|margin(?:-.+)?|padding(?:-.+)?|row-gap)$/

function safeLengthList(value: string, maxPixels: number, maxRelative: number): boolean {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((part) => {
      if (!SAFE_LENGTH.test(part)) return false
      const amount = Number.parseFloat(part)
      return part.endsWith('px') ? amount <= maxPixels : amount <= maxRelative
    })
}

function isSafeStyleValue(property: string, value: string): boolean {
  if (BLOCKED_STYLE_VALUE.test(value)) return false
  const normalized = value.trim().toLowerCase()
  if (property === 'display') return DISPLAY_VALUES.has(normalized)
  if (property === 'background-color' || property === 'color' || property.endsWith('-color')) {
    return CSS.supports('color', value)
  }
  if (property === 'border-style' || property.endsWith('-style')) {
    return /^(?:dashed|dotted|double|none|solid)(?:\s+(?:dashed|dotted|double|none|solid)){0,3}$/.test(
      normalized
    )
  }
  if (property === 'border-width' || property.endsWith('-width')) {
    return safeLengthList(value, 8, 0.5)
  }
  if (property === 'border-radius' || property.endsWith('-radius')) {
    return safeLengthList(value, 32, 2)
  }
  if (SPACING_PROPERTY.test(property)) return safeLengthList(value, 64, 4)
  if (property === 'font-size') return safeLengthList(value, 32, 2)
  if (property === 'height') {
    if (!SAFE_LENGTH.test(normalized)) return false
    const amount = Number.parseFloat(normalized)
    if (normalized.endsWith('px')) return amount <= 200
    return amount <= 12
  }
  return true
}

function sanitizeInlineStyle(value: string): string {
  const probe = document.createElement('span')
  const normalizedProviderStyles = value
    .replace(
      /rgba\(\s*var\(--[^)]+\)\s*,\s*[^)]+\)/gi,
      'color-mix(in oklab, currentColor 18%, transparent)'
    )
    .replace(/var\(--text-secondary-color\)/gi, 'currentColor')
  probe.setAttribute('style', normalizedProviderStyles)
  const declarations: string[] = []

  for (const property of Array.from(probe.style)) {
    if (!SAFE_STYLE_PROPERTIES.has(property)) continue
    const propertyValue = probe.style.getPropertyValue(property).trim()
    if (!propertyValue || !isSafeStyleValue(property, propertyValue)) continue
    declarations.push(`${property}: ${propertyValue}`)
  }

  return declarations.join('; ')
}

DOMPurify.addHook('uponSanitizeAttribute', (_node, event) => {
  if (event.attrName !== 'style') return
  const style = sanitizeInlineStyle(event.attrValue)
  if (!style) {
    event.keepAttr = false
    return
  }
  event.attrValue = style
})

function sanitizeRenderedHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    ADD_ATTR: ['data-src-start', 'data-src-end'],
    FORBID_ATTR: ['class', 'download', 'height', 'id', 'name', 'ping', 'srcdoc', 'target', 'width'],
    FORBID_TAGS: [
      'audio',
      'base',
      'button',
      'canvas',
      'embed',
      'form',
      'iframe',
      'input',
      'link',
      'meta',
      'object',
      'option',
      'script',
      'select',
      'source',
      'style',
      'template',
      'textarea',
      'track',
      'video'
    ]
  })

  const template = document.createElement('template')
  template.innerHTML = sanitized
  for (const element of template.content.querySelectorAll(
    `[${SRC_START_ATTR}], [${SRC_END_ATTR}]`
  )) {
    const start = trustedSourceLine(element.getAttribute(SRC_START_ATTR))
    const end = trustedSourceLine(element.getAttribute(SRC_END_ATTR))
    if (start && end) {
      element.setAttribute(SRC_START_ATTR, start)
      element.setAttribute(SRC_END_ATTR, end)
    } else {
      element.removeAttribute(SRC_START_ATTR)
      element.removeAttribute(SRC_END_ATTR)
    }
  }
  return template.innerHTML
}

function trustedSourceLine(value: string | null): string | null {
  const prefix = `${SOURCE_MAP_NONCE}:`
  if (!value?.startsWith(prefix)) return null
  const line = value.slice(prefix.length)
  return /^\d+$/.test(line) ? line : null
}

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
    token.attrSet(SRC_START_ATTR, `${SOURCE_MAP_NONCE}:${start + 1}`)
    token.attrSet(SRC_END_ATTR, `${SOURCE_MAP_NONCE}:${Math.max(start + 1, end)}`)
  }
}

export function renderMarkdownWithSourceMap(text: string): string {
  const env = {}
  const tokens = md.parse(text, env)
  stampSourceMap(tokens)
  return sanitizeRenderedHtml(md.renderer.render(tokens, md.options, env))
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

    const html = sanitizeRenderedHtml(md.renderer.render(group, md.options, env))
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
  return sanitizeRenderedHtml(md.render(text))
}

/** Render Markdown and provider HTML as normalized text for compact summaries. */
export function markdownToPlainText(text: string): string {
  const container = document.createElement('div')
  container.innerHTML = renderMarkdown(text)
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
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
