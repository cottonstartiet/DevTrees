import * as React from 'react'
import {
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  PaperclipIcon,
  PresentationIcon,
  XIcon
} from 'lucide-react'

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
import { discardTaskAttachmentStage, pickTaskAttachments } from '@/lib/tasks'
import type { Repository } from '@shared/repository'
import type {
  Task,
  TaskAttachmentSelection,
  TaskIntent,
  TaskStatus
} from '@shared/task'
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
    kind?: TaskIntent
    title: string
    description: string
    repositoryName: string | null
  } | null
  onCreate: (input: {
    intent: TaskIntent
    title: string
    description: string
    repository: Repository
    worktreePath: string
    worktreeBranch: string | null
    pendingWorktreeName: string | null
    attachmentStageId: string
    attachments: TaskAttachmentSelection[]
  }) => Promise<boolean>
  onUpdate: (input: {
    task: Task
    title: string
    description: string
    repository: Repository
    worktreePath: string
    worktreeBranch: string | null
    pendingWorktreeName: string | null
    attachmentStageId: string
    attachments: TaskAttachmentSelection[]
  }) => Promise<boolean>
  onDelete: (task: Task) => Promise<void>
}

interface TaskCreateDraft {
  intent: TaskIntent
  title: string
  description: string
  repositoryId: string
  repositoryNameHint: string | null
  worktreeSelection: string
  newWorktreeName: string
  attachmentStageId: string
  attachments: TaskAttachmentSelection[]
}

function createEmptyTaskDraft(
  repositories: Repository[],
  initialDraft?: TaskDetailDialogProps['initialDraft']
): TaskCreateDraft {
  const matchedRepositories = initialDraft?.repositoryName
    ? repositories.filter(
        (repository) =>
          repository.name.localeCompare(initialDraft.repositoryName!, undefined, {
            sensitivity: 'accent'
          }) === 0
      )
    : []
  const repositoryId = initialDraft
    ? matchedRepositories.length === 1
      ? matchedRepositories[0].id
      : ''
    : (repositories[0]?.id ?? '')

  return {
    intent: initialDraft?.kind ?? 'task',
    title: initialDraft?.title ?? '',
    description: initialDraft?.description ?? '',
    repositoryId,
    repositoryNameHint: initialDraft?.repositoryName ?? null,
    worktreeSelection: repositoryId ? MAIN_BRANCH_VALUE : '',
    newWorktreeName: '',
    attachmentStageId: crypto.randomUUID(),
    attachments: []
  }
}

type TaskFormProps = Omit<TaskDetailDialogProps, 'open'> & {
  createDraft: TaskCreateDraft
  onCreateDraftChange: (draft: TaskCreateDraft) => void
}

/**
 * The actual form. Create values are mirrored into the dialog-owned draft before this component
 * unmounts; edit values remain scoped to the selected persisted task.
 */
function TaskDetailForm({
  onOpenChange,
  task,
  repositories,
  worktreesByRepositoryId,
  createDraft,
  onCreateDraftChange,
  onCreate,
  onUpdate,
  onDelete
}: TaskFormProps): React.JSX.Element {
  const isEdit = task != null

  const matchedDraftRepositories = createDraft.repositoryNameHint
    ? repositories.filter(
        (repository) =>
          repository.name.localeCompare(createDraft.repositoryNameHint!, undefined, {
            sensitivity: 'accent'
          }) === 0
      )
    : []
  const [title, setTitleState] = React.useState(task?.title ?? createDraft.title)
  const [description, setDescription] = React.useState(
    task?.description ?? createDraft.description
  )
  const initialRepositoryId = task?.repositoryId ?? createDraft.repositoryId
  const [repositoryId, setRepositoryId] = React.useState<string>(initialRepositoryId)
  const initialSelection = task?.pendingWorktreeName
    ? NEW_WORKTREE_VALUE
    : task && task.worktreePath === task.repositoryPath
      ? MAIN_BRANCH_VALUE
      : (task?.worktreePath ?? createDraft.worktreeSelection)
  const [worktreeSelection, setWorktreeSelection] = React.useState<string>(initialSelection)
  const [newWorktreeName, setNewWorktreeNameState] = React.useState(
    task?.pendingWorktreeName ?? createDraft.newWorktreeName
  )
  const [editAttachmentStageId] = React.useState(() => crypto.randomUUID())
  const attachmentStageId = isEdit ? editAttachmentStageId : createDraft.attachmentStageId
  const [attachments, setAttachmentsState] = React.useState<TaskAttachmentSelection[]>(() =>
    task
      ? task.attachments.map((attachment) => ({ ...attachment, staged: false }))
      : createDraft.attachments
  )
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null)
  const [attaching, setAttaching] = React.useState(false)
  const [editedFields, setEditedFields] = React.useState({
    title: false,
    worktree: false,
    newWorktreeName: false
  })
  const [submitAttempted, setSubmitAttempted] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const formRef = React.useRef<HTMLFormElement>(null)

  React.useEffect(() => {
    if (!isEdit) return
    return () => {
      void discardTaskAttachmentStage({ stageId: attachmentStageId })
    }
  }, [attachmentStageId, isEdit])

  const updateCreateDraft = (patch: Partial<TaskCreateDraft>): void => {
    if (!isEdit) onCreateDraftChange({ ...createDraft, ...patch })
  }

  const setTitle = (value: string): void => {
    setTitleState(value)
    updateCreateDraft({ title: value })
  }

  const setDescriptionValue = (value: string): void => {
    setDescription(value)
    updateCreateDraft({ description: value })
  }

  const setNewWorktreeName = (value: string): void => {
    setNewWorktreeNameState(value)
    updateCreateDraft({ newWorktreeName: value })
  }

  const setAttachments = (
    update:
      | TaskAttachmentSelection[]
      | ((current: TaskAttachmentSelection[]) => TaskAttachmentSelection[])
  ): void => {
    const next = typeof update === 'function' ? update(attachments) : update
    setAttachmentsState(next)
    updateCreateDraft({ attachments: next })
  }

  const effectiveRepositoryId =
    repositoryId ||
    (!isEdit
      ? createDraft.repositoryNameHint
        ? matchedDraftRepositories.length === 1
          ? matchedDraftRepositories[0].id
          : ''
        : (repositories[0]?.id ?? '')
      : '')
  const effectiveWorktreeSelection =
    worktreeSelection || (!isEdit && effectiveRepositoryId ? MAIN_BRANCH_VALUE : '')
  const repository = repositories.find((r) => r.id === effectiveRepositoryId) ?? null
  const worktrees = repository ? (worktreesByRepositoryId[repository.id] ?? []) : []
  const creatingNewWorktree = effectiveWorktreeSelection === NEW_WORKTREE_VALUE
  /** Once work has started, the task's scope is frozen — the fields become read-only. */
  const readOnly = isEdit && task.status !== 'todo'

  const titleError = !title.trim() ? 'Title is required.' : null
  const worktreeNameError = creatingNewWorktree ? validateWorktreeName(newWorktreeName) : null
  const worktreeError =
    !creatingNewWorktree && !effectiveWorktreeSelection ? 'Select where this task will run.' : null
  const showTitleError = (editedFields.title || submitAttempted) && titleError !== null
  const showWorktreeError = (editedFields.worktree || submitAttempted) && worktreeError !== null
  const showWorktreeNameError =
    (editedFields.newWorktreeName || submitAttempted) && worktreeNameError !== null

  const handleRepositoryChange = (id: string): void => {
    setRepositoryId(id)
    setWorktreeSelection(id ? MAIN_BRANCH_VALUE : '')
    setNewWorktreeName('')
    updateCreateDraft({
      repositoryId: id,
      repositoryNameHint: null,
      worktreeSelection: id ? MAIN_BRANCH_VALUE : '',
      newWorktreeName: ''
    })
    setEditedFields((current) => ({
      ...current,
      worktree: false,
      newWorktreeName: false
    }))
  }

  const handleWorktreeSelectionChange = (selection: string): void => {
    setWorktreeSelection(selection)
    updateCreateDraft({ worktreeSelection: selection })
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
    if (effectiveWorktreeSelection === MAIN_BRANCH_VALUE) {
      return {
        worktreePath: repository.path,
        worktreeBranch: null,
        pendingWorktreeName: null
      }
    }
    const worktree = worktrees.find((w) => w.path === effectiveWorktreeSelection)
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
    if (!creatingNewWorktree && !effectiveWorktreeSelection) return

    setBusy(true)
    try {
      const target = resolveWorktree()
      if (!target) return
      if (isEdit && task) {
        const updated = await onUpdate({
          task,
          title: title.trim(),
          description,
          repository,
          ...target,
          attachmentStageId,
          attachments
        })
        if (!updated) return
      } else {
        const created = await onCreate({
          intent: createDraft.intent,
          title: title.trim(),
          description,
          repository,
          ...target,
          attachmentStageId,
          attachments
        })
        if (!created) return
      }
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isSaveShortcut =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 's'

      if (!isSaveShortcut || event.defaultPrevented || event.isComposing) return

      event.preventDefault()
      if (event.repeat || readOnly || busy) return

      formRef.current?.requestSubmit()
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [busy, readOnly])

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

  const handleAttach = async (): Promise<void> => {
    setAttaching(true)
    setAttachmentError(null)
    try {
      const result = await pickTaskAttachments({ stageId: attachmentStageId })
      if (!result.ok) {
        setAttachmentError(result.message ?? 'Could not attach the selected files.')
        return
      }
      setAttachments((current) => [
        ...current,
        ...result.attachments.map((attachment) => ({ ...attachment, staged: true }))
      ])
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not attach files.')
    } finally {
      setAttaching(false)
    }
  }

  const attachmentIcon = (mimeType: string): React.JSX.Element => {
    if (mimeType.startsWith('image/')) return <FileImageIcon className="size-4" />
    if (mimeType.includes('spreadsheet') || mimeType === 'text/csv')
      return <FileSpreadsheetIcon className="size-4" />
    if (mimeType.includes('presentation') || mimeType === 'application/vnd.ms-powerpoint')
      return <PresentationIcon className="size-4" />
    if (
      mimeType.startsWith('text/') ||
      mimeType.includes('wordprocessing') ||
      mimeType === 'application/msword'
    )
      return <FileTextIcon className="size-4" />
    return <FileIcon className="size-4" />
  }

  const formatSize = (bytes: number): string =>
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

  return (
    <DialogContent className="grid h-[75vh] max-h-[calc(100vh-2rem)] w-[60vw] max-w-[calc(100vw-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-hidden sm:max-w-[60vw]">
      <DialogHeader className="min-w-0 gap-1">
        <DialogTitle>{isEdit ? 'Task details' : 'Add task'}</DialogTitle>
        <DialogDescription className="break-words">
          {isEdit
            ? readOnly
              ? `Status: ${statusLabel} · read-only. Move the task back to To Do to edit it.`
              : `Status: ${statusLabel}`
            : 'Create a task and choose where it will run.'}
        </DialogDescription>
      </DialogHeader>

      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto pr-1"
      >
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

        <div className="flex min-h-24 min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="task-description" className="text-sm font-medium">
            Description
          </label>
          <Textarea
            id="task-description"
            disabled={readOnly}
            value={description}
            onChange={(e) => setDescriptionValue(e.target.value)}
            placeholder="Add more context for this task…"
            rows={4}
            className="h-full max-w-full min-h-16 min-w-0 flex-1 field-sizing-fixed resize-y [overflow-wrap:anywhere]"
          />
        </div>

        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span id="task-repository-label" className="text-sm font-medium">
              Repository
            </span>
            <Select
              value={effectiveRepositoryId}
              onValueChange={handleRepositoryChange}
              disabled={readOnly}
            >
              <SelectTrigger className="w-full min-w-0" aria-labelledby="task-repository-label">
                <SelectValue placeholder="Select a repository" />
              </SelectTrigger>
              <SelectContent>
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
              value={effectiveWorktreeSelection}
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
              <SelectContent>
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
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Attachments</p>
              <p className="text-muted-foreground text-xs">
                Documents and images are included when Copilot starts.
              </p>
            </div>
            {readOnly ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || attaching}
                onClick={() => void handleAttach()}
              >
                <PaperclipIcon className="size-3.5" />
                {attaching ? 'Attaching...' : 'Attach files'}
              </Button>
            )}
          </div>
          {attachmentError ? (
            <p role="alert" className="text-destructive text-xs">
              {attachmentError}
            </p>
          ) : null}
          {attachments.length > 0 ? (
            <div className="divide-border overflow-hidden rounded-md border">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm"
                >
                  <span className="text-muted-foreground shrink-0">
                    {attachmentIcon(attachment.mimeType)}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatSize(attachment.sizeBytes)}
                  </span>
                  {readOnly ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((item) => item.id !== attachment.id)
                        )
                      }
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No files attached.</p>
          )}
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
  const { open, onOpenChange, task, initialDraft, repositories, onCreate } = props
  const [createDraft, setCreateDraft] = React.useState<TaskCreateDraft>(() =>
    createEmptyTaskDraft(repositories, initialDraft)
  )
  const [createDraftVersion, setCreateDraftVersion] = React.useState(0)
  const initialDraftIdRef = React.useRef(initialDraft?.id ?? null)
  const createDraftRef = React.useRef(createDraft)

  React.useEffect(() => {
    createDraftRef.current = createDraft
  }, [createDraft])

  React.useEffect(() => {
    if (!initialDraft || initialDraft.id === initialDraftIdRef.current) return
    initialDraftIdRef.current = initialDraft.id
    const previousStageId = createDraftRef.current.attachmentStageId
    setCreateDraft(createEmptyTaskDraft(repositories, initialDraft))
    setCreateDraftVersion((current) => current + 1)
    void discardTaskAttachmentStage({ stageId: previousStageId })
  }, [initialDraft, repositories])

  React.useEffect(
    () => () => {
      void discardTaskAttachmentStage({ stageId: createDraftRef.current.attachmentStageId })
    },
    []
  )

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange(nextOpen)
  }

  const handleCreate: TaskDetailDialogProps['onCreate'] = async (input) => {
    const created = await onCreate(input)
    if (!created) return false
    setCreateDraft(createEmptyTaskDraft(repositories))
    setCreateDraftVersion((current) => current + 1)
    return true
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {open ? (
        <TaskDetailForm
          key={task?.id ?? `new:${createDraftVersion}`}
          {...props}
          createDraft={createDraft}
          onCreateDraftChange={setCreateDraft}
          onCreate={handleCreate}
        />
      ) : null}
    </Dialog>
  )
}
