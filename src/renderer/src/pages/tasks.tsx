import * as React from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { TaskColumn } from '@/components/task-column'
import { TaskDetailDialog } from '@/components/task-detail-dialog'
import { TASK_STATUSES, TASK_STATUS_LABELS, useTaskBoard } from '@/contexts/task-board-context'
import { listWorktreesForRepository } from '@/lib/worktrees'
import type { Repository } from '@shared/repository'
import type { Task, TaskStatus } from '@shared/task'
import type { Worktree } from '@shared/worktree'

interface TasksPageProps {
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  createWorktree: (repository: Repository, name: string) => Promise<boolean>
  refreshWorktreesFor: (repositoryId: string) => Promise<void>
  onStartTask: (task: Task) => Promise<void>
  onReviewTask: (task: Task) => Promise<void>
  canReviewTask: (task: Task) => boolean
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  activeTask: Task | null
  onOpenTask: (task: Task | null) => void
}

interface TasksHeaderControlsProps {
  taskCount: number
  onAddTask: () => void
}

export function TasksHeaderControls({
  taskCount,
  onAddTask
}: TasksHeaderControlsProps): React.JSX.Element {
  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-muted-foreground text-xs">
        {taskCount} task{taskCount === 1 ? '' : 's'}
      </span>
      <Button type="button" size="sm" onClick={onAddTask}>
        <PlusIcon />
        Add task
      </Button>
    </div>
  )
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

export function TasksPage({
  repositories,
  worktreesByRepositoryId,
  createWorktree,
  refreshWorktreesFor,
  onStartTask,
  onReviewTask,
  canReviewTask,
  dialogOpen,
  onDialogOpenChange,
  activeTask,
  onOpenTask
}: TasksPageProps): React.JSX.Element {
  const { tasks, tasksByStatus, createTask, updateTask, moveTask, deleteTask } = useTaskBoard()

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const handleCreateWorktree = React.useCallback(
    async (repository: Repository, name: string): Promise<Worktree | null> => {
      const ok = await createWorktree(repository, name)
      if (!ok) return null
      // Trigger the shared hook's refresh so other views stay in sync, but don't rely
      // on its (asynchronously updated) state to resolve the worktree we just made —
      // fetch the fresh list directly to avoid a stale-closure race.
      void refreshWorktreesFor(repository.id)
      try {
        const list = await listWorktreesForRepository(repository.path)
        return list.find((w) => w.path.endsWith(name)) ?? null
      } catch (err) {
        console.error('[tasks] failed to resolve newly created worktree:', err)
        return null
      }
    },
    [createWorktree, refreshWorktreesFor]
  )

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over) return
      const activeId = String(active.id)
      const overId = String(over.id)
      const dragged = tasks.find((t) => t.id === activeId)
      if (!dragged) return

      if (isTaskStatus(overId)) {
        if (dragged.status === overId) return
        void moveTask(activeId, overId, null)
        return
      }

      const overTask = tasks.find((t) => t.id === overId)
      if (!overTask) return
      if (overTask.id === activeId) return
      void moveTask(activeId, overTask.status, overTask.id)
    },
    [tasks, moveTask]
  )

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto">
            {TASK_STATUSES.map((status) => (
              <TaskColumn
                key={status}
                status={status}
                label={TASK_STATUS_LABELS[status]}
                tasks={tasksByStatus[status]}
                onOpenTask={onOpenTask}
                onStartTask={(task) => void onStartTask(task)}
                onReviewTask={(task) => void onReviewTask(task)}
                canReviewTask={canReviewTask}
              />
            ))}
          </div>
        </DndContext>
      </div>

      <TaskDetailDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        task={activeTask}
        repositories={repositories}
        worktreesByRepositoryId={worktreesByRepositoryId}
        onCreate={async ({ title, description, repository, worktree }) => {
          await createTask({
            title,
            description,
            repositoryId: repository.id,
            repositoryName: repository.name,
            repositoryPath: repository.path,
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch
          })
        }}
        onUpdate={async ({ task, title, description, repository, worktree }) => {
          await updateTask({
            id: task.id,
            title,
            description,
            repositoryId: repository.id,
            repositoryName: repository.name,
            repositoryPath: repository.path,
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch
          })
        }}
        onDelete={async (task) => {
          await deleteTask(task.id)
        }}
        onStart={onStartTask}
        onCreateWorktree={handleCreateWorktree}
      />
    </>
  )
}
