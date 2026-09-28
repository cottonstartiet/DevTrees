import type { LocalReviewTarget } from '@/hooks/use-local-review'
import type { PrReviewTarget } from '@/hooks/use-pr-review'

const MAX_QUERY_LENGTH = 65_536
const MAX_FOLDER_PATH_LENGTH = 32_768
const MAX_TITLE_LENGTH = 1_024
const MAX_BRANCH_LABEL_LENGTH = 1_024
const MAX_NATIVE_TITLE_LENGTH = 240
const ALLOWED_PARAMETERS = new Set([
  'kind',
  'folderPath',
  'provider',
  'pullRequestId',
  'title',
  'branchLabel'
])

export type OpenPrReviewRequest = PrReviewTarget & { title?: string }
export type OpenLocalReviewRequest = LocalReviewTarget
export type OpenReviewRequest =
  | ({ kind: 'pr' } & OpenPrReviewRequest)
  | ({ kind: 'local' } & OpenLocalReviewRequest)

function isValidRequiredString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !value.includes('\0')
  )
}

function isValidOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isValidRequiredString(value, maxLength)
}

function isValidPullRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isValidRequest(request: unknown): request is OpenReviewRequest {
  if (!request || typeof request !== 'object') return false
  const candidate = request as Partial<OpenReviewRequest>
  if (!isValidRequiredString(candidate.folderPath, MAX_FOLDER_PATH_LENGTH)) return false

  if (candidate.kind === 'pr') {
    const pr = candidate as Partial<Extract<OpenReviewRequest, { kind: 'pr' }>>
    return (
      (pr.remoteKind === 'ado' || pr.remoteKind === 'github') &&
      isValidPullRequestId(pr.pullRequestId) &&
      isValidOptionalString(pr.title, MAX_TITLE_LENGTH)
    )
  }

  if (candidate.kind === 'local') {
    const local = candidate as Partial<Extract<OpenReviewRequest, { kind: 'local' }>>
    return isValidOptionalString(local.branchLabel, MAX_BRANCH_LABEL_LENGTH)
  }

  return false
}

function appendOptional(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) params.set(key, value)
}

export function serializeReviewWindowRequest(request: OpenReviewRequest): string {
  if (!isValidRequest(request)) throw new Error('Invalid review window request.')

  const params = new URLSearchParams()
  params.set('kind', request.kind)
  params.set('folderPath', request.folderPath)
  if (request.kind === 'pr') {
    params.set('provider', request.remoteKind)
    params.set('pullRequestId', String(request.pullRequestId))
    appendOptional(params, 'title', request.title)
  } else {
    appendOptional(params, 'branchLabel', request.branchLabel)
  }
  const query = params.toString()
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(
      `Review window request is too large: the encoded query exceeds ${MAX_QUERY_LENGTH.toLocaleString('en-US')} characters.`
    )
  }
  return `?${query}`
}

function parseQuery(search: string): Map<string, string> | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (!query || query.length > MAX_QUERY_LENGTH) return null

  const values = new Map<string, string>()
  for (const pair of query.split('&')) {
    if (!pair) return null
    const separator = pair.indexOf('=')
    const rawKey = separator < 0 ? pair : pair.slice(0, separator)
    const rawValue = separator < 0 ? '' : pair.slice(separator + 1)
    let key: string
    let value: string
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      return null
    }
    if (!ALLOWED_PARAMETERS.has(key) || values.has(key)) return null
    values.set(key, value)
  }
  return values
}

export function parseReviewWindowRequest(search: string): OpenReviewRequest | null {
  const values = parseQuery(search)
  if (!values) return null

  const kind = values.get('kind')
  const folderPath = values.get('folderPath')
  if (!isValidRequiredString(folderPath, MAX_FOLDER_PATH_LENGTH)) return null

  if (kind === 'pr') {
    if (values.has('branchLabel')) return null
    const provider = values.get('provider')
    const rawPullRequestId = values.get('pullRequestId')
    const title = values.get('title')
    if (
      (provider !== 'ado' && provider !== 'github') ||
      !rawPullRequestId ||
      !/^[1-9][0-9]*$/.test(rawPullRequestId) ||
      !isValidOptionalString(title, MAX_TITLE_LENGTH)
    ) {
      return null
    }
    const pullRequestId = Number(rawPullRequestId)
    if (!isValidPullRequestId(pullRequestId)) return null
    return { kind, folderPath, remoteKind: provider, pullRequestId, ...(title ? { title } : {}) }
  }

  if (kind === 'local') {
    if (values.has('provider') || values.has('pullRequestId') || values.has('title')) return null
    const branchLabel = values.get('branchLabel')
    if (!isValidOptionalString(branchLabel, MAX_BRANCH_LABEL_LENGTH)) return null
    return { kind, folderPath, ...(branchLabel ? { branchLabel } : {}) }
  }

  return null
}

function reviewIdentity(request: OpenReviewRequest): string {
  if (request.kind === 'pr') {
    return `pr\0${request.folderPath}\0${request.remoteKind}\0${request.pullRequestId}`
  }

  const baseIdentity = `local\0${request.folderPath}`
  return request.branchLabel === undefined
    ? baseIdentity
    : `${baseIdentity}\0${request.branchLabel.normalize('NFC')}`
}

function fnv1a64(value: string, offset: bigint): string {
  let hash = offset
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

export function reviewWindowLabel(request: OpenReviewRequest): string {
  if (!isValidRequest(request)) throw new Error('Invalid review window request.')
  const identity = reviewIdentity(request)
  const hash = fnv1a64(identity, 0xcbf29ce484222325n) + fnv1a64(identity, 0x84222325cbf29ce4n)
  return `review-${request.kind}-${hash}`
}

function folderName(folderPath: string): string {
  const withoutTrailingSeparators = folderPath.replace(/[\\/]+$/, '')
  const name = withoutTrailingSeparators.split(/[\\/]/).pop()
  return name || 'Repository'
}

function truncateTitle(title: string): string {
  if (title.length <= MAX_NATIVE_TITLE_LENGTH) return title
  return `${title.slice(0, MAX_NATIVE_TITLE_LENGTH - 1).trimEnd()}…`
}

export function initialReviewWindowTitle(request: OpenReviewRequest): string {
  if (!isValidRequest(request)) throw new Error('Invalid review window request.')
  const repository = folderName(request.folderPath)
  if (request.kind === 'pr') {
    const detail = request.title ? `: ${request.title}` : ''
    return truncateTitle(`${repository} — PR #${request.pullRequestId}${detail}`)
  }
  const branch = request.branchLabel ? ` (${request.branchLabel})` : ''
  return truncateTitle(`${repository} — Local changes${branch}`)
}
