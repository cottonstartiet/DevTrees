import * as React from 'react'
import {
  ArrowDownToLine as PullIcon,
  ArrowUpFromLine as PushIcon,
  ExternalLink as OpenFileIcon,
  GitCommit as GitCommitIcon,
  GitCommitVertical as GitCommitVerticalIcon,
  GitCompareArrows as GitCompareArrowsIcon,
  GitMerge as GitMergeIcon,
  Minus as MinusIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshCwIcon,
  RotateCcw as RevertIcon,
  Trash2 as Trash2Icon
} from 'lucide-react'

import { CommitDialog } from '@/components/commit-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkingCopyEntry } from '@shared/repo'

import type { WorkingCopyController } from './use-working-copy-controller'

export interface ChangesTabActionsProps {
  ctrl: WorkingCopyController
}

export function ChangesTabActions({ ctrl }: ChangesTabActionsProps): React.JSX.Element | null {
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false)
  const [confirmRebaseOpen, setConfirmRebaseOpen] = React.useState(false)

  if (!ctrl.folderPath) return null

  const {
    branch,
    defaultBranch,
    folderPath,
    isLoading,
    refresh,
    isPushing,
    isRebasing,
    handlePush,
    isPullingCurrent,
    handlePullCurrent,
    showPullCurrent,
    pullCurrentDisabled,
    handleRebase,
    setCommitMode,
    commitMode,
    handleCommitInBackground,
    showPush,
    showRebase,
    pushDisabled,
    rebaseDisabled,
    commitStagedDisabled,
    commitAllDisabled,
    hasPending,
    stagedCount,
    unpushedCount,
    isDiscarding,
    handleDiscardAll,
    discardDisabled,
    stagedRows,
    changedRows,
    untrackedRows,
    conflictedCount
  } = ctrl

  const discardTotal = stagedRows.length + changedRows.length + untrackedRows.length

  return (
    <>
      {showPullCurrent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                disabled={pullCurrentDisabled}
                onClick={() => void handlePullCurrent()}
              >
                {isPullingCurrent ? (
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                ) : (
                  <PullIcon className="size-3.5" />
                )}
                <span className="text-xs">{isPullingCurrent ? 'Pulling…' : 'Pull'}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {isPullingCurrent
              ? `Pulling origin into ${branch}…`
              : conflictedCount > 0
                ? 'Resolve conflicts before pulling.'
                : `Run \`git pull --ff-only\` for ${branch}.`}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showPush ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                disabled={pushDisabled}
                onClick={() => void handlePush()}
              >
                {isPushing ? (
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                ) : (
                  <PushIcon className="size-3.5" />
                )}
                <span className="text-xs">
                  {isPushing ? 'Pushing…' : unpushedCount > 0 ? `Push (${unpushedCount})` : 'Push'}
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {isPushing
              ? `Pushing to origin/${branch}…`
              : unpushedCount === 0
                ? `All commits pushed to origin/${branch}.`
                : `Push ${unpushedCount} commit${unpushedCount === 1 ? '' : 's'} to origin/${branch}.`}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showRebase ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                disabled={rebaseDisabled}
                onClick={() => setConfirmRebaseOpen(true)}
              >
                {isRebasing ? (
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                ) : (
                  <GitMergeIcon className="size-3.5" />
                )}
                <span className="text-xs">{isRebasing ? 'Rebasing…' : 'Rebase'}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {isRebasing
              ? `Rebasing on origin/${defaultBranch}…`
              : `Rebase ${branch} onto origin/${defaultBranch}.`}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2"
              disabled={commitStagedDisabled}
              onClick={() => setCommitMode('staged')}
            >
              <GitCommitIcon className="size-3.5" />
              <span className="text-xs">Commit staged</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {hasPending
            ? 'Waiting for staging operations to finish…'
            : commitStagedDisabled
              ? 'Nothing staged to commit.'
              : `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}.`}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2"
              disabled={commitAllDisabled}
              onClick={() => setCommitMode('all')}
            >
              <GitCommitVerticalIcon className="size-3.5" />
              <span className="text-xs">Commit all</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {hasPending
            ? 'Waiting for staging operations to finish…'
            : commitAllDisabled
              ? 'Working tree is clean.'
              : 'Stage every change (incl. untracked) and commit.'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive h-7 gap-1.5 px-2"
              disabled={discardDisabled}
              onClick={() => setConfirmDiscardOpen(true)}
            >
              {isDiscarding ? (
                <RefreshCwIcon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              <span className="text-xs">{isDiscarding ? 'Discarding…' : 'Discard all'}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {hasPending
            ? 'Waiting for staging operations to finish…'
            : discardDisabled
              ? 'Working tree is clean.'
              : 'Reset tracked files and delete untracked files (preserves ignored files).'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void refresh()}
            disabled={isLoading}
            aria-label="Refresh working copy status"
          >
            <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh</TooltipContent>
      </Tooltip>
      <CommitDialog
        folderPath={folderPath}
        mode={commitMode ?? 'staged'}
        open={commitMode !== null}
        onOpenChange={(open) => {
          if (!open) setCommitMode(null)
        }}
        onSubmit={handleCommitInBackground}
      />
      <DiscardAllConfirmDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
        stagedCount={stagedRows.length}
        changedCount={changedRows.length}
        untrackedCount={untrackedRows.length}
        totalCount={discardTotal}
        isDiscarding={isDiscarding}
        onConfirm={() => {
          setConfirmDiscardOpen(false)
          void handleDiscardAll()
        }}
      />
      <ConfirmDialog
        open={confirmRebaseOpen}
        onOpenChange={setConfirmRebaseOpen}
        title={`Rebase ${branch ?? 'branch'} onto origin/${defaultBranch ?? 'default'}?`}
        description="Make sure your working tree is clean before continuing."
        confirmLabel="Rebase"
        onConfirm={() => void handleRebase()}
      />
    </>
  )
}

interface DiscardAllConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  stagedCount: number
  changedCount: number
  untrackedCount: number
  totalCount: number
  isDiscarding: boolean
  onConfirm: () => void
}

function DiscardAllConfirmDialog({
  open,
  onOpenChange,
  stagedCount,
  changedCount,
  untrackedCount,
  totalCount,
  isDiscarding,
  onConfirm
}: DiscardAllConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard all local changes?</DialogTitle>
          <DialogDescription>This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p>
            This will reset every tracked file to <code className="bg-muted rounded px-1 font-mono">HEAD</code>{' '}
            and <strong>permanently delete</strong> untracked files and folders in the working tree.
          </p>
          <ul className="bg-muted/50 flex flex-col gap-1 rounded-md px-3 py-2 font-mono text-xs">
            <li>
              <span className="text-emerald-700 dark:text-emerald-300">Staged</span>: {stagedCount}{' '}
              file{stagedCount === 1 ? '' : 's'}
            </li>
            <li>
              <span className="text-amber-700 dark:text-amber-300">Changed</span>: {changedCount}{' '}
              file{changedCount === 1 ? '' : 's'}
            </li>
            <li>
              <span className="text-muted-foreground">Untracked</span>: {untrackedCount} file
              {untrackedCount === 1 ? '' : 's'}
            </li>
          </ul>
          <p className="text-muted-foreground text-xs">
            Files matched by <code className="bg-muted rounded px-1 font-mono">.gitignore</code>{' '}
            (e.g. <code className="bg-muted rounded px-1 font-mono">node_modules</code>) are
            preserved.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isDiscarding || totalCount === 0}
            onClick={onConfirm}
          >
            {isDiscarding ? 'Discarding…' : `Discard ${totalCount} change${totalCount === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface WorkingCopyStatusViewProps {
  ctrl: WorkingCopyController
}

export function WorkingCopyStatusView({ ctrl }: WorkingCopyStatusViewProps): React.JSX.Element {
  const {
    data,
    error,
    description,
    entries,
    stagedRows,
    changedRows,
    untrackedRows,
    pending,
    handleStage,
    handleUnstage,
    handleStageAll,
    handleUnstageAll,
    handleRevert,
    handleOpenFile,
    handleOpenAllInVSCode,
    isCommitting,
    folderPath
  } = ctrl

  return (
    <section className="bg-card text-card-foreground flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg border shadow-sm">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="truncate text-sm font-semibold tracking-tight">Working copy</h3>
          <div className="text-muted-foreground text-xs leading-snug">{description}</div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 shrink-0 gap-1.5 px-2"
              disabled={!folderPath}
              onClick={() => void handleOpenAllInVSCode()}
            >
              <GitCompareArrowsIcon className="size-3.5" />
              <span className="text-xs">View in VS Code</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Open the folder in VS Code with the Source Control panel focused to review all
            changes.
          </TooltipContent>
        </Tooltip>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3">
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : !data ? (
          <p className="text-muted-foreground text-xs italic">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">No changes.</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {stagedRows.length > 0 ? (
              <FileSection
                label="Staged"
                tone="ok"
                entries={stagedRows}
                pending={pending}
                actionKind="unstage"
                disabled={isCommitting}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onBulkAction={handleUnstageAll}
                onRevert={handleRevert}
                onOpenFile={handleOpenFile}
              />
            ) : null}
            {changedRows.length > 0 ? (
              <FileSection
                label="Changed"
                tone="warn"
                entries={changedRows}
                pending={pending}
                actionKind="stage"
                disabled={isCommitting}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onBulkAction={handleStageAll}
                onRevert={handleRevert}
                onOpenFile={handleOpenFile}
              />
            ) : null}
            {untrackedRows.length > 0 ? (
              <FileSection
                label="Untracked"
                tone="muted"
                entries={untrackedRows}
                pending={pending}
                actionKind="stage"
                disabled={isCommitting}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onBulkAction={handleStageAll}
                onRevert={handleRevert}
                onOpenFile={handleOpenFile}
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

interface FileSectionProps {
  label: string
  tone: 'ok' | 'warn' | 'muted'
  entries: WorkingCopyEntry[]
  pending: Set<string>
  actionKind: 'stage' | 'unstage'
  disabled?: boolean
  onStage: (entry: WorkingCopyEntry) => void | Promise<void>
  onUnstage: (entry: WorkingCopyEntry) => void | Promise<void>
  onBulkAction?: (entries: WorkingCopyEntry[]) => void | Promise<void>
  onRevert: (entry: WorkingCopyEntry) => void | Promise<void>
  onOpenFile: (entry: WorkingCopyEntry) => void | Promise<void>
}

function FileSection({
  label,
  tone,
  entries,
  pending,
  actionKind,
  disabled = false,
  onStage,
  onUnstage,
  onBulkAction,
  onRevert,
  onOpenFile
}: FileSectionProps): React.JSX.Element {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-muted-foreground'
  const canStage = actionKind === 'stage'
  const canUnstage = actionKind === 'unstage'
  const onAction = actionKind === 'stage' ? onStage : onUnstage
  const bulkLabel = actionKind === 'stage' ? 'Stage all' : 'Unstage all'
  const bulkTooltip =
    actionKind === 'stage'
      ? `Stage all ${entries.length} ${label.toLowerCase()} file${entries.length === 1 ? '' : 's'}.`
      : `Unstage all ${entries.length} staged file${entries.length === 1 ? '' : 's'}.`
  const anyPending = entries.some((e) => pending.has(e.path))
  const bulkDisabled = disabled || anyPending || entries.length === 0
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <header className="flex items-center gap-2">
        <h4 className={cn('text-[11px] font-semibold tracking-wide uppercase', toneClass)}>
          {label}
        </h4>
        <span className="text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          {entries.length}
        </span>
        {onBulkAction ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5"
                  disabled={bulkDisabled}
                  onClick={() => void onBulkAction(entries)}
                >
                  {actionKind === 'stage' ? (
                    <PlusIcon className="size-3.5" />
                  ) : (
                    <MinusIcon className="size-3.5" />
                  )}
                  <span className="text-[11px]">{bulkLabel}</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{bulkTooltip}</TooltipContent>
          </Tooltip>
        ) : null}
      </header>
      <ul className="flex min-w-0 flex-col">
        {entries.map((entry) => {
          const key = `${actionKind}::${entry.path}`
          const isPending = pending.has(entry.path) || disabled
          const code = formatStatusCode(entry, actionKind)
          const tooltip = actionKind === 'stage' ? `Stage ${entry.path}` : `Unstage ${entry.path}`
          return (
            <ContextMenu key={key}>
              <ContextMenuTrigger asChild>
                <li
                  className="hover:bg-muted/50 group flex min-w-0 cursor-default items-center gap-2 overflow-hidden rounded px-2 py-1 text-xs"
                  onDoubleClick={() => void onOpenFile(entry)}
                >
                  <span
                    className="bg-muted text-muted-foreground inline-flex h-5 min-w-[1.75rem] shrink-0 items-center justify-center rounded font-mono text-[10px] tabular-nums"
                    title={`${entry.indexStatus}${entry.worktreeStatus}`}
                  >
                    {code}
                  </span>
                  <span
                    className="text-foreground min-w-0 flex-1 truncate font-mono whitespace-nowrap"
                    title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
                  >
                    {entry.originalPath ? (
                      <>
                        <span className="text-muted-foreground">{entry.originalPath} → </span>
                        {entry.path}
                      </>
                    ) : (
                      entry.path
                    )}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0"
                        disabled={isPending}
                        onClick={() => void onAction(entry)}
                        aria-label={tooltip}
                      >
                        {actionKind === 'stage' ? (
                          <PlusIcon className="size-3.5" />
                        ) : (
                          <MinusIcon className="size-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{tooltip}</TooltipContent>
                  </Tooltip>
                </li>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-40">
                <ContextMenuItem disabled={isPending} onSelect={() => void onOpenFile(entry)}>
                  <OpenFileIcon />
                  Open file
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={isPending || !canStage}
                  onSelect={() => void onStage(entry)}
                >
                  <PlusIcon />
                  Stage
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={isPending || !canUnstage}
                  onSelect={() => void onUnstage(entry)}
                >
                  <MinusIcon />
                  Unstage
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  disabled={isPending}
                  onSelect={() => void onRevert(entry)}
                >
                  <RevertIcon />
                  Revert
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </ul>
    </section>
  )
}

function formatStatusCode(entry: WorkingCopyEntry, actionKind: 'stage' | 'unstage'): string {
  if (entry.isUntracked) return '??'
  const x = entry.indexStatus === ' ' ? '·' : entry.indexStatus
  const y = entry.worktreeStatus === ' ' ? '·' : entry.worktreeStatus
  return actionKind === 'stage' ? `·${y}` : `${x}·`
}
