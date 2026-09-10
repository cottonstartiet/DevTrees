import * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { TASK_STATUS_LABELS } from '@/contexts/task-board-context'
import type { Repository } from '@shared/repository'
import type { Task, TaskStatus } from '@shared/task'
import type { Worktree } from '@shared/worktree'

const VALID_WORKTREE_NAME = /^[A-Za-z0-9._-]+$/
const MAX_NAME_LENGTH = 64

const MAIN_BRANCH_VALUE = '__main-branch__'
const NEW_WORKTREE_VALUE = '__new-worktree__'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

function validateWorktreeName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required.'
  if (trimmed.length > MAX_NAME_LENGTH) return `Name must be ≤ ${MAX_NAME_LENGTH} characters.`
  if (!VALID_WORKTREE_NAME.test(trimmed))
    return 'Only letters, digits, dot, underscore, and hyphen are allowed.'
  return null
}

export interface TaskDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present for edit/detail mode; absent for "Add Task". */
  task: Task | null
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  initialDraft?: {
    id: string
    title: string
    description: string
    repositoryName: string | null
  } | null
  onCreate: (input: {
    title: string
    description: string
    repository: Repository
    worktreePath: string
    worktreeBranch: string | null
    pendingWorktreeName: string | null
  }) => Promise<boolean>
  onUpdate: (input: {
    task: Task
    title: string
    description: string
    repository: Repository
    worktreePath: string
    worktreeBranch: string | null
    pendingWorktreeName: string | null
  }) => Promise<void>
  onDelete: (task: Task) => Promise<void>
}

type TaskFormProps = Omit<TaskDetailDialogProps, 'open'>

/**
 * The actual form. Mounted fresh (via a `key` on the caller) each time the dialog opens for a
 * given task/create flow, so its local state can simply initialize from props instead of being
 * reset from an effect.
 */
function TaskDetailForm({
  onOpenChange,
  task,
  repositories,
  worktreesByRepositoryId,
  initialDraft,
  onCreate,
  onUpdate,
  onDelete
}: TaskFormProps): React.JSX.Element {
  const isEdit = task != null

  const matchedDraftRepositories = initialDraft?.repositoryName
    ? repositories.filter(
        (repository) =>
          repository.name.localeCompare(initialDraft.repositoryName!, undefined, {
            sensitivity: 'accent'
          }) === 0
      )
    : []
  const [title, setTitle] = React.useState(task?.title ?? initialDraft?.title ?? '')
  const [description, setDescription] = React.useState(
    task?.description ?? initialDraft?.description ?? ''
  )
  const [repositoryId, setRepositoryId] = React.useState<string>(
    task?.repositoryId ??
      (initialDraft
        ? matchedDraftRepositories.length === 1
          ? matchedDraftRepositories[0].id
          : ''
        : (repositories[0]?.id ?? ''))
  )
  const initialSelection = task?.pendingWorktreeName
    ? NEW_WORKTREE_VALUE
    : task && task.worktreePath === task.repositoryPath
      ? MAIN_BRANCH_VALUE
      : (task?.worktreePath ?? '')
  const [worktreeSelection, setWorktreeSelection] = React.useState<string>(initialSelection)
  const [newWorktreeName, setNewWorktreeName] = React.useState(task?.pendingWorktreeName ?? '')
  const [editedFields, setEditedFields] = React.useState({
    title: false,
    worktree: false,
    newWorktreeName: false
  })
  const [submitAttempted, setSubmitAttempted] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [portalContainer, setPortalContainer] = React.useState<HTMLDivElement | null>(null)

  const repository = repositories.find((r) => r.id === repositoryId) ?? null
  const worktrees = repository ? (worktreesByRepositoryId[repository.id] ?? []) : []
  const creatingNewWorktree = worktreeSelection === NEW_WORKTREE_VALUE
  /** Once work has started, the task's scope is frozen — the fields become read-only. */
  const readOnly = isEdit && task.status !== 'todo'

  const titleError = !title.trim() ? 'Title is required.' : null
  const worktreeNameError = creatingNewWorktree ? validateWorktreeName(newWorktreeName) : null
  const worktreeError =
    !creatingNewWorktree && !worktreeSelection ? 'Select where this task will run.' : null
  const showTitleError = (editedFields.title || submitAttempted) && titleError !== null
  const showWorktreeError = (editedFields.worktree || submitAttempted) && worktreeError !== null
  const showWorktreeNameError =
    (editedFields.newWorktreeName || submitAttempted) && worktreeNameError !== null

  const handleRepositoryChange = (id: string): void => {
    setRepositoryId(id)
    setWorktreeSelection('')
    setNewWorktreeName('')
    setEditedFields((current) => ({
      ...current,
      worktree: false,
      newWorktreeName: false
    }))
  }

  const handleWorktreeSelectionChange = (selection: string): void => {
    setWorktreeSelection(selection)
    setEditedFields((current) => ({
      ...current,
      worktree: true,
      newWorktreeName: false
    }))
  }

  const resolveWorktree = (): {
    worktreePath: string
    worktreeBranch: string | null
    pendingWorktreeName: string | null
  } | null => {
    if (!repository) return null
    if (creatingNewWorktree) {
      if (validateWorktreeName(newWorktreeName)) return null
      return {
        worktreePath: repository.path,
        worktreeBranch: null,
        pendingWorktreeName: newWorktreeName.trim()
      }
    }
    if (worktreeSelection === MAIN_BRANCH_VALUE) {
      return {
        worktreePath: repository.path,
        worktreeBranch: null,
        pendingWorktreeName: null
      }
    }
    const worktree = worktrees.find((w) => w.path === worktreeSelection)
    return worktree
      ? {
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          pendingWorktreeName: null
        }
      : null
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    if (readOnly) return
    setSubmitAttempted(true)
    if (!title.trim() || !repository) return
    if (creatingNewWorktree && worktreeNameError) return
    if (!creatingNewWorktree && !worktreeSelection) return

    setBusy(true)
    try {
      const target = resolveWorktree()
      if (!target) return
      if (isEdit && task) {
        await onUpdate({ task, title: title.trim(), description, repository, ...target })
      } else {
        const created = await onCreate({
          title: title.trim(),
          description,
          repository,
          ...target
        })
        if (!created) return
      }
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!task) return
    setBusy(true)
    try {
      await onDelete(task)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const statusLabel: string | null = task ? TASK_STATUS_LABELS[task.status as TaskStatus] : null

  return (
    <DialogContent
      ref={setPortalContainer}
      className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-y-auto sm:max-w-2xl"
    >
      <DialogHeader className="min-w-0">
        <DialogTitle>{isEdit ? 'Task details' : 'Add task'}</DialogTitle>
        <DialogDescription className="break-words">
          {isEdit
            ? readOnly
              ? `Status: ${statusLabel} · read-only. Move the task back to To Do to edit it.`
              : `Status: ${statusLabel}`
            : 'Create a task and choose where it will run.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="task-title" className="text-sm font-medium">
            Title
          </label>
          <Input
            id="task-title"
            autoFocus
            disabled={readOnly}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setEditedFields((current) => ({ ...current, title: true }))
            }}
            placeholder="Fix the login bug"
            aria-invalid={showTitleError || undefined}
          />
          {showTitleError ? <p className="text-destructive text-xs">{titleError}</p> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="task-description" className="text-sm font-medium">
            Description
          </label>
          <Textarea
            id="task-description"
            disabled={readOnly}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add more context for this task…"
            rows={4}
            className="max-w-full min-w-0 field-sizing-fixed resize-y [overflow-wrap:anywhere]"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="task-repository-label" className="text-sm font-medium">
            Repository
          </span>
          <Select value={repositoryId} onValueChange={handleRepositoryChange} disabled={readOnly}>
            <SelectTrigger className="w-full min-w-0" aria-labelledby="task-repository-label">
              <SelectValue placeholder="Select a repository" />
            </SelectTrigger>
            <SelectContent portalContainer={portalContainer}>
              {repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="task-worktree-label" className="text-sm font-medium">
            Run in
          </span>
          <Select
            value={worktreeSelection}
            onValueChange={handleWorktreeSelectionChange}
            disabled={readOnly || !repository}
          >
            <SelectTrigger
              className="w-full min-w-0"
              aria-labelledby="task-worktree-label"
              aria-invalid={showWorktreeError || undefined}
            >
              <SelectValue placeholder="Select a worktree" />
            </SelectTrigger>
            <SelectContent portalContainer={portalContainer}>
              <SelectItem value={MAIN_BRANCH_VALUE}>Main branch</SelectItem>
              {worktrees.map((wt) => (
                <SelectItem key={wt.path} value={wt.path}>
                  {wt.branch ?? worktreeLabel(wt.path)}
                </SelectItem>
              ))}
              <SelectItem value={NEW_WORKTREE_VALUE}>+ Create new worktree…</SelectItem>
            </SelectContent>
          </Select>
          {showWorktreeError ? <p className="text-destructive text-xs">{worktreeError}</p> : null}
          {creatingNewWorktree ? (
            <div className="flex flex-col gap-1 pt-1">
              <Input
                value={newWorktreeName}
                onChange={(e) => {
                  setNewWorktreeName(e.target.value)
                  setEditedFields((current) => ({ ...current, newWorktreeName: true }))
                }}
                placeholder="feature-x"
                aria-invalid={showWorktreeNameError || undefined}
              />
              {showWorktreeNameError ? (
                <p className="text-destructive text-xs">{worktreeNameError}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  The worktree will be created when this task moves to In Progress.
                </p>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {isEdit ? (
              <Button type="button" variant="destructive" disabled={busy} onClick={handleDelete}>
                Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {readOnly ? null : (
              <Button type="submit" disabled={busy}>
                {isEdit ? 'Save' : 'Create task'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

export function TaskDetailDialog(props: TaskDetailDialogProps): React.JSX.Element {
  const { open, onOpenChange, task, initialDraft } = props

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {open ? <TaskDetailForm key={task?.id ?? initialDraft?.id ?? 'new'} {...props} /> : null}
    </Dialog>
  )
}
