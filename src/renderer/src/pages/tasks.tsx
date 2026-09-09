import * as React from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { LoaderCircleIcon, PauseIcon, PlayIcon, PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { TaskColumn } from '@/components/task-column'
import { TaskDetailDialog } from '@/components/task-detail-dialog'
import { TASK_STATUSES, TASK_STATUS_LABELS, useTaskBoard } from '@/contexts/task-board-context'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import type { Repository } from '@shared/repository'
import type { TaskQueueMode } from '@shared/settings'
import type { Task, TaskStatus } from '@shared/task'
import type { TerminalSession, TerminalSessionStatus } from '@shared/terminal-session'
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
  onOpenTask: (task: Task | null) => void
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
  const nextMode = isAutomatic ? 'manual' : 'automatic'
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
        variant={isAutomatic ? 'secondary' : 'outline'}
        size="sm"
        aria-label={`Switch task execution to ${nextMode}`}
        aria-pressed={isAutomatic}
        disabled={modeBusy}
        onClick={() => void onModeChange(nextMode)}
      >
        {modeBusy ? (
          <LoaderCircleIcon className="motion-reduce:animate-none animate-spin" />
        ) : isAutomatic ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
        {isAutomatic ? 'Automatic' : 'Manual'}
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
  onOpenTask
}: TasksPageProps): React.JSX.Element {
  const { tasks, tasksByStatus, createTask, updateTask, deleteTask } = useTaskBoard()
  const { sessions, byId: sessionsById } = useTerminalSessions()
  const startingTaskIdsRef = React.useRef(new Set<string>())
  const [startingTaskIds, setStartingTaskIds] = React.useState<ReadonlySet<string>>(() => new Set())
  const sessionStatusByTaskId = React.useMemo(() => {
    const newestSessionByTaskId = new Map<string, TerminalSession>()
    for (const session of sessions) {
      if (!session.taskId) continue
      const current = newestSessionByTaskId.get(session.taskId)
      if (!current || isNewerSession(session, current)) {
        newestSessionByTaskId.set(session.taskId, session)
      }
    }

    const statuses: Partial<Record<string, TerminalSessionStatus>> = {}
    for (const task of tasks) {
      const persistedSession = task.copilotSessionId
        ? sessionsById[task.copilotSessionId]
        : undefined
      const session = persistedSession ?? newestSessionByTaskId.get(task.id)
      if (session) statuses[task.id] = session.status
    }
    return statuses
  }, [sessions, sessionsById, tasks])

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
                sessionStatusByTaskId={sessionStatusByTaskId}
                onOpenTask={onOpenTask}
                onStartTask={(task) => void handleStartTask(task)}
                onReviewTask={(task) => void onReviewTask(task)}
                onDoneTask={(task) => void onMoveTask(task, 'done')}
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
