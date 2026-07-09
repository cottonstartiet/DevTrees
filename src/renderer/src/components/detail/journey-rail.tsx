import * as React from 'react'
import {
  ChevronRight as ChevronRightIcon,
  Code2 as Code2Icon,
  Eye as EyeIcon,
  FolderGit2 as FolderGit2Icon,
  GitBranch as GitBranchIcon,
  GitCommitHorizontal as GitCommitHorizontalIcon,
  GitMerge as GitMergeIcon,
  GitPullRequest as GitPullRequestIcon,
  GitPullRequestArrow as GitPullRequestArrowIcon,
  Loader2 as Loader2Icon,
  Sparkles as SparklesIcon,
  TriangleAlert as TriangleAlertIcon,
  Upload as UploadIcon,
  type LucideIcon
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  JourneyActionKind,
  JourneyStageId,
  JourneyStageView,
  JourneyView
} from '@/components/detail/journey-stage'

const STAGE_ICONS: Record<JourneyStageId, LucideIcon> = {
  worktree: FolderGit2Icon,
  branch: GitBranchIcon,
  implement: Code2Icon,
  commit: GitCommitHorizontalIcon,
  push: UploadIcon,
  'create-pr': GitPullRequestArrowIcon,
  review: EyeIcon,
  merged: GitMergeIcon
}

const ACTION_ICONS: Record<JourneyActionKind, LucideIcon | null> = {
  'create-branch': GitBranchIcon,
  'start-implement': SparklesIcon,
  commit: GitCommitHorizontalIcon,
  push: UploadIcon,
  'create-pr': GitPullRequestArrowIcon,
  'open-pr': GitPullRequestIcon,
  'resolve-conflicts': GitMergeIcon,
  checking: Loader2Icon,
  none: null
}

export interface JourneyRailActions {
  onCreateBranch: () => void
  onStartImplement: () => void
  onCommit: () => void
  onPush: () => void
  onCreatePullRequest: () => void
  onOpenPullRequest: () => void
  onResolveConflicts: () => void
}

export interface JourneyRailProps {
  view: JourneyView
  actions: JourneyRailActions
}

export function JourneyRail({ view, actions }: JourneyRailProps): React.JSX.Element {
  const { stages, primary, reduced, reducedHint, conflict } = view

  return (
    <div className="bg-card/40 flex shrink-0 items-center gap-3 overflow-hidden rounded-lg border px-3 py-2">
      <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {stages.map((stage, i) => (
          <li key={stage.id} className="flex min-w-0 items-center gap-1">
            <StageNode stage={stage} />
            {i < stages.length - 1 ? (
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  'size-3 shrink-0',
                  stage.state === 'done' ? 'text-muted-foreground/60' : 'text-border'
                )}
              />
            ) : null}
          </li>
        ))}
      </ol>

      {conflict ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-500">
          <TriangleAlertIcon className="size-3.5" />
          <span className="hidden sm:inline">Conflicts</span>
        </span>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center">
        {reduced ? (
          <span className="text-muted-foreground max-w-[22rem] truncate text-xs" title={reducedHint ?? undefined}>
            {reducedHint}
          </span>
        ) : (
          <PrimaryActionButton primary={primary} actions={actions} conflict={conflict} />
        )}
      </div>
    </div>
  )
}

function StageNode({ stage }: { stage: JourneyStageView }): React.JSX.Element {
  const Icon = STAGE_ICONS[stage.id]
  const isCurrent = stage.state === 'current'
  const isDone = stage.state === 'done'

  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs',
        isCurrent && 'bg-primary/10 text-foreground font-medium',
        isDone && !isCurrent && 'text-muted-foreground',
        !isCurrent && !isDone && 'text-muted-foreground/45'
      )}
      title={stage.label}
      aria-current={isCurrent ? 'step' : undefined}
    >
      <Icon className="size-3.5 shrink-0" />
      <span
        className={cn(
          'truncate',
          isCurrent ? 'inline' : 'hidden lg:inline'
        )}
      >
        {stage.label}
      </span>
    </span>
  )
}

function PrimaryActionButton({
  primary,
  actions,
  conflict
}: {
  primary: JourneyView['primary']
  actions: JourneyRailActions
  conflict: boolean
}): React.JSX.Element | null {
  if (primary.kind === 'none') {
    if (primary.label) {
      return <span className="text-muted-foreground text-xs font-medium">{primary.label}</span>
    }
    return null
  }

  const Icon = ACTION_ICONS[primary.kind]
  const onClick = actionHandler(primary.kind, actions)

  return (
    <Button
      size="sm"
      variant={conflict ? 'outline' : 'default'}
      className="h-7 gap-1.5 px-3"
      disabled={primary.disabled}
      onClick={onClick}
    >
      {primary.loading ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : Icon ? (
        <Icon className="size-3.5" />
      ) : null}
      <span className="text-xs">{primary.label}</span>
    </Button>
  )
}

function actionHandler(kind: JourneyActionKind, actions: JourneyRailActions): () => void {
  switch (kind) {
    case 'create-branch':
      return actions.onCreateBranch
    case 'start-implement':
      return actions.onStartImplement
    case 'commit':
      return actions.onCommit
    case 'push':
      return actions.onPush
    case 'create-pr':
      return actions.onCreatePullRequest
    case 'open-pr':
      return actions.onOpenPullRequest
    case 'resolve-conflicts':
      return actions.onResolveConflicts
    case 'checking':
    case 'none':
      return () => {}
  }
}
