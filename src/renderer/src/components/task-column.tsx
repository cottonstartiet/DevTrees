import * as React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { TaskCard } from '@/components/task-card'
import { cn } from '@/lib/utils'
import type { Task, TaskStatus } from '@shared/task'
import type { TerminalSession, TerminalSessionStatus } from '@shared/terminal-session'

function inProgressSessionRank(status?: TerminalSessionStatus): number {
  if (status === 'idle') return 1
  if (status === 'done' || status === 'error' || status === undefined) return 2
  return 0
}

export function TaskColumn({
  status,
  label,
  tasks,
  sessionByTaskId,
  targetOwnerByKey = {},
  onOpenTask,
  onOpenSession,
  onStartTask,
  onReviewTask,
  onDoneTask,
  onDeleteTask,
  startingTaskIds,
  canReviewTask
}: {
  status: TaskStatus
  label: string
  tasks: Task[]
  sessionByTaskId: Partial<Record<string, TerminalSession>>
  targetOwnerByKey?: Record<string, Task | undefined>
  onOpenTask: (task: Task) => void
  onOpenSession: (session: TerminalSession) => void
  onStartTask: (task: Task) => void
  onReviewTask: (task: Task) => void
  onDoneTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
  startingTaskIds: ReadonlySet<string>
  canReviewTask: (task: Task) => boolean
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const displayedTasks = React.useMemo(
    () =>
      status === 'in_progress'
        ? [...tasks].sort(
            (a, b) =>
              inProgressSessionRank(sessionByTaskId[a.id]?.status) -
              inProgressSessionRank(sessionByTaskId[b.id]?.status)
          )
        : tasks,
    [sessionByTaskId, status, tasks]
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="text-muted-foreground text-xs">{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'bg-muted/30 flex min-h-24 flex-1 flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors',
          isOver && 'border-primary bg-primary/5'
        )}
      >
        <SortableContext
          items={displayedTasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {displayedTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              session={sessionByTaskId[task.id]}
              blockedByTask={
                targetOwnerByKey[task.executionTargetKey]?.id === task.id
                  ? undefined
                  : targetOwnerByKey[task.executionTargetKey]
              }
              onOpen={onOpenTask}
              onOpenSession={onOpenSession}
              onStart={onStartTask}
              onReview={onReviewTask}
              onDone={onDoneTask}
              onDelete={onDeleteTask}
              isStarting={startingTaskIds.has(task.id)}
              canReview={canReviewTask(task)}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 ? (
          <p className="text-muted-foreground px-1 py-2 text-center text-xs">No tasks</p>
        ) : null}
      </div>
    </div>
  )
}
