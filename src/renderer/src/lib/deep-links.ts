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

export type PullRequestProvider = 'github' | 'ado'

export type PullRequestRemoteIdentity = {
  provider: PullRequestProvider
  host: string
  organization: string
  project: string | null
  repositoryName: string
}

export type BrowserPullRequestReviewAction = PullRequestRemoteIdentity & {
  kind: 'browser-pull-request-review'
  sourceUrl: string
  pageTitle: string
  pullRequestId: number
}

export type AppNavigationAction = {
  kind: 'navigate'
  view: 'dashboard'
}

export type SWEFactoryDeepLinkAction =
  | BrowserCodeReviewAction
  | BrowserPullRequestReviewAction
  | AppNavigationAction

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

function trimGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '')
}

function parsePullRequestId(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function pullRequestIdentityFromSourceUrl(
  source: URL
): (PullRequestRemoteIdentity & { pullRequestId: number }) | null {
  const host = source.hostname.toLowerCase()
  const segments = source.pathname.split('/').filter(Boolean).map(safeDecode)

  if (host === 'github.com') {
    if (segments.length < 4 || segments[2].toLowerCase() !== 'pull') return null
    const pullRequestId = parsePullRequestId(segments[3])
    if (!pullRequestId) return null
    return {
      provider: 'github',
      host,
      organization: segments[0],
      project: null,
      repositoryName: trimGitSuffix(segments[1]),
      pullRequestId
    }
  }

  const isDevAzure = host === 'dev.azure.com'
  const visualStudioMatch = host.match(/^([^.]+)\.visualstudio\.com$/)
  if (!isDevAzure && !visualStudioMatch) return null

  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git')
  if (gitIndex < 0 || segments[gitIndex + 2]?.toLowerCase() !== 'pullrequest') return null
  const pullRequestId = parsePullRequestId(segments[gitIndex + 3])
  const repositoryName = segments[gitIndex + 1]
  if (!pullRequestId || !repositoryName) return null

  if (isDevAzure && (gitIndex === 1 || gitIndex === 2)) {
    return {
      provider: 'ado',
      host,
      organization: segments[0],
      project: gitIndex === 2 ? segments[1] : null,
      repositoryName: trimGitSuffix(repositoryName),
      pullRequestId
    }
  }

  if (visualStudioMatch && gitIndex === 1) {
    return {
      provider: 'ado',
      host,
      organization: visualStudioMatch[1],
      project: segments[0],
      repositoryName: trimGitSuffix(repositoryName),
      pullRequestId
    }
  }

  return null
}

function remoteUrlParts(rawUrl: string): { host: string; segments: string[] } | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  const scpLike = trimmed.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/)
  if (scpLike && !trimmed.includes('://')) {
    return {
      host: scpLike[1].toLowerCase(),
      segments: scpLike[2].split('/').filter(Boolean).map(safeDecode)
    }
  }

  try {
    const remote = new URL(trimmed)
    return {
      host: remote.hostname.toLowerCase(),
      segments: remote.pathname.split('/').filter(Boolean).map(safeDecode)
    }
  } catch {
    return null
  }
}

export function pullRequestIdentityFromRemoteUrl(rawUrl: string): PullRequestRemoteIdentity | null {
  const parts = remoteUrlParts(rawUrl)
  if (!parts) return null
  const { host, segments } = parts

  if (host === 'github.com' && segments.length >= 2) {
    return {
      provider: 'github',
      host,
      organization: segments[0],
      project: null,
      repositoryName: trimGitSuffix(segments[1])
    }
  }

  if (host === 'dev.azure.com') {
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git')
    if ((gitIndex === 2 || gitIndex === 1) && segments[gitIndex + 1]) {
      return {
        provider: 'ado',
        host,
        organization: segments[0],
        project: gitIndex === 2 ? segments[1] : null,
        repositoryName: trimGitSuffix(segments[gitIndex + 1])
      }
    }
  }

  const visualStudioMatch = host.match(/^([^.]+)\.visualstudio\.com$/)
  if (visualStudioMatch) {
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git')
    if (gitIndex === 1 && segments[gitIndex + 1]) {
      return {
        provider: 'ado',
        host,
        organization: visualStudioMatch[1],
        project: segments[0],
        repositoryName: trimGitSuffix(segments[gitIndex + 1])
      }
    }
  }

  if (host === 'ssh.dev.azure.com' || host.endsWith('.vs-ssh.visualstudio.com')) {
    const offset = segments[0]?.toLowerCase() === 'v3' ? 1 : 0
    if (segments.length >= offset + 3) {
      return {
        provider: 'ado',
        host,
        organization: segments[offset],
        project: segments[offset + 1],
        repositoryName: trimGitSuffix(segments[offset + 2])
      }
    }
  }

  return null
}

export function pullRequestRemoteIdentitiesMatch(
  source: PullRequestRemoteIdentity,
  remote: PullRequestRemoteIdentity
): boolean {
  const equal = (left: string, right: string): boolean =>
    left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0

  return (
    source.provider === remote.provider &&
    equal(source.organization, remote.organization) &&
    equal(source.repositoryName, remote.repositoryName) &&
    (source.project === null || (remote.project !== null && equal(source.project, remote.project)))
  )
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

export function parseSweFactoryDeepLink(rawUrl: string): SWEFactoryDeepLinkAction {
  let deepLink: URL
  try {
    deepLink = new URL(rawUrl)
  } catch {
    throw new Error('SWE Factory received an invalid link.')
  }

  if (deepLink.protocol !== 'swefactory:') {
    throw new Error('This SWE Factory link is not supported.')
  }

  if (deepLink.hostname === 'navigate') {
    if (
      deepLink.pathname !== '/dashboard' ||
      deepLink.search !== '' ||
      deepLink.hash !== '' ||
      deepLink.username !== '' ||
      deepLink.password !== '' ||
      deepLink.port !== ''
    ) {
      throw new Error('This SWE Factory navigation link is not supported.')
    }
    return { kind: 'navigate', view: 'dashboard' }
  }

  if (deepLink.hostname === 'reviews' && deepLink.pathname === '/pull-request') {
    if (
      deepLink.hash !== '' ||
      deepLink.username !== '' ||
      deepLink.password !== '' ||
      deepLink.port !== ''
    ) {
      throw new Error('This SWE Factory pull request link is not supported.')
    }

    const rawSourceUrl = deepLink.searchParams.get('url') ?? ''
    if (!rawSourceUrl || rawSourceUrl.length > MAX_SOURCE_URL_LENGTH) {
      throw new Error('The pull request URL is missing or too long.')
    }

    let source: URL
    try {
      source = new URL(rawSourceUrl)
    } catch {
      throw new Error('The pull request URL is invalid.')
    }
    if (source.protocol !== 'http:' && source.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS pull request pages can be reviewed.')
    }

    const identity = pullRequestIdentityFromSourceUrl(source)
    if (!identity) {
      throw new Error('Open a supported GitHub or Azure DevOps pull request page.')
    }

    const pageTitle = (deepLink.searchParams.get('title') ?? '').trim()
    if (pageTitle.length > MAX_PAGE_TITLE_LENGTH) {
      throw new Error('The browser page title is too long.')
    }

    return {
      kind: 'browser-pull-request-review',
      sourceUrl: source.toString(),
      pageTitle,
      ...identity
    }
  }

  if (
    deepLink.hostname !== 'tasks' ||
    deepLink.pathname !== '/new' ||
    deepLink.searchParams.get('intent') !== 'code-review'
  ) {
    throw new Error('This SWE Factory link is not supported.')
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

export async function subscribeToSweFactoryDeepLinks(
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
