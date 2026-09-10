import * as React from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { LoaderCircleIcon, PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { TaskColumn } from '@/components/task-column'
import { TaskDetailDialog } from '@/components/task-detail-dialog'
import { TASK_STATUSES, TASK_STATUS_LABELS, useTaskBoard } from '@/contexts/task-board-context'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import type { BrowserCodeReviewDraft } from '@/lib/deep-links'
import { cn } from '@/lib/utils'
import type { Repository } from '@shared/repository'
import type { TaskQueueMode } from '@shared/settings'
import type { Task, TaskStatus } from '@shared/task'
import type { TerminalSession } from '@shared/terminal-session'
import type { Worktree } from '@shared/worktree'

interface TasksPageProps {
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  onStartTask: (task: Task) => Promise<void>
  onMoveTask: (task: Task, status: TaskStatus, beforeId?: string | null) => Promise<void>
  onReviewTask: (task: Task) => Promise<void>
  canReviewTask: (task: Task) => boolean
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  activeTask: Task | null
  taskDraft: BrowserCodeReviewDraft | null
  onOpenTask: (task: Task | null) => void
  onNavigateToSessions: () => void
}

interface TasksHeaderControlsProps {
  taskCount: number
  queuedCount: number
  runningCount: number
  failedCount: number
  mode: TaskQueueMode
  modeBusy: boolean
  onModeChange: (mode: TaskQueueMode) => Promise<void>
  onAddTask: () => void
}

export function TasksHeaderControls({
  taskCount,
  queuedCount,
  runningCount,
  failedCount,
  mode,
  modeBusy,
  onModeChange,
  onAddTask
}: TasksHeaderControlsProps): React.JSX.Element {
  const readyCount = queuedCount + failedCount
  const isAutomatic = mode === 'automatic'
  return (
    <div className="ml-auto flex items-center gap-3">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <span>
          {taskCount} task{taskCount === 1 ? '' : 's'}
        </span>
        <span aria-hidden="true">·</span>
        <span>{runningCount} running</span>
        <span aria-hidden="true">·</span>
        <span>{readyCount} queued</span>
        {failedCount > 0 ? <span className="text-destructive">{failedCount} failed</span> : null}
      </div>
      <Button
        type="button"
        role="switch"
        variant="outline"
        size="sm"
        aria-checked={isAutomatic}
        disabled={modeBusy}
        className="gap-2.5 motion-reduce:transition-none"
        onClick={() => void onModeChange(isAutomatic ? 'manual' : 'automatic')}
      >
        Factory
        <span
          aria-hidden="true"
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full border transition-colors motion-reduce:transition-none',
            isAutomatic ? 'border-primary bg-primary' : 'border-input bg-input'
          )}
        >
          {modeBusy ? (
            <LoaderCircleIcon
              className={cn(
                'absolute top-0.5 size-3.5 animate-spin motion-reduce:animate-none',
                isAutomatic ? 'left-[18px] text-primary-foreground' : 'left-0.5 text-foreground'
              )}
            />
          ) : (
            <span
              className={cn(
                'bg-background absolute top-0.5 block size-3.5 rounded-full transition-transform motion-reduce:transition-none',
                isAutomatic ? 'translate-x-[18px]' : 'translate-x-0.5'
              )}
            />
          )}
        </span>
      </Button>
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

function isNewerSession(candidate: TerminalSession, current: TerminalSession): boolean {
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  return candidate.id.localeCompare(current.id) > 0
}

export function TasksPage({
  repositories,
  worktreesByRepositoryId,
  onStartTask,
  onMoveTask,
  onReviewTask,
  canReviewTask,
  dialogOpen,
  onDialogOpenChange,
  activeTask,
  taskDraft,
  onOpenTask,
  onNavigateToSessions
}: TasksPageProps): React.JSX.Element {
  const { tasks, tasksByStatus, createTask, updateTask, deleteTask } = useTaskBoard()
  const { sessions, byId: sessionsById, select } = useTerminalSessions()
  const startingTaskIdsRef = React.useRef(new Set<string>())
  const [startingTaskIds, setStartingTaskIds] = React.useState<ReadonlySet<string>>(() => new Set())
  const sessionByTaskId = React.useMemo(() => {
    const newestSessionByTaskId = new Map<string, TerminalSession>()
    for (const session of sessions) {
      if (!session.taskId) continue
      const current = newestSessionByTaskId.get(session.taskId)
      if (!current || isNewerSession(session, current)) {
        newestSessionByTaskId.set(session.taskId, session)
      }
    }

    const resolved: Partial<Record<string, TerminalSession>> = {}
    for (const task of tasks) {
      const persistedSession = task.copilotSessionId
        ? sessionsById[task.copilotSessionId]
        : undefined
      const session = persistedSession ?? newestSessionByTaskId.get(task.id)
      if (session) resolved[task.id] = session
    }
    return resolved
  }, [sessions, sessionsById, tasks])

  const handleOpenSession = React.useCallback(
    (session: TerminalSession): void => {
      select(session.id)
      onNavigateToSessions()
    },
    [onNavigateToSessions, select]
  )

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const handleStartTask = React.useCallback(
    async (task: Task): Promise<void> => {
      if (startingTaskIdsRef.current.has(task.id)) return
      startingTaskIdsRef.current.add(task.id)
      setStartingTaskIds(new Set(startingTaskIdsRef.current))
      try {
        await onStartTask(task)
      } finally {
        startingTaskIdsRef.current.delete(task.id)
        setStartingTaskIds(new Set(startingTaskIdsRef.current))
      }
    },
    [onStartTask]
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
        void onMoveTask(dragged, overId, null)
        return
      }

      const overTask = tasks.find((t) => t.id === overId)
      if (!overTask) return
      if (overTask.id === activeId) return
      void onMoveTask(dragged, overTask.status, overTask.id)
    },
    [tasks, onMoveTask]
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
                sessionByTaskId={sessionByTaskId}
                onOpenTask={onOpenTask}
                onOpenSession={handleOpenSession}
                onStartTask={(task) => void handleStartTask(task)}
                onReviewTask={(task) => void onReviewTask(task)}
                onDoneTask={(task) => void onMoveTask(task, 'done')}
                onDeleteTask={(task) => void deleteTask(task.id)}
                startingTaskIds={startingTaskIds}
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
        initialDraft={taskDraft}
        repositories={repositories}
        worktreesByRepositoryId={worktreesByRepositoryId}
        onCreate={async ({
          title,
          description,
          repository,
          worktreePath,
          worktreeBranch,
          pendingWorktreeName
        }) => {
          const created = await createTask({
            title,
            description,
            repositoryId: repository.id,
            repositoryName: repository.name,
            repositoryPath: repository.path,
            worktreePath,
            worktreeBranch,
            pendingWorktreeName
          })
          return created !== null
        }}
        onUpdate={async ({
          task,
          title,
          description,
          repository,
          worktreePath,
          worktreeBranch,
          pendingWorktreeName
        }) => {
          await updateTask({
            id: task.id,
            title,
            description,
            repositoryId: repository.id,
            repositoryName: repository.name,
            repositoryPath: repository.path,
            worktreePath,
            worktreeBranch,
            pendingWorktreeName
          })
        }}
        onDelete={async (task) => {
          await deleteTask(task.id)
        }}
      />
    </>
  )
}
