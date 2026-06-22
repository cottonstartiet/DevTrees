import * as React from 'react'
import {
  ArrowDownToLine as ArrowDownToLineIcon,
  Code2 as Code2Icon,
  Copy as CopyIcon,
  FolderOpen as FolderOpenIcon,
  GitBranchPlus as GitBranchPlusIcon,
  GitMerge as GitMergeIcon,
  GitPullRequest as GitPullRequestIcon,
  GitPullRequestArrow as GitPullRequestArrowIcon,
  Loader2 as Loader2Icon,
  RefreshCw as RefreshCwIcon,
  Terminal as TerminalIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { UseRepoStatusResult } from '@/hooks/use-repo-status'
import { rebaseOnDefault } from '@/lib/repo'
import { openInVSCode, openInWindowsTerminal, openPath } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { RebaseOnDefaultResult } from '@shared/repo'

const IS_WINDOWS =
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '')

export type DetailToolbarExistingPr = {
  id: number
  title: string
  webUrl: string
}

export interface DetailToolbarProps {
  title: string
  folderPath: string
  branch: string | null
  isDetached?: boolean
  headState?: 'branch' | 'detached'
  isWorktree?: boolean
  workspacePath?: string | null
  repo: UseRepoStatusResult
  onCreateBranch?: () => void
  onCreatePullRequest?: () => void
  existingPullRequest?: DetailToolbarExistingPr | null
  onOpenPullRequest?: () => void
  isCreatingPullRequest?: boolean
  branchWebUrl?: string | null
  onOpenBranch?: () => void
}

export function DetailToolbar({
  title,
  folderPath,
  branch,
  isDetached,
  headState,
  isWorktree = false,
  workspacePath = null,
  repo,
  onCreateBranch,
  onCreatePullRequest,
  existingPullRequest,
  onOpenPullRequest,
  isCreatingPullRequest = false,
  branchWebUrl,
  onOpenBranch
}: DetailToolbarProps): React.JSX.Element {
  const { defaultBranch, status, isFetching, isPulling, pull, refresh } = repo
  const behind = status?.behind ?? 0
  const ahead = status?.ahead ?? 0
  const hasRemote = status?.hasRemote ?? false
  const busy = isFetching || isPulling

  const branchLabel = isDetached ? '' : (branch ?? '')

  const syncTooltipText = !defaultBranch
    ? 'Resolving default branch…'
    : !hasRemote
      ? `Pull origin/${defaultBranch} (no remote tracking yet)`
      : behind > 0
        ? `Pull origin/${defaultBranch} — ${behind} behind${ahead > 0 ? `, ${ahead} ahead` : ''}`
        : ahead > 0
          ? `${defaultBranch} is ${ahead} ahead of origin (nothing to pull)`
          : `${defaultBranch} is up to date with origin`

  const [isRebasing, setIsRebasing] = React.useState(false)
  const [isOpeningVSCode, setIsOpeningVSCode] = React.useState(false)
  const [isOpeningTerminal, setIsOpeningTerminal] = React.useState(false)
  const [isOpeningFolder, setIsOpeningFolder] = React.useState(false)
  const [isOpeningPR, setIsOpeningPR] = React.useState(false)
  const rebaseDisabled = isRebasing || isDetached || !defaultBranch
  const isOnDefault = !!branch && !!defaultBranch && branch === defaultBranch
  const rebaseTooltipText = isDetached
    ? 'Rebase needs a branch — this worktree is detached.'
    : !defaultBranch
      ? 'Resolving default branch…'
      : isOnDefault
        ? `Pull origin/${defaultBranch} into this worktree`
        : `Pull origin/${defaultBranch} in workspace and rebase ${branch ?? 'current branch'} onto it`

  const handleRebase = async (): Promise<void> => {
    if (rebaseDisabled) return
    const confirmMsg = isOnDefault
      ? `Fast-forward ${defaultBranch} to origin/${defaultBranch}? Make sure your working tree is clean.`
      : `Pull origin/${defaultBranch} into the workspace and rebase ${branch} onto it? Make sure your working tree is clean.`
    if (!window.confirm(confirmMsg)) return
    setIsRebasing(true)
    try {
      const result = await rebaseOnDefault({
        folderPath,
        workspacePath: workspacePath ?? undefined
      })
      handleRebaseResult(result, folderPath, defaultBranch!, refresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rebase failed.')
    } finally {
      setIsRebasing(false)
    }
  }

  const handleVSCode = async (): Promise<void> => {
    if (isOpeningVSCode) return
    setIsOpeningVSCode(true)
    try {
      const result = await openInVSCode(folderPath)
      if (!result.ok) toast.error(`Could not open VS Code: ${result.error}`)
    } finally {
      setIsOpeningVSCode(false)
    }
  }

  const handleTerminal = async (): Promise<void> => {
    if (isOpeningTerminal) return
    setIsOpeningTerminal(true)
    try {
      const result = await openInWindowsTerminal(folderPath)
      if (!result.ok) toast.error(`Could not open Windows Terminal: ${result.error}`)
    } finally {
      setIsOpeningTerminal(false)
    }
  }

  const handleOpenFolder = async (): Promise<void> => {
    if (isOpeningFolder) return
    setIsOpeningFolder(true)
    try {
      const result = await openPath(folderPath)
      if (!result.ok) toast.error(`Could not open folder: ${result.error}`)
    } finally {
      setIsOpeningFolder(false)
    }
  }

  const handleOpenPR = async (): Promise<void> => {
    if (!onOpenPullRequest || isOpeningPR) return
    setIsOpeningPR(true)
    try {
      await Promise.resolve(onOpenPullRequest())
    } finally {
      setIsOpeningPR(false)
    }
  }

  const handleCopyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(folderPath)
      toast.success('Path copied to clipboard.')
    } catch (err) {
      toast.error(`Could not copy path: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const handlePull = async (): Promise<void> => {
    await pull()
  }

  const showOpenPr = !!existingPullRequest && !!onOpenPullRequest
  const showCreatePr = !showOpenPr && (!!onCreatePullRequest || isCreatingPullRequest)

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {headState ? (
            <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
              {headState === 'detached' ? 'Worktree' : 'Branch'}
            </span>
          ) : null}
          {branchLabel ? (
            onOpenBranch && branchWebUrl ? (
              <button
                type="button"
                onClick={onOpenBranch}
                className="text-muted-foreground hover:text-foreground truncate font-mono text-xs hover:underline"
                title={`Open branch ${branchLabel} in Azure DevOps`}
              >
                {branchLabel}
              </button>
            ) : (
              <span className="text-muted-foreground truncate font-mono text-xs">{branchLabel}</span>
            )
          ) : null}
        </div>
        {existingPullRequest ? (
          <button
            type="button"
            onClick={onOpenPullRequest}
            className="text-muted-foreground hover:text-foreground min-w-0 truncate text-left text-xs hover:underline"
            title={`PR #${existingPullRequest.id} — ${existingPullRequest.title}`}
          >
            <span className="font-mono">PR #{existingPullRequest.id}</span>
            {existingPullRequest.title ? (
              <span className="text-muted-foreground"> — {existingPullRequest.title}</span>
            ) : null}
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {onCreateBranch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" onClick={onCreateBranch}>
                <GitBranchPlusIcon className="size-4" />
                <span className="sr-only">Create branch from this worktree</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Create branch from this worktree</TooltipContent>
          </Tooltip>
        ) : null}

        {showOpenPr ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={handleOpenPR}
                disabled={isOpeningPR}
                aria-busy={isOpeningPR}
              >
                {isOpeningPR ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <GitPullRequestIcon className="size-4" />
                )}
                <span className="sr-only">
                  Open pull request #{existingPullRequest!.id} in Azure DevOps
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open PR #{existingPullRequest!.id} in Azure DevOps</TooltipContent>
          </Tooltip>
        ) : null}

        {showCreatePr ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={onCreatePullRequest}
                disabled={isCreatingPullRequest || !onCreatePullRequest}
                aria-busy={isCreatingPullRequest}
              >
                {isCreatingPullRequest ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <GitPullRequestArrowIcon className="size-4" />
                )}
                <span className="sr-only">
                  {isCreatingPullRequest
                    ? 'Creating pull request in Azure DevOps'
                    : 'Create pull request in Azure DevOps'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isCreatingPullRequest
                ? 'Creating pull request in Azure DevOps…'
                : 'Create pull request in Azure DevOps'}
            </TooltipContent>
          </Tooltip>
        ) : null}

        {isWorktree ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative size-8"
                onClick={() => void handleRebase()}
                disabled={rebaseDisabled}
                aria-busy={isRebasing}
                aria-label={
                  isOnDefault
                    ? `Pull origin/${defaultBranch ?? '...'}`
                    : `Rebase ${branch ?? 'branch'} on origin/${defaultBranch ?? '...'}`
                }
              >
                {isRebasing ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <GitMergeIcon className="size-4" />
                )}
                <span className="sr-only">
                  {isOnDefault ? 'Pull latest' : 'Rebase on default branch'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{rebaseTooltipText}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'relative size-8',
                  behind > 0 && !busy && 'text-amber-600 hover:text-amber-700 dark:text-amber-500'
                )}
                onClick={handlePull}
                disabled={isPulling || !defaultBranch}
                aria-busy={busy}
                aria-label={`Pull origin/${defaultBranch ?? '...'}`}
              >
                {busy ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : behind > 0 ? (
                  <ArrowDownToLineIcon className="size-4" />
                ) : (
                  <RefreshCwIcon className="size-4" />
                )}
                {behind > 0 && !busy && (
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 font-mono text-[10px] leading-none font-medium text-white">
                    {behind > 99 ? '99+' : behind}
                  </span>
                )}
                <span className="sr-only">Pull latest</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{syncTooltipText}</TooltipContent>
          </Tooltip>
        )}

        <Separator orientation="vertical" className="bg-border/80 mx-2 !h-6 w-px" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={handleVSCode}
              disabled={isOpeningVSCode}
              aria-busy={isOpeningVSCode}
            >
              {isOpeningVSCode ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Code2Icon className="size-4" />
              )}
              <span className="sr-only">Open in VS Code</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in VS Code</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={handleTerminal}
              disabled={!IS_WINDOWS || isOpeningTerminal}
              aria-busy={isOpeningTerminal}
            >
              {isOpeningTerminal ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <TerminalIcon className="size-4" />
              )}
              <span className="sr-only">Open in Windows Terminal</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {IS_WINDOWS ? 'Open in Windows Terminal' : 'Windows Terminal (Windows only)'}
          </TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="bg-border/80 mx-2 !h-6 w-px" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={handleOpenFolder}
              disabled={isOpeningFolder}
              aria-busy={isOpeningFolder}
            >
              {isOpeningFolder ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <FolderOpenIcon className="size-4" />
              )}
              <span className="sr-only">Open folder</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open folder</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" onClick={handleCopyPath}>
              <CopyIcon className="size-4" />
              <span className="sr-only">Copy path</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy path</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

function handleRebaseResult(
  result: RebaseOnDefaultResult,
  folderPath: string,
  defaultBranch: string,
  onRebased: () => Promise<void> | void
): void {
  if (result.ok) {
    toast.success(`Rebased on origin/${defaultBranch}.`)
    void onRebased()
    return
  }
  switch (result.code) {
    case 'dirty':
      toast.error('Commit or stash your local changes first.')
      return
    case 'conflicts':
      toast.error('Rebase paused with conflicts — use the ✨ Resolve button or open VS Code.', {
        action: {
          label: 'Open in VS Code',
          onClick: () => {
            void openInVSCode(folderPath)
          }
        }
      })
      return
    case 'fetch-failed':
      toast.error(`Could not fetch origin: ${result.message ?? 'fetch failed'}`)
      return
    case 'pull-failed':
      toast.error(`Could not fast-forward ${defaultBranch}: ${result.message ?? 'pull failed'}`)
      return
    case 'rebase-failed':
      toast.error(`Rebase failed: ${result.message ?? 'rebase failed'}`)
      return
    case 'no-default-branch':
      toast.error('Could not determine the default branch.')
      return
    case 'git-failed':
    default:
      toast.error(result.message ?? 'Git command failed.')
  }
}
