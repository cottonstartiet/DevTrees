import * as React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { TaskCard } from '@/components/task-card'
import { cn } from '@/lib/utils'
import type { Task, TaskStatus } from '@shared/task'
import type { TerminalSessionStatus } from '@shared/terminal-session'

export function TaskColumn({
  status,
  label,
  tasks,
  sessionStatusByTaskId,
  onOpenTask,
  onStartTask,
  onReviewTask,
  onDoneTask,
  startingTaskIds,
  canReviewTask
}: {
  status: TaskStatus
  label: string
  tasks: Task[]
  sessionStatusByTaskId: Partial<Record<string, TerminalSessionStatus>>
  onOpenTask: (task: Task) => void
  onStartTask: (task: Task) => void
  onReviewTask: (task: Task) => void
  onDoneTask: (task: Task) => void
  startingTaskIds: ReadonlySet<string>
  canReviewTask: (task: Task) => boolean
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: status })

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
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              sessionStatus={sessionStatusByTaskId[task.id]}
              onOpen={onOpenTask}
              onStart={onStartTask}
              onReview={onReviewTask}
              onDone={onDoneTask}
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
