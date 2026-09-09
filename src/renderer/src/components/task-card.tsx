import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FolderGit2Icon, GitBranchIcon, LoaderCircleIcon } from 'lucide-react'

import { TerminalSessionStatusBadge } from '@/components/sessions/terminal-session-status-badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Task } from '@shared/task'
import type { TerminalSessionStatus } from '@shared/terminal-session'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

export function TaskCard({
  task,
  sessionStatus,
  onOpen,
  onReview,
  onDone,
  canReview
}: {
  task: Task
  sessionStatus: TerminalSessionStatus | undefined
  onOpen: (task: Task) => void
  onReview: (task: Task) => void
  onDone: (task: Task) => void
  canReview: boolean
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  const isQueuedStage = task.status === 'todo' || task.status === 'review'
  const queueLabel =
    task.queueStatus === 'running'
      ? 'Running'
      : task.queueStatus === 'failed'
        ? 'Failed'
        : task.queueStatus === 'queued'
          ? 'Queued'
          : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(task)}
      className={cn(
        'bg-card flex cursor-pointer flex-col gap-2 rounded-md border p-3 text-left shadow-xs transition-colors',
        'hover:bg-accent/50',
        isDragging && 'opacity-50'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium break-words">{task.title}</p>
        {isQueuedStage && queueLabel ? (
          <span
            className={cn(
              'bg-secondary text-secondary-foreground inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium',
              task.queueStatus === 'failed' && 'bg-destructive/10 text-destructive'
            )}
          >
            {task.queueStatus === 'running' ? (
              <LoaderCircleIcon className="motion-reduce:animate-none size-3 animate-spin" />
            ) : null}
            {queueLabel}
          </span>
        ) : task.status === 'in_progress' && sessionStatus ? (
          <TerminalSessionStatusBadge status={sessionStatus} className="rounded px-1.5" />
        ) : null}
      </div>
      {task.description ? (
        <p className="text-muted-foreground line-clamp-2 text-xs break-words">{task.description}</p>
      ) : null}
      {task.sourceProvider && task.sourceId ? (
        <p className="text-muted-foreground truncate text-xs">
          {task.sourceProvider === 'ado' ? 'Azure DevOps' : 'GitHub'} · {task.sourceId}
        </p>
      ) : null}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1">
          <FolderGit2Icon className="size-3" />
          {task.repositoryName}
        </span>
        <span className="inline-flex items-center gap-1">
          <GitBranchIcon className="size-3" />
          {task.pendingWorktreeName
            ? `${task.pendingWorktreeName} (planned)`
            : task.worktreePath === task.repositoryPath
              ? 'Main branch'
              : (task.worktreeBranch ?? worktreeLabel(task.worktreePath))}
        </span>
      </div>
      {task.status === 'in_progress' || task.status === 'review' ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {task.status === 'in_progress' && canReview ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                onReview(task)
              }}
            >
              Move to review
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation()
              onDone(task)
            }}
          >
            Mark done
          </Button>
        </div>
      ) : null}
    </div>
  )
}
