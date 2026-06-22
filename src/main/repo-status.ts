import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { shell } from 'electron'

import type {
  CommitRequest,
  CommitResult,
  CreateBranchResult,
  DetectMergeStateRequest,
  DetectMergeStateResult,
  DiscardAllChangesRequest,
  DiscardAllChangesResult,
  ExistingPullRequest,
  FetchResult,
  FindPullRequestRequest,
  FindPullRequestResult,
  OpenPullRequestRequest,
  OpenPullRequestResult,
  PullResult,
  PushRequest,
  PushResult,
  RebaseOnDefaultRequest,
  RebaseOnDefaultResult,
  RecentCommit,
  RecentCommitsRequest,
  RecentCommitsResult,
  RepoStatus,
  StageFilesRequest,
  StageFilesResult,
  UnpushedCommitsRequest,
  UnpushedCommitsResult,
  UnstageFilesRequest,
  UnstageFilesResult,
  RevertFilesRequest,
  RevertFilesResult,
  WorkingCopyEntry,
  WorkingCopyStatusRequest,
  WorkingCopyStatusResult,
  WorktreeOverviewRow,
  WorktreesOverviewRequest,
  WorktreesOverviewResult
} from '../shared/repo'
import type {
  AdoErrorCode,
  AdoMyOpenPr,
  AdoMyOpenPrsRequest,
  AdoMyOpenPrsResult,
  AdoPrComment,
  AdoPrCommentAuthor,
  AdoPrDetails,
  AdoPrDetailsRequest,
  AdoPrDetailsResult,
  AdoPrThread,
  AdoPrThreadStatus,
  AdoPrThreadsRequest,
  AdoPrThreadsResult,
  AdoReviewer,
  AdoReviewerVote
} from '../shared/ado'
import { GitError, runGit } from './git'
import { listWorktrees } from './worktrees'

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(args, cwd)
    return stdout.trim()
  } catch {
    return null
  }
}

export async function getDefaultBranch(workspacePath: string): Promise<string | null> {
  const symbolic = await tryGit(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    workspacePath
  )
  if (symbolic) {
    return symbolic.startsWith('origin/') ? symbolic.slice('origin/'.length) : symbolic
  }

  const lsRemote = await tryGit(['ls-remote', '--symref', 'origin', 'HEAD'], workspacePath)
  if (lsRemote) {
    const line = lsRemote.split(/\r?\n/).find((l) => l.startsWith('ref:'))
    if (line) {
      const match = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/)
      if (match) return match[1]
    }
  }

  for (const candidate of ['main', 'master']) {
    const exists = await tryGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`],
      workspacePath
    )
    if (exists !== null) return candidate
  }
  return null
}

export async function getCurrentBranch(folderPath: string): Promise<string | null> {
  const out = await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], folderPath)
  if (!out || out === 'HEAD') return null
  return out
}

async function hasRemoteBranch(workspacePath: string, branch: string): Promise<boolean> {
  const out = await tryGit(
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    workspacePath
  )
  return out !== null
}

export async function fetchRemote(workspacePath: string, branch?: string): Promise<FetchResult> {
  try {
    const args = branch ? ['fetch', 'origin', branch] : ['fetch', 'origin']
    await runGit(args, workspacePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'git fetch failed' }
  }
}

export async function getAheadBehind(workspacePath: string, branch: string): Promise<RepoStatus> {
  const fetchedAt = Date.now()
  const hasRemote = await hasRemoteBranch(workspacePath, branch)
  if (!hasRemote) {
    return { branch, ahead: 0, behind: 0, hasRemote: false, fetchedAt }
  }

  const localExists = await tryGit(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    workspacePath
  )
  if (localExists === null) {
    return { branch, ahead: 0, behind: 0, hasRemote: true, fetchedAt }
  }

  const out = await tryGit(
    ['rev-list', '--left-right', '--count', `refs/remotes/origin/${branch}...refs/heads/${branch}`],
    workspacePath
  )
  if (!out) {
    return { branch, ahead: 0, behind: 0, hasRemote: true, fetchedAt }
  }
  const parts = out.split(/\s+/)
  const behind = Number.parseInt(parts[0] ?? '0', 10) || 0
  const ahead = Number.parseInt(parts[1] ?? '0', 10) || 0
  return { branch, ahead, behind, hasRemote: true, fetchedAt }
}

function sanitizeAliasFragment(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
}

export async function getUserAlias(workspacePath: string): Promise<string> {
  const email = await tryGit(['config', '--get', 'user.email'], workspacePath)
  if (email) {
    const local = email.split('@')[0] ?? ''
    const cleaned = sanitizeAliasFragment(local)
    if (cleaned) return cleaned
  }
  const fallback = sanitizeAliasFragment(process.env.USERNAME ?? process.env.USER ?? '')
  return fallback || 'user'
}

const FULL_REF_VALID = /^[A-Za-z0-9._/-]+$/
const MAX_FULL_REF_LENGTH = 200

export async function createBranchInFolder(
  folderPath: string,
  fullName: string
): Promise<CreateBranchResult> {
  const trimmed = fullName.trim()
  if (
    !trimmed ||
    trimmed.length > MAX_FULL_REF_LENGTH ||
    !FULL_REF_VALID.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/')
  ) {
    return { ok: false, error: 'invalid-name', message: 'Invalid branch name.' }
  }

  try {
    await runGit(['switch', '-c', trimmed], folderPath)
    return { ok: true, branch: trimmed }
  } catch (err) {
    if (err instanceof GitError) {
      if (/already exists/i.test(err.message)) {
        return { ok: false, error: 'already-exists', message: err.message }
      }
      return { ok: false, error: 'git-failed', message: err.message }
    }
    return {
      ok: false,
      error: 'unknown',
      message: err instanceof Error ? err.message : 'git switch failed'
    }
  }
}

type AdoRemote = { org: string; project: string; repo: string }

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '')
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseAdoRemote(rawUrl: string): AdoRemote | null {
  const url = rawUrl.trim()
  if (!url) return null

  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+)$/i)
  if (httpsMatch) {
    let host = httpsMatch[1]
    let path = httpsMatch[2]
    const atIdx = host.indexOf('@')
    if (atIdx >= 0) host = host.slice(atIdx + 1)
    path = path.replace(/\/+$/, '')
    if (/^dev\.azure\.com$/i.test(host)) {
      // dev.azure.com/{org}/{project}/_git/{repo}
      const m = path.match(/^([^/]+)\/(.+?)\/_git\/([^/]+)$/)
      if (!m) return null
      return {
        org: safeDecode(m[1]),
        project: safeDecode(m[2]),
        repo: safeDecode(stripGitSuffix(m[3]))
      }
    }
    const vsMatch = host.match(/^([^.]+)\.visualstudio\.com$/i)
    if (vsMatch) {
      const org = vsMatch[1]
      // optionally /DefaultCollection prefix
      const stripped = path.replace(/^DefaultCollection\//i, '')
      const m = stripped.match(/^(.+?)\/_git\/([^/]+)$/)
      if (!m) return null
      return {
        org: safeDecode(org),
        project: safeDecode(m[1]),
        repo: safeDecode(stripGitSuffix(m[2]))
      }
    }
    return null
  }

  // SSH modern: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const sshModern = url.match(/^[^@]+@ssh\.dev\.azure\.com:v3\/(.+)$/i)
  if (sshModern) {
    const parts = sshModern[1].split('/')
    if (parts.length < 3) return null
    const [org, project, ...rest] = parts
    return {
      org: safeDecode(org),
      project: safeDecode(project),
      repo: safeDecode(stripGitSuffix(rest.join('/')))
    }
  }

  // SSH legacy: git@{org}.vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
  const sshLegacy = url.match(/^[^@]+@([^.]+)\.vs-ssh\.visualstudio\.com:v3\/(.+)$/i)
  if (sshLegacy) {
    const parts = sshLegacy[2].split('/')
    if (parts.length < 3) return null
    const [, project, ...rest] = parts
    return {
      org: safeDecode(sshLegacy[1]),
      project: safeDecode(project),
      repo: safeDecode(stripGitSuffix(rest.join('/')))
    }
  }

  return null
}

export function buildAdoPrWebUrl(remote: AdoRemote, pullRequestId: number): string {
  const org = encodeURIComponent(remote.org)
  const project = encodeURIComponent(remote.project)
  const repo = encodeURIComponent(remote.repo)
  return `https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequest/${pullRequestId}`
}

export function buildAdoCommitUrl(remote: AdoRemote, sha: string): string {
  const org = encodeURIComponent(remote.org)
  const project = encodeURIComponent(remote.project)
  const repo = encodeURIComponent(remote.repo)
  return `https://dev.azure.com/${org}/${project}/_git/${repo}/commit/${encodeURIComponent(sha)}`
}

export function buildAdoBranchUrl(remote: AdoRemote, branch: string): string {
  const org = encodeURIComponent(remote.org)
  const project = encodeURIComponent(remote.project)
  const repo = encodeURIComponent(remote.repo)
  // ADO uses version=GB<branch> with literal '/' preserved.
  const encodedBranch = encodeURIComponent(branch).replace(/%2F/gi, '/')
  return `https://dev.azure.com/${org}/${project}/_git/${repo}?version=GB${encodedBranch}`
}

export async function getAdoBranchWebUrl(
  folderPath: string,
  branch: string
): Promise<{ webUrl: string | null }> {
  if (!folderPath || !branch) return { webUrl: null }
  const remoteResolution = await resolveAdoRemote(folderPath)
  if (!remoteResolution.ok) return { webUrl: null }
  return { webUrl: buildAdoBranchUrl(remoteResolution.remote, branch) }
}

export function buildAdoPrThreadUrl(
  remote: AdoRemote,
  pullRequestId: number,
  threadId: number
): string {
  return `${buildAdoPrWebUrl(remote, pullRequestId)}?discussionId=${threadId}`
}

function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^%()!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

type AzRunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; reason: 'not-installed' }
  | { ok: false; reason: 'exec-failed'; stdout: string; stderr: string; code: number | null }

async function runAz(args: string[]): Promise<AzRunResult> {
  return new Promise<AzRunResult>((resolve) => {
    const isWin = process.platform === 'win32'
    const bin = isWin ? 'az.cmd' : 'az'
    const finalArgs = isWin ? args.map(quoteForCmd) : args
    execFile(
      bin,
      finalArgs,
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        shell: isWin,
        timeout: 60_000
      },
      (err, stdout, stderr) => {
        const so = stdout ?? ''
        const se = stderr ?? ''
        if (err) {
          const errCode = (err as NodeJS.ErrnoException).code
          if (errCode === 'ENOENT') {
            return resolve({ ok: false, reason: 'not-installed' })
          }
          if (
            /is not recognized as an internal or external command/i.test(se) ||
            /command not found/i.test(se)
          ) {
            return resolve({ ok: false, reason: 'not-installed' })
          }
          const exitCode =
            typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : null
          return resolve({
            ok: false,
            reason: 'exec-failed',
            stdout: so,
            stderr: se,
            code: exitCode
          })
        }
        resolve({ ok: true, stdout: so, stderr: se })
      }
    )
  })
}

function sanitizePrTitle(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 400 ? cleaned.slice(0, 400) : cleaned
}

function classifyAzCreateFailure(stderr: string): (OpenPullRequestResult & { ok: false }) | null {
  if (
    /is misspelled or not recognized/i.test(stderr) ||
    /no installed CLI command/i.test(stderr) ||
    /azure-devops.*not installed/i.test(stderr) ||
    /'repos' is misspelled/i.test(stderr)
  ) {
    return {
      ok: false,
      code: 'az-extension-missing',
      message: 'Run: az extension add --name azure-devops'
    }
  }
  if (
    /Please run ['"]?az login/i.test(stderr) ||
    /az login/i.test(stderr) ||
    /AADSTS/i.test(stderr) ||
    /TokenCredentialUnavailable/i.test(stderr) ||
    /not signed in/i.test(stderr) ||
    /TF400813/i.test(stderr) ||
    /Before you can run Azure DevOps commands, you need to run the login command/i.test(stderr)
  ) {
    return {
      ok: false,
      code: 'az-not-logged-in',
      message: 'Run: az login'
    }
  }
  if (/TF401179/i.test(stderr) || /active pull request[^.]*already exists/i.test(stderr)) {
    return {
      ok: false,
      code: 'az-pr-exists',
      message: 'A PR already exists for this source/target.'
    }
  }
  return null
}

export async function openPullRequest(req: OpenPullRequestRequest): Promise<OpenPullRequestResult> {
  const { folderPath } = req

  let originUrl: string
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], folderPath)
    originUrl = stdout.trim()
    if (!originUrl) return { ok: false, code: 'no-origin' }
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, code: 'no-origin', message: err.message }
    }
    return {
      ok: false,
      code: 'git-failed',
      message: err instanceof Error ? err.message : 'git remote failed'
    }
  }

  const remote = parseAdoRemote(originUrl)
  if (!remote) {
    return {
      ok: false,
      code: 'unsupported-remote',
      message: `Origin is not a recognized Azure DevOps Services remote: ${originUrl}`
    }
  }

  const currentBranch = await getCurrentBranch(folderPath)
  if (!currentBranch) return { ok: false, code: 'detached' }

  const defaultBranch = await getDefaultBranch(folderPath)
  if (!defaultBranch) return { ok: false, code: 'no-default-branch' }

  if (currentBranch === defaultBranch) return { ok: false, code: 'same-as-default' }

  let dirty: string
  try {
    const { stdout } = await runGit(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      folderPath
    )
    dirty = stdout
  } catch (err) {
    return {
      ok: false,
      code: 'git-failed',
      message: err instanceof Error ? err.message : 'git status failed'
    }
  }
  if (dirty.trim().length > 0) return { ok: false, code: 'uncommitted' }

  try {
    await runGit(
      ['fetch', 'origin', `refs/heads/${currentBranch}:refs/remotes/origin/${currentBranch}`],
      folderPath
    )
  } catch (err) {
    if (err instanceof GitError) {
      const msg = err.message
      if (
        /couldn't find remote ref/i.test(msg) ||
        /does not exist/i.test(msg) ||
        /not our ref/i.test(msg)
      ) {
        return { ok: false, code: 'no-remote-branch', message: msg }
      }
      return { ok: false, code: 'fetch-failed', message: msg }
    }
    return {
      ok: false,
      code: 'fetch-failed',
      message: err instanceof Error ? err.message : 'git fetch failed'
    }
  }

  const status = await getAheadBehind(folderPath, currentBranch)
  if (!status.hasRemote) return { ok: false, code: 'no-remote-branch' }
  if (status.ahead > 0) return { ok: false, code: 'unpushed' }

  let title = currentBranch
  try {
    const { stdout } = await runGit(['log', '-1', '--pretty=%s', 'HEAD'], folderPath)
    const subject = sanitizePrTitle(stdout)
    if (subject) title = subject
  } catch {
    // fall back to branch name
  }

  const azArgs = [
    'repos',
    'pr',
    'create',
    '--organization',
    `https://dev.azure.com/${remote.org}`,
    '--project',
    remote.project,
    '--repository',
    remote.repo,
    '--source-branch',
    currentBranch,
    '--target-branch',
    defaultBranch,
    '--title',
    title,
    '--draft',
    'true',
    '--output',
    'json'
  ]

  const azResult = await runAz(azArgs)
  if (azResult.ok === false) {
    if (azResult.reason === 'not-installed') {
      return {
        ok: false,
        code: 'az-not-installed',
        message: 'Azure CLI (az) was not found on PATH.'
      }
    }
    const classified = classifyAzCreateFailure(azResult.stderr)
    if (classified) return classified
    return {
      ok: false,
      code: 'az-failed',
      message:
        azResult.stderr.trim() ||
        azResult.stdout.trim() ||
        `az exited with code ${azResult.code ?? '?'}`
    }
  }

  let pullRequestId = NaN
  try {
    const trimmed = azResult.stdout.trim()
    const firstBrace = trimmed.indexOf('{')
    const jsonText = firstBrace >= 0 ? trimmed.slice(firstBrace) : trimmed
    const parsed = JSON.parse(jsonText) as {
      pullRequestId?: number
      codeReviewId?: number
    }
    const id = Number(parsed.pullRequestId ?? parsed.codeReviewId)
    if (Number.isFinite(id) && id > 0) pullRequestId = id
  } catch (err) {
    return {
      ok: false,
      code: 'az-failed',
      message: `Could not parse az output: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!Number.isFinite(pullRequestId) || pullRequestId <= 0) {
    return { ok: false, code: 'az-failed', message: 'az output missing pullRequestId.' }
  }

  const webUrl = buildAdoPrWebUrl(remote, pullRequestId)
  try {
    await shell.openExternal(webUrl)
  } catch {
    // PR was created; just return the URL so renderer can surface it
  }
  return { ok: true, pullRequestId, webUrl }
}

function classifyAzListFailure(stderr: string): (FindPullRequestResult & { ok: false }) | null {
  if (
    /is misspelled or not recognized/i.test(stderr) ||
    /no installed CLI command/i.test(stderr) ||
    /azure-devops.*not installed/i.test(stderr) ||
    /'repos' is misspelled/i.test(stderr)
  ) {
    return {
      ok: false,
      code: 'az-extension-missing',
      message: 'Run: az extension add --name azure-devops'
    }
  }
  if (
    /Please run ['"]?az login/i.test(stderr) ||
    /az login/i.test(stderr) ||
    /AADSTS/i.test(stderr) ||
    /TokenCredentialUnavailable/i.test(stderr) ||
    /not signed in/i.test(stderr) ||
    /TF400813/i.test(stderr) ||
    /Before you can run Azure DevOps commands, you need to run the login command/i.test(stderr)
  ) {
    return {
      ok: false,
      code: 'az-not-logged-in',
      message: 'Run: az login'
    }
  }
  return null
}

export async function findActivePullRequest(
  req: FindPullRequestRequest
): Promise<FindPullRequestResult> {
  const { folderPath } = req

  let originUrl: string
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], folderPath)
    originUrl = stdout.trim()
    if (!originUrl) return { ok: false, code: 'no-origin' }
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, code: 'no-origin', message: err.message }
    }
    return {
      ok: false,
      code: 'git-failed',
      message: err instanceof Error ? err.message : 'git remote failed'
    }
  }

  const remote = parseAdoRemote(originUrl)
  if (!remote) {
    return {
      ok: false,
      code: 'unsupported-remote',
      message: `Origin is not a recognized Azure DevOps Services remote: ${originUrl}`
    }
  }

  const currentBranch = await getCurrentBranch(folderPath)
  if (!currentBranch) return { ok: false, code: 'detached' }

  const defaultBranch = await getDefaultBranch(folderPath)
  if (!defaultBranch) return { ok: false, code: 'no-default-branch' }

  if (currentBranch === defaultBranch) return { ok: false, code: 'same-as-default' }

  const azArgs = [
    'repos',
    'pr',
    'list',
    '--organization',
    `https://dev.azure.com/${remote.org}`,
    '--project',
    remote.project,
    '--repository',
    remote.repo,
    '--source-branch',
    `refs/heads/${currentBranch}`,
    '--target-branch',
    `refs/heads/${defaultBranch}`,
    '--status',
    'active',
    '--output',
    'json'
  ]

  const azResult = await runAz(azArgs)
  if (azResult.ok === false) {
    if (azResult.reason === 'not-installed') {
      return {
        ok: false,
        code: 'az-not-installed',
        message: 'Azure CLI (az) was not found on PATH.'
      }
    }
    const classified = classifyAzListFailure(azResult.stderr)
    if (classified) return classified
    return {
      ok: false,
      code: 'az-failed',
      message:
        azResult.stderr.trim() ||
        azResult.stdout.trim() ||
        `az exited with code ${azResult.code ?? '?'}`
    }
  }

  let parsed: unknown
  try {
    const trimmed = azResult.stdout.trim()
    const firstBracket = trimmed.indexOf('[')
    const firstBrace = trimmed.indexOf('{')
    const start =
      firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace) ? firstBracket : firstBrace
    const jsonText = start >= 0 ? trimmed.slice(start) : trimmed
    parsed = jsonText ? JSON.parse(jsonText) : []
  } catch (err) {
    return {
      ok: false,
      code: 'az-failed',
      message: `Could not parse az output: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: true, pullRequest: null }
  }

  const first = parsed[0] as {
    pullRequestId?: number
    codeReviewId?: number
    title?: string
    status?: string
  }
  const id = Number(first.pullRequestId ?? first.codeReviewId)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: true, pullRequest: null }
  }

  const existing: ExistingPullRequest = {
    id,
    title: typeof first.title === 'string' ? first.title : '',
    webUrl: buildAdoPrWebUrl(remote, id),
    status: typeof first.status === 'string' ? first.status : 'active'
  }
  return { ok: true, pullRequest: existing }
}

export async function pullDefaultBranch(
  workspacePath: string,
  branch: string
): Promise<PullResult> {
  const current = await getCurrentBranch(workspacePath)

  if (current === branch) {
    try {
      const { stdout } = await runGit(['pull', '--ff-only', 'origin', branch], workspacePath)
      const alreadyUpToDate = /already up[\s-]?to[\s-]?date/i.test(stdout)
      return { ok: true, fastForwarded: !alreadyUpToDate, alreadyUpToDate, message: stdout.trim() }
    } catch (err) {
      if (err instanceof GitError) return { ok: false, error: err.message }
      return { ok: false, error: err instanceof Error ? err.message : 'git pull failed' }
    }
  }

  try {
    await runGit(['fetch', 'origin', `${branch}:${branch}`], workspacePath)
    return { ok: true, fastForwarded: true, alreadyUpToDate: false }
  } catch (err) {
    if (err instanceof GitError) {
      const msg = err.message
      if (/already checked out/i.test(msg) || /refusing to fetch/i.test(msg)) {
        return {
          ok: false,
          error: `Cannot update ${branch}: it is checked out in another worktree. Switch to it and pull manually.`
        }
      }
      return { ok: false, error: msg }
    }
    return { ok: false, error: err instanceof Error ? err.message : 'git fetch failed' }
  }
}

export async function getWorkingCopyStatus(
  req: WorkingCopyStatusRequest
): Promise<WorkingCopyStatusResult> {
  const { folderPath } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  try {
    const { stdout } = await runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      folderPath
    )
    const tokens = stdout.split('\0')
    let modified = 0
    let staged = 0
    let untracked = 0
    const entries: WorkingCopyEntry[] = []
    let i = 0
    while (i < tokens.length) {
      const token = tokens[i]
      if (!token || token.length < 3) {
        i += 1
        continue
      }
      const x = token.charAt(0)
      const y = token.charAt(1)
      const path = token.slice(3)
      const isUntracked = x === '?' && y === '?'
      const isStaged = !isUntracked && x !== ' ' && x !== '?'
      const isUnstaged = !isUntracked && y !== ' ' && y !== '?'

      if (isUntracked) untracked += 1
      if (isStaged) staged += 1
      if (isUnstaged) modified += 1

      let originalPath: string | undefined
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        if (i + 1 < tokens.length) {
          originalPath = tokens[i + 1]
          i += 2
        } else {
          i += 1
        }
      } else {
        i += 1
      }

      entries.push({
        path,
        originalPath,
        indexStatus: x,
        worktreeStatus: y,
        isStaged,
        isUnstaged,
        isUntracked
      })
    }
    entries.sort((a, b) => {
      if (a.isUntracked !== b.isUntracked) return a.isUntracked ? 1 : -1
      return a.path.localeCompare(b.path)
    })
    return {
      ok: true,
      modified,
      staged,
      untracked,
      entries
    }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'git status failed' }
  }
}

export async function stageFiles(req: StageFilesRequest): Promise<StageFilesResult> {
  const { folderPath, files } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'No files specified.' }
  }
  try {
    await runGit(['add', '-A', '--', ...files], folderPath)
    return { ok: true }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'git add failed' }
  }
}

export async function unstageFiles(req: UnstageFilesRequest): Promise<UnstageFilesResult> {
  const { folderPath, files } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'No files specified.' }
  }
  try {
    const hasHead =
      (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], folderPath)) !== null
    if (hasHead) {
      await runGit(['reset', 'HEAD', '--', ...files], folderPath)
    } else {
      await runGit(['rm', '--cached', '--', ...files], folderPath)
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'git reset failed' }
  }
}

export async function revertFiles(req: RevertFilesRequest): Promise<RevertFilesResult> {
  const { folderPath, files, isUntracked } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'No files specified.' }
  }
  try {
    if (isUntracked) {
      // Untracked file/dir — delete it from the working tree.
      await runGit(['clean', '-fd', '--', ...files], folderPath)
      return { ok: true }
    }
    const hasHead =
      (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], folderPath)) !== null
    if (hasHead) {
      // Tracked file — unstage and discard working-tree changes back to HEAD.
      await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...files], folderPath)
    } else {
      // No HEAD yet (fresh repo) — unstage then remove the working-tree copy.
      await runGit(['rm', '-f', '--cached', '--ignore-unmatch', '--', ...files], folderPath)
      await runGit(['clean', '-fd', '--', ...files], folderPath)
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'git restore failed' }
  }
}

export async function discardAllChanges(
  req: DiscardAllChangesRequest
): Promise<DiscardAllChangesResult> {
  const { folderPath } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  try {
    const hasHead =
      (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], folderPath)) !== null
    if (hasHead) {
      await runGit(['reset', '--hard', 'HEAD'], folderPath)
    } else {
      // No HEAD yet (fresh repo) — unstage everything so `git clean` can sweep it.
      await runGit(['rm', '-rf', '--cached', '--ignore-unmatch', '.'], folderPath)
    }
    // `-f` force, `-d` directories. No `-x`, so ignored files (e.g. node_modules) are preserved.
    await runGit(['clean', '-fd'], folderPath)
    return { ok: true }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'discard-all-changes failed'
    }
  }
}

export async function commitChanges(req: CommitRequest): Promise<CommitResult> {
  const { folderPath, message, stageAll } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required', code: 'git-failed' }
  const trimmed = (message ?? '').trim()
  if (!trimmed) {
    return { ok: false, error: 'Commit message is required.', code: 'empty-message' }
  }
  try {
    if (stageAll) {
      await runGit(['add', '-A'], folderPath)
    }
    try {
      await runGit(['commit', '-m', trimmed], folderPath)
    } catch (err) {
      if (err instanceof GitError) {
        const combined = `${err.stderr ?? ''}\n${err.message ?? ''}`
        if (
          /nothing to commit/i.test(combined) ||
          /no changes added to commit/i.test(combined) ||
          /nothing added to commit/i.test(combined)
        ) {
          return { ok: false, error: 'Nothing to commit.', code: 'nothing-to-commit' }
        }
        return { ok: false, error: err.message, code: 'git-failed' }
      }
      throw err
    }
    const { stdout } = await runGit(['rev-parse', 'HEAD'], folderPath)
    return { ok: true, commitSha: stdout.trim() }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message, code: 'git-failed' }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'git commit failed',
      code: 'git-failed'
    }
  }
}

const COMMIT_FIELD_SEPARATOR = '\x1f'

export async function getRecentCommits(req: RecentCommitsRequest): Promise<RecentCommitsResult> {
  const { folderPath } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 10
  try {
    const { stdout } = await runGit(
      ['log', `-n`, String(limit), `--pretty=format:%H%x1f%s%x1f%an%x1f%aI`],
      folderPath
    )
    const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0)
    const commits: RecentCommit[] = []
    for (const line of lines) {
      const parts = line.split(COMMIT_FIELD_SEPARATOR)
      if (parts.length < 4) continue
      commits.push({
        sha: parts[0]!,
        subject: parts[1]!,
        author: parts[2]!,
        isoTime: parts[3]!
      })
    }
    let adoCommitUrlPrefix: string | undefined
    try {
      const { stdout: originStdout } = await runGit(['remote', 'get-url', 'origin'], folderPath)
      const originUrl = originStdout.trim()
      if (originUrl) {
        const remote = parseAdoRemote(originUrl)
        if (remote) {
          const sample = buildAdoCommitUrl(remote, '')
          adoCommitUrlPrefix = sample
        }
      }
    } catch {
      // No origin or git failure — leave prefix undefined so the panel renders plain text.
    }
    return { ok: true, commits, adoCommitUrlPrefix }
  } catch (err) {
    if (err instanceof GitError) {
      if (
        /does not have any commits yet/i.test(err.message) ||
        /bad default revision/i.test(err.message)
      ) {
        return { ok: true, commits: [] }
      }
      return { ok: false, error: err.message }
    }
    return { ok: false, error: err instanceof Error ? err.message : 'git log failed' }
  }
}

async function isWorkingTreeClean(folderPath: string): Promise<boolean> {
  const { stdout } = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], folderPath)
  return stdout.trim().length === 0
}

export async function rebaseOnDefault(req: RebaseOnDefaultRequest): Promise<RebaseOnDefaultResult> {
  const { folderPath, workspacePath } = req
  if (!folderPath) return { ok: false, code: 'git-failed', message: 'folderPath is required' }

  try {
    if (!(await isWorkingTreeClean(folderPath))) {
      return { ok: false, code: 'dirty' }
    }
  } catch (err) {
    return {
      ok: false,
      code: 'git-failed',
      message: err instanceof Error ? err.message : 'git status failed'
    }
  }

  const currentBranch = await getCurrentBranch(folderPath)
  if (!currentBranch) {
    return {
      ok: false,
      code: 'git-failed',
      message: 'Cannot rebase: HEAD is detached. Create a branch first.'
    }
  }

  const defaultBranch = await getDefaultBranch(folderPath)
  if (!defaultBranch) return { ok: false, code: 'no-default-branch' }

  if (workspacePath && workspacePath !== folderPath) {
    const pulled = await pullDefaultBranch(workspacePath, defaultBranch)
    if (!pulled.ok) {
      return { ok: false, code: 'pull-failed', message: pulled.error }
    }
  }

  try {
    await runGit(['fetch', 'origin', defaultBranch], folderPath)
  } catch (err) {
    const message =
      err instanceof GitError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'git fetch failed'
    return { ok: false, code: 'fetch-failed', message }
  }

  if (currentBranch === defaultBranch) {
    try {
      await runGit(['merge', '--ff-only', `origin/${defaultBranch}`], folderPath)
      return { ok: true }
    } catch (err) {
      const message =
        err instanceof GitError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'git merge failed'
      return { ok: false, code: 'pull-failed', message }
    }
  }

  try {
    await runGit(['rebase', `origin/${defaultBranch}`], folderPath)
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof GitError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'git rebase failed'
    const looksLikeConflict =
      /conflict/i.test(message) ||
      /could not apply/i.test(message) ||
      /resolve all conflicts/i.test(message)
    if (looksLikeConflict) {
      // Intentionally NOT running `git rebase --abort` here: leaving conflicts in the
      // working tree lets the UI surface them and offer one-click Copilot resolution.
      // Users who want to back out can run `git rebase --abort` manually.
      return { ok: false, code: 'conflicts', message }
    }
    return { ok: false, code: 'rebase-failed', message }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readFileTrimmed(p: string): Promise<string | undefined> {
  try {
    const contents = await fs.readFile(p, 'utf8')
    const trimmed = contents.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

export async function detectMergeState(
  req: DetectMergeStateRequest
): Promise<DetectMergeStateResult> {
  const { folderPath } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  try {
    const gitDirRaw = await tryGit(['rev-parse', '--git-dir'], folderPath)
    if (!gitDirRaw) return { ok: false, error: 'Not a git repository.' }
    const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(folderPath, gitDirRaw)

    const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
    const rebaseApplyDir = path.join(gitDir, 'rebase-apply')
    const mergeHeadFile = path.join(gitDir, 'MERGE_HEAD')

    if ((await pathExists(rebaseMergeDir)) || (await pathExists(rebaseApplyDir))) {
      const dir = (await pathExists(rebaseMergeDir)) ? rebaseMergeDir : rebaseApplyDir
      const rebaseHeadName = await readFileTrimmed(path.join(dir, 'head-name'))
      const rebaseOnto = await readFileTrimmed(path.join(dir, 'onto'))
      return { ok: true, state: 'rebase', rebaseHeadName, rebaseOnto }
    }

    if (await pathExists(mergeHeadFile)) {
      const contents = (await readFileTrimmed(mergeHeadFile)) ?? ''
      const mergeHeads = contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      return { ok: true, state: 'merge', mergeHeads }
    }

    return { ok: true, state: 'none' }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'detect-merge-state failed' }
  }
}

// ─── Phase 7.3 — Branch-only panels ──────────────────────────────────────────

export async function getUnpushedCommits(
  req: UnpushedCommitsRequest
): Promise<UnpushedCommitsResult> {
  const { folderPath, branch } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  if (!branch) return { ok: false, error: 'branch is required' }

  const hasRemote = await hasRemoteBranch(folderPath, branch)
  if (!hasRemote) {
    // Treat "no upstream yet" as everything is unpushed. Use HEAD log.
    try {
      const { stdout } = await runGit(
        ['log', '-n', '50', '--pretty=format:%H%x1f%s%x1f%an%x1f%aI', 'HEAD'],
        folderPath
      )
      return { ok: true, commits: parseCommitLog(stdout) }
    } catch (err) {
      if (err instanceof GitError) return { ok: false, error: err.message }
      return { ok: false, error: err instanceof Error ? err.message : 'git log failed' }
    }
  }

  try {
    const { stdout } = await runGit(
      [
        'log',
        '-n',
        '50',
        '--pretty=format:%H%x1f%s%x1f%an%x1f%aI',
        `refs/remotes/origin/${branch}..HEAD`
      ],
      folderPath
    )
    return { ok: true, commits: parseCommitLog(stdout) }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'git log failed' }
  }
}

function parseCommitLog(stdout: string): RecentCommit[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0)
  const commits: RecentCommit[] = []
  for (const line of lines) {
    const parts = line.split(COMMIT_FIELD_SEPARATOR)
    if (parts.length < 4) continue
    commits.push({
      sha: parts[0]!,
      subject: parts[1]!,
      author: parts[2]!,
      isoTime: parts[3]!
    })
  }
  return commits
}

export async function pushCurrentBranch(req: PushRequest): Promise<PushResult> {
  const { folderPath } = req
  if (!folderPath) return { ok: false, error: 'folderPath is required' }
  try {
    await runGit(['push', '-u', 'origin', 'HEAD'], folderPath)
    return { ok: true }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : 'git push failed' }
  }
}

// ─── ADO az-driven IPCs ──────────────────────────────────────────────────────

function classifyAzGenericFailure(stderr: string): { code: AdoErrorCode; message: string } | null {
  if (
    /is misspelled or not recognized/i.test(stderr) ||
    /no installed CLI command/i.test(stderr) ||
    /azure-devops.*not installed/i.test(stderr) ||
    /'repos' is misspelled/i.test(stderr) ||
    /'pipelines' is misspelled/i.test(stderr)
  ) {
    return {
      code: 'az-extension-missing',
      message: 'Run: az extension add --name azure-devops'
    }
  }
  if (
    /Please run ['"]?az login/i.test(stderr) ||
    /az login/i.test(stderr) ||
    /AADSTS/i.test(stderr) ||
    /TokenCredentialUnavailable/i.test(stderr) ||
    /not signed in/i.test(stderr) ||
    /TF400813/i.test(stderr) ||
    /Before you can run Azure DevOps commands, you need to run the login command/i.test(stderr)
  ) {
    return { code: 'az-not-logged-in', message: 'Run: az login' }
  }
  return null
}

async function resolveAdoRemote(
  folderPath: string
): Promise<{ ok: true; remote: AdoRemote } | { ok: false; code: AdoErrorCode; message?: string }> {
  let originUrl: string
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], folderPath)
    originUrl = stdout.trim()
    if (!originUrl) return { ok: false, code: 'no-origin' }
  } catch (err) {
    if (err instanceof GitError) return { ok: false, code: 'no-origin', message: err.message }
    return {
      ok: false,
      code: 'git-failed',
      message: err instanceof Error ? err.message : 'git remote failed'
    }
  }
  const remote = parseAdoRemote(originUrl)
  if (!remote) {
    return {
      ok: false,
      code: 'unsupported-remote',
      message: `Origin is not a recognized Azure DevOps Services remote: ${originUrl}`
    }
  }
  return { ok: true, remote }
}

function parseJsonFromAzOutput(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const firstBracket = trimmed.indexOf('[')
  const firstBrace = trimmed.indexOf('{')
  const start =
    firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace) ? firstBracket : firstBrace
  const jsonText = start >= 0 ? trimmed.slice(start) : trimmed
  return JSON.parse(jsonText)
}

function normaliseVote(value: unknown): AdoReviewerVote {
  const n = Number(value)
  if (n === 10 || n === 5 || n === -5 || n === -10) return n
  return 0
}

export async function getAdoPrDetails(req: AdoPrDetailsRequest): Promise<AdoPrDetailsResult> {
  const { folderPath, pullRequestId } = req
  if (!folderPath) return { ok: false, code: 'git-failed', message: 'folderPath is required' }
  if (!Number.isFinite(pullRequestId) || pullRequestId <= 0) {
    return { ok: false, code: 'git-failed', message: 'pullRequestId is required' }
  }
  const remoteResolution = await resolveAdoRemote(folderPath)
  if (!remoteResolution.ok) return remoteResolution
  const { remote } = remoteResolution

  const args = [
    'repos',
    'pr',
    'show',
    '--id',
    String(pullRequestId),
    '--organization',
    `https://dev.azure.com/${remote.org}`,
    '--output',
    'json'
  ]
  const azResult = await runAz(args)
  if (azResult.ok === false) {
    if (azResult.reason === 'not-installed') {
      return {
        ok: false,
        code: 'az-not-installed',
        message: 'Azure CLI (az) was not found on PATH.'
      }
    }
    const classified = classifyAzGenericFailure(azResult.stderr)
    if (classified) return { ok: false, ...classified }
    return {
      ok: false,
      code: 'az-failed',
      message:
        azResult.stderr.trim() ||
        azResult.stdout.trim() ||
        `az exited with code ${azResult.code ?? '?'}`
    }
  }
  let parsed: unknown
  try {
    parsed = parseJsonFromAzOutput(azResult.stdout)
  } catch (err) {
    return {
      ok: false,
      code: 'az-failed',
      message: `Could not parse az output: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, code: 'az-failed', message: 'az output was not an object.' }
  }
  const obj = parsed as {
    pullRequestId?: number
    codeReviewId?: number
    title?: string
    status?: string
    isDraft?: boolean
    sourceRefName?: string
    targetRefName?: string
    creationDate?: string
    reviewers?: Array<{
      displayName?: string
      uniqueName?: string
      vote?: number
      isRequired?: boolean
    }>
    _links?: { web?: { href?: string } }
  }
  const id = Number(obj.pullRequestId ?? obj.codeReviewId ?? pullRequestId)
  const reviewers: AdoReviewer[] = Array.isArray(obj.reviewers)
    ? obj.reviewers.map((r) => ({
        displayName: typeof r.displayName === 'string' ? r.displayName : 'Reviewer',
        uniqueName: typeof r.uniqueName === 'string' ? r.uniqueName : undefined,
        vote: normaliseVote(r.vote),
        isRequired: Boolean(r.isRequired)
      }))
    : []
  const webHref =
    obj._links && typeof obj._links === 'object' && obj._links.web && obj._links.web.href
      ? obj._links.web.href
      : buildAdoPrWebUrl(remote, id)
  const details: AdoPrDetails = {
    id,
    title: typeof obj.title === 'string' ? obj.title : '',
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    isDraft: Boolean(obj.isDraft),
    sourceRef: typeof obj.sourceRefName === 'string' ? obj.sourceRefName : '',
    targetRef: typeof obj.targetRefName === 'string' ? obj.targetRefName : '',
    webUrl: webHref,
    reviewers,
    creationDate: typeof obj.creationDate === 'string' ? obj.creationDate : null
  }
  return { ok: true, details }
}

export async function getAdoPrThreads(req: AdoPrThreadsRequest): Promise<AdoPrThreadsResult> {
  const { folderPath, pullRequestId } = req
  if (!folderPath) return { ok: false, code: 'git-failed', message: 'folderPath is required' }
  if (!Number.isFinite(pullRequestId) || pullRequestId <= 0) {
    return { ok: false, code: 'git-failed', message: 'pullRequestId is required' }
  }
  const remoteResolution = await resolveAdoRemote(folderPath)
  if (!remoteResolution.ok) return remoteResolution
  const { remote } = remoteResolution

  const args = [
    'devops',
    'invoke',
    '--area',
    'git',
    '--resource',
    'pullRequestThreads',
    '--route-parameters',
    `project=${remote.project}`,
    `repositoryId=${remote.repo}`,
    `pullRequestId=${pullRequestId}`,
    '--organization',
    `https://dev.azure.com/${remote.org}`,
    '--api-version',
    '7.1',
    '--http-method',
    'GET'
  ]
  const azResult = await runAz(args)
  if (azResult.ok === false) {
    if (azResult.reason === 'not-installed') {
      return {
        ok: false,
        code: 'az-not-installed',
        message: 'Azure CLI (az) was not found on PATH.'
      }
    }
    const classified = classifyAzGenericFailure(azResult.stderr)
    if (classified) return { ok: false, ...classified }
    return {
      ok: false,
      code: 'az-failed',
      message:
        azResult.stderr.trim() ||
        azResult.stdout.trim() ||
        `az exited with code ${azResult.code ?? '?'}`
    }
  }
  let parsed: unknown
  try {
    parsed = parseJsonFromAzOutput(azResult.stdout)
  } catch (err) {
    return {
      ok: false,
      code: 'az-failed',
      message: `Could not parse az output: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const rawArray =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { value?: unknown }).value)
      ? ((parsed as { value: unknown[] }).value as unknown[])
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : []

  const threads: AdoPrThread[] = []
  for (const raw of rawArray) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as {
      id?: number
      status?: string | number
      isDeleted?: boolean
      lastUpdatedDate?: string
      publishedDate?: string
      threadContext?: {
        filePath?: string
        rightFileStart?: { line?: number }
        rightFileEnd?: { line?: number }
        leftFileStart?: { line?: number }
        leftFileEnd?: { line?: number }
      } | null
      comments?: Array<{
        id?: number
        content?: string
        commentType?: string | number
        publishedDate?: string
        author?: { displayName?: string; uniqueName?: string }
      }>
    }
    if (t.isDeleted) continue
    const status = normaliseThreadStatus(t.status)
    if (status !== 'active' && status !== 'pending') continue
    const comments = Array.isArray(t.comments) ? t.comments : []
    const userComments: AdoPrComment[] = []
    for (const c of comments) {
      const ctype = normaliseCommentType(c.commentType)
      if (ctype === 'system') continue
      const author: AdoPrCommentAuthor = {
        displayName:
          typeof c.author?.displayName === 'string' ? c.author!.displayName! : 'Unknown',
        uniqueName:
          typeof c.author?.uniqueName === 'string' ? c.author!.uniqueName : undefined
      }
      userComments.push({
        id: Number(c.id ?? 0),
        author,
        content: typeof c.content === 'string' ? c.content : '',
        publishedDate: typeof c.publishedDate === 'string' ? c.publishedDate : null
      })
    }
    if (userComments.length === 0) continue

    const ctx = t.threadContext ?? null
    const filePath = ctx && typeof ctx.filePath === 'string' ? ctx.filePath : null
    const lineNumber =
      (ctx?.rightFileStart?.line ?? ctx?.rightFileEnd?.line ?? ctx?.leftFileStart?.line ?? null) ||
      null
    const id = Number(t.id ?? 0)
    threads.push({
      id,
      status,
      filePath,
      lineNumber: typeof lineNumber === 'number' && lineNumber > 0 ? lineNumber : null,
      comments: userComments,
      lastUpdated:
        typeof t.lastUpdatedDate === 'string'
          ? t.lastUpdatedDate
          : typeof t.publishedDate === 'string'
            ? t.publishedDate
            : null,
      webUrl: id > 0 ? buildAdoPrThreadUrl(remote, pullRequestId, id) : buildAdoPrWebUrl(remote, pullRequestId)
    })
  }

  // Most recently updated first.
  threads.sort((a, b) => {
    const ta = a.lastUpdated ? Date.parse(a.lastUpdated) : 0
    const tb = b.lastUpdated ? Date.parse(b.lastUpdated) : 0
    return tb - ta
  })

  return { ok: true, threads }
}

function normaliseThreadStatus(value: unknown): AdoPrThreadStatus {
  if (typeof value === 'string') {
    const v = value.toLowerCase()
    if (
      v === 'active' ||
      v === 'pending' ||
      v === 'fixed' ||
      v === 'wontfix' ||
      v === 'closed' ||
      v === 'bydesign' ||
      v === 'unknown'
    ) {
      // Normalise to camelCase keys used in the shared type.
      if (v === 'wontfix') return 'wontFix'
      if (v === 'bydesign') return 'byDesign'
      return v as AdoPrThreadStatus
    }
  }
  if (typeof value === 'number') {
    switch (value) {
      case 1:
        return 'active'
      case 2:
        return 'fixed'
      case 3:
        return 'wontFix'
      case 4:
        return 'closed'
      case 5:
        return 'byDesign'
      case 6:
        return 'pending'
      default:
        return 'unknown'
    }
  }
  return 'unknown'
}

function normaliseCommentType(value: unknown): 'text' | 'codeChange' | 'system' | 'unknown' {
  if (typeof value === 'string') {
    const v = value.toLowerCase()
    if (v === 'text') return 'text'
    if (v === 'codechange') return 'codeChange'
    if (v === 'system') return 'system'
  }
  if (typeof value === 'number') {
    switch (value) {
      case 1:
        return 'text'
      case 2:
        return 'codeChange'
      case 3:
        return 'system'
      default:
        return 'unknown'
    }
  }
  return 'unknown'
}

export async function getAdoMyOpenPrs(req: AdoMyOpenPrsRequest): Promise<AdoMyOpenPrsResult> {
  const { folderPath } = req
  if (!folderPath) return { ok: false, code: 'git-failed', message: 'folderPath is required' }
  const remoteResolution = await resolveAdoRemote(folderPath)
  if (!remoteResolution.ok) return remoteResolution
  const { remote } = remoteResolution

  const args = [
    'repos',
    'pr',
    'list',
    '--creator',
    '@me',
    '--status',
    'active',
    '--organization',
    `https://dev.azure.com/${remote.org}`,
    '--project',
    remote.project,
    '--repository',
    remote.repo,
    '--output',
    'json'
  ]
  const azResult = await runAz(args)
  if (azResult.ok === false) {
    if (azResult.reason === 'not-installed') {
      return {
        ok: false,
        code: 'az-not-installed',
        message: 'Azure CLI (az) was not found on PATH.'
      }
    }
    const classified = classifyAzGenericFailure(azResult.stderr)
    if (classified) return { ok: false, ...classified }
    return {
      ok: false,
      code: 'az-failed',
      message:
        azResult.stderr.trim() ||
        azResult.stdout.trim() ||
        `az exited with code ${azResult.code ?? '?'}`
    }
  }
  let parsed: unknown
  try {
    parsed = parseJsonFromAzOutput(azResult.stdout)
  } catch (err) {
    return {
      ok: false,
      code: 'az-failed',
      message: `Could not parse az output: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!Array.isArray(parsed)) {
    return { ok: true, prs: [] }
  }
  const prs: AdoMyOpenPr[] = parsed.map((raw) => {
    const r = raw as {
      pullRequestId?: number
      codeReviewId?: number
      title?: string
      sourceRefName?: string
      targetRefName?: string
      status?: string
      isDraft?: boolean
      creationDate?: string
      _links?: { web?: { href?: string } }
    }
    const id = Number(r.pullRequestId ?? r.codeReviewId ?? 0)
    const webHref =
      r._links && typeof r._links === 'object' && r._links.web && r._links.web.href
        ? r._links.web.href
        : id
          ? buildAdoPrWebUrl(remote, id)
          : `https://dev.azure.com/${encodeURIComponent(remote.org)}/${encodeURIComponent(
              remote.project
            )}/_git/${encodeURIComponent(remote.repo)}/pullrequests`
    return {
      id,
      title: typeof r.title === 'string' ? r.title : '',
      sourceRef: typeof r.sourceRefName === 'string' ? r.sourceRefName : '',
      targetRef: typeof r.targetRefName === 'string' ? r.targetRefName : '',
      webUrl: webHref,
      createdAt: typeof r.creationDate === 'string' ? r.creationDate : null,
      status: typeof r.status === 'string' ? r.status : 'active',
      isDraft: Boolean(r.isDraft)
    }
  })
  return { ok: true, prs }
}

export async function getWorktreesOverview(
  req: WorktreesOverviewRequest
): Promise<WorktreesOverviewResult> {
  try {
    const worktrees = await listWorktrees(req.workspacePath)
    const rows: WorktreeOverviewRow[] = []
    for (const w of worktrees) {
      let isDirty = false
      try {
        const dirty = await tryGit(['status', '--porcelain=v1', '--untracked-files=all'], w.path)
        isDirty = !!dirty && dirty.trim().length > 0
      } catch {
        isDirty = false
      }

      let ahead = 0
      let behind = 0
      let hasRemote = false
      if (w.branch) {
        try {
          hasRemote = await hasRemoteBranch(w.path, w.branch)
        } catch {
          hasRemote = false
        }
        if (hasRemote) {
          try {
            const counts = await getAheadBehind(w.path, w.branch)
            ahead = counts.ahead
            behind = counts.behind
          } catch {
            ahead = 0
            behind = 0
          }
        }
      }

      let lastCommitIso: string | null = null
      let lastCommitSubject: string | null = null
      try {
        const log = await tryGit(
          ['log', '-1', `--pretty=format:%aI${COMMIT_FIELD_SEPARATOR}%s`],
          w.path
        )
        if (log) {
          const [iso, ...subjectParts] = log.split(COMMIT_FIELD_SEPARATOR)
          lastCommitIso = iso || null
          lastCommitSubject = subjectParts.join(COMMIT_FIELD_SEPARATOR) || null
        }
      } catch {
        lastCommitIso = null
        lastCommitSubject = null
      }

      rows.push({
        path: w.path,
        branch: w.branch,
        isDetached: w.isDetached,
        isMain: w.isMain,
        isLocked: w.isLocked,
        isDirty,
        ahead,
        behind,
        hasRemote,
        lastCommitIso,
        lastCommitSubject
      })
    }
    return { ok: true, rows }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'worktrees-overview failed'
    }
  }
}
