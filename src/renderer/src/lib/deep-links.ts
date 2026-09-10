import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'

const MAX_SOURCE_URL_LENGTH = 8_192
const MAX_PAGE_TITLE_LENGTH = 500
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g

export type BrowserCodeReviewAction = {
  kind: 'browser-code-review'
  sourceUrl: string
  pageTitle: string
  host: string
  repositoryName: string | null
}

export type BrowserCodeReviewDraft = BrowserCodeReviewAction & {
  id: string
  title: string
  description: string
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function repositoryNameFromSourceUrl(source: URL): string | null {
  const segments = source.pathname.split('/').filter(Boolean).map(safeDecode)
  const host = source.hostname.toLowerCase()

  if (host === 'github.com' && segments.length >= 2) {
    return segments[1].replace(/\.git$/i, '') || null
  }

  if (host === 'dev.azure.com') {
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git')
    return gitIndex >= 0 ? (segments[gitIndex + 1] ?? null) : null
  }

  if (host.endsWith('.visualstudio.com')) {
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git')
    return gitIndex >= 0 ? (segments[gitIndex + 1] ?? null) : null
  }

  return null
}

export function parseDevTreesDeepLink(rawUrl: string): BrowserCodeReviewAction {
  let deepLink: URL
  try {
    deepLink = new URL(rawUrl)
  } catch {
    throw new Error('DevTrees received an invalid link.')
  }

  if (
    deepLink.protocol !== 'devtrees:' ||
    deepLink.hostname !== 'tasks' ||
    deepLink.pathname !== '/new' ||
    deepLink.searchParams.get('intent') !== 'code-review'
  ) {
    throw new Error('This DevTrees link is not supported.')
  }

  const rawSourceUrl = deepLink.searchParams.get('url') ?? ''
  if (!rawSourceUrl || rawSourceUrl.length > MAX_SOURCE_URL_LENGTH) {
    throw new Error('The browser page URL is missing or too long.')
  }

  let source: URL
  try {
    source = new URL(rawSourceUrl)
  } catch {
    throw new Error('The browser page URL is invalid.')
  }
  if (source.protocol !== 'http:' && source.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS browser pages can start a code review.')
  }

  const pageTitle = (deepLink.searchParams.get('title') ?? '').trim()
  if (pageTitle.length > MAX_PAGE_TITLE_LENGTH) {
    throw new Error('The browser page title is too long.')
  }

  return {
    kind: 'browser-code-review',
    sourceUrl: source.toString(),
    pageTitle,
    host: source.host,
    repositoryName: repositoryNameFromSourceUrl(source)
  }
}

export function resolveBrowserCodeReviewPrompt(
  template: string,
  action: BrowserCodeReviewAction
): string {
  const values: Record<string, string> = {
    url: action.sourceUrl,
    pageTitle: action.pageTitle || action.host,
    host: action.host
  }
  const unknown = new Set<string>()
  const resolved = template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    if (!(name in values)) {
      unknown.add(name)
      return ''
    }
    return values[name]
  })
  if (unknown.size > 0) {
    throw new Error(`Unsupported saved-prompt placeholder: ${[...unknown].join(', ')}.`)
  }
  return resolved
}

export function createBrowserCodeReviewDraft(
  action: BrowserCodeReviewAction,
  template: string
): BrowserCodeReviewDraft {
  const subject = action.pageTitle || action.host
  return {
    ...action,
    id: crypto.randomUUID(),
    title: `Code review: ${subject}`.slice(0, 200),
    description: resolveBrowserCodeReviewPrompt(template, action)
  }
}

export async function subscribeToDevTreesDeepLinks(
  onUrl: (url: string) => void
): Promise<() => void> {
  const receivedWhileStarting = new Set<string>()
  let starting = true
  const unlisten = await onOpenUrl((urls) => {
    urls.forEach((url) => {
      if (starting) receivedWhileStarting.add(url)
      onUrl(url)
    })
  })
  const initialUrls = await getCurrent()
  initialUrls?.forEach((url) => {
    if (!receivedWhileStarting.has(url)) onUrl(url)
  })
  starting = false
  receivedWhileStarting.clear()
  return unlisten
}
