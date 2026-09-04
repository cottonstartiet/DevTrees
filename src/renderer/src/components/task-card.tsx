import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FolderGit2Icon, GitBranchIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Task } from '@shared/task'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

export function TaskCard({
  task,
  onOpen,
  onStart,
  onReview,
  canReview
}: {
  task: Task
  onOpen: (task: Task) => void
  onStart: (task: Task) => void
  onReview: (task: Task) => void
  canReview: boolean
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }

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
      <p className="text-sm font-medium break-words">{task.title}</p>
      {task.description ? (
        <p className="text-muted-foreground line-clamp-2 text-xs break-words">{task.description}</p>
      ) : null}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1">
          <FolderGit2Icon className="size-3" />
          {task.repositoryName}
        </span>
        <span className="inline-flex items-center gap-1">
          <GitBranchIcon className="size-3" />
          {task.worktreeBranch ?? worktreeLabel(task.worktreePath)}
        </span>
      </div>
      {task.status === 'todo' ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-1 self-start"
          onClick={(e) => {
            e.stopPropagation()
            onStart(task)
          }}
        >
          Start
        </Button>
      ) : null}
      {task.status === 'in_progress' && canReview ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-1 self-start"
          onClick={(e) => {
            e.stopPropagation()
            onReview(task)
          }}
        >
          Move to review
        </Button>
      ) : null}
    </div>
  )
}
