import * as React from 'react'
import { ExternalLinkIcon, SearchIcon } from 'lucide-react'
import { toast } from 'sonner'

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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { TASK_STATUS_LABELS } from '@/contexts/task-board-context'
import { listTaskImports } from '@/lib/task-imports'
import { openExternal } from '@/lib/system'
import type { Repository } from '@shared/repository'
import type { TaskImportItem } from '@shared/task-import'
import type { Task, TaskSourceProvider, TaskStatus } from '@shared/task'
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
  importProvider?: TaskSourceProvider | null
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  onCreate: (input: {
    title: string
    description: string
    repository: Repository
    worktreePath: string
    worktreeBranch: string | null
    pendingWorktreeName: string | null
    sourceProvider?: TaskSourceProvider | null
    sourceId?: string | null
    sourceUrl?: string | null
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

type TaskDraft = {
  title: string
  description: string
  repositoryId: string
  sourceProvider: TaskSourceProvider
  sourceId: string
  sourceUrl: string
}

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
  onCreate,
  onUpdate,
  onDelete,
  initialDraft,
  onBack
}: TaskFormProps & { initialDraft?: TaskDraft; onBack?: () => void }): React.JSX.Element {
  const isEdit = task != null

  const [title, setTitle] = React.useState(task?.title ?? initialDraft?.title ?? '')
  const [description, setDescription] = React.useState(
    task?.description ?? initialDraft?.description ?? ''
  )
  const [repositoryId, setRepositoryId] = React.useState<string>(
    task?.repositoryId ?? initialDraft?.repositoryId ?? repositories[0]?.id ?? ''
  )
  const initialSelection = task?.pendingWorktreeName
    ? NEW_WORKTREE_VALUE
    : task && task.worktreePath === task.repositoryPath
      ? MAIN_BRANCH_VALUE
      : (task?.worktreePath ?? '')
  const [worktreeSelection, setWorktreeSelection] = React.useState<string>(initialSelection)
  const [newWorktreeName, setNewWorktreeName] = React.useState(task?.pendingWorktreeName ?? '')
  const [touched, setTouched] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [portalContainer, setPortalContainer] = React.useState<HTMLDivElement | null>(null)

  const repository = repositories.find((r) => r.id === repositoryId) ?? null
  const worktrees = repository ? (worktreesByRepositoryId[repository.id] ?? []) : []
  const creatingNewWorktree = worktreeSelection === NEW_WORKTREE_VALUE
  /** Once work has started, the task's scope is frozen — the fields become read-only. */
  const readOnly = isEdit && task.status !== 'todo'

  const titleError = touched && !title.trim() ? 'Title is required.' : null
  const worktreeNameError = creatingNewWorktree ? validateWorktreeName(newWorktreeName) : null
  const worktreeError =
    touched && !creatingNewWorktree && !worktreeSelection
      ? 'Select where this task will run.'
      : null

  const handleRepositoryChange = (id: string): void => {
    setRepositoryId(id)
    setWorktreeSelection('')
    setNewWorktreeName('')
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
    setTouched(true)
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
          ...target,
          sourceProvider: initialDraft?.sourceProvider,
          sourceId: initialDraft?.sourceId,
          sourceUrl: initialDraft?.sourceUrl
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
  const sourceProvider = task?.sourceProvider ?? initialDraft?.sourceProvider ?? null
  const sourceId = task?.sourceId ?? initialDraft?.sourceId ?? null
  const sourceUrl = task?.sourceUrl ?? initialDraft?.sourceUrl ?? null
  const handleOpenSource = async (): Promise<void> => {
    if (!sourceUrl) return
    const result = await openExternal(sourceUrl)
    if (!result.ok) toast.error(result.error || 'Could not open the task source.')
  }

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
            : initialDraft
              ? 'Review the imported details and choose where this task will run.'
              : 'Create a task and choose where it will run.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
        {sourceProvider && sourceId ? (
          <div className="bg-muted/50 flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">
                {sourceProvider === 'ado' ? 'Azure DevOps task' : 'GitHub issue'}
              </p>
              <p className="text-muted-foreground truncate text-xs">{sourceId}</p>
            </div>
            {sourceUrl ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void handleOpenSource()}
              >
                <ExternalLinkIcon />
                Open source
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="task-title" className="text-sm font-medium">
            Title
          </label>
          <Input
            id="task-title"
            autoFocus
            disabled={readOnly}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="Fix the login bug"
            aria-invalid={titleError !== null || undefined}
          />
          {titleError ? <p className="text-destructive text-xs">{titleError}</p> : null}
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
            onValueChange={setWorktreeSelection}
            disabled={readOnly || !repository}
          >
            <SelectTrigger className="w-full min-w-0" aria-labelledby="task-worktree-label">
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
          {worktreeError ? <p className="text-destructive text-xs">{worktreeError}</p> : null}
          {creatingNewWorktree ? (
            <div className="flex flex-col gap-1 pt-1">
              <Input
                value={newWorktreeName}
                onChange={(e) => setNewWorktreeName(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="feature-x"
                aria-invalid={(touched && worktreeNameError !== null) || undefined}
              />
              {touched && worktreeNameError ? (
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
            {onBack ? (
              <Button type="button" variant="outline" disabled={busy} onClick={onBack}>
                Back
              </Button>
            ) : null}
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

function TaskImportPicker({
  provider,
  repositories,
  onSelect,
  onCancel
}: {
  provider: TaskSourceProvider
  repositories: Repository[]
  onSelect: (draft: TaskDraft) => void
  onCancel: () => void
}): React.JSX.Element {
  const supported = React.useMemo(
    () => repositories.filter((repository) => repository.remoteKind === provider),
    [provider, repositories]
  )
  const [repositoryId, setRepositoryId] = React.useState(supported[0]?.id ?? '')
  const [items, setItems] = React.useState<TaskImportItem[]>([])
  const [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(supported.length > 0)
  const [error, setError] = React.useState<string | null>(null)
  const [reload, setReload] = React.useState(0)
  const [portalContainer, setPortalContainer] = React.useState<HTMLDivElement | null>(null)
  const repository = supported.find((item) => item.id === repositoryId) ?? null

  React.useEffect(() => {
    if (!repository) return
    let active = true
    listTaskImports(provider, repository.path)
      .then((result) => {
        if (!active) return
        if (result.ok) {
          setItems(result.items)
        } else {
          setItems([])
          setError(result.message ?? 'Could not load items from the provider.')
        }
      })
      .catch((reason: unknown) => {
        if (!active) return
        setItems([])
        setError(reason instanceof Error ? reason.message : 'Could not load provider items.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [provider, repository, reload])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleItems = normalizedQuery
    ? items.filter((item) =>
        `${item.displayId} ${item.title}`.toLocaleLowerCase().includes(normalizedQuery)
      )
    : items
  const providerLabel = provider === 'ado' ? 'Azure DevOps tasks' : 'GitHub issues'
  const handleRepositoryChange = (id: string): void => {
    setRepositoryId(id)
    setItems([])
    setError(null)
    setLoading(true)
  }
  const handleRetry = (): void => {
    setError(null)
    setLoading(true)
    setReload((value) => value + 1)
  }

  return (
    <DialogContent
      ref={setPortalContainer}
      className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-hidden sm:max-w-2xl"
    >
      <DialogHeader>
        <DialogTitle>Add from {provider === 'ado' ? 'Azure DevOps' : 'GitHub'}</DialogTitle>
        <DialogDescription>
          Choose an open item assigned to you, then review it before creating the task.
        </DialogDescription>
      </DialogHeader>

      {supported.length === 0 ? (
        <div className="bg-muted/40 rounded-md border px-4 py-6 text-center">
          <p className="text-sm font-medium">No supported repositories</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Add a {provider === 'ado' ? 'Azure DevOps' : 'GitHub'} repository to DevTrees first.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span id="task-import-repository-label" className="text-sm font-medium">
              Repository
            </span>
            <Select value={repositoryId} onValueChange={handleRepositoryChange}>
              <SelectTrigger className="w-full" aria-labelledby="task-import-repository-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent portalContainer={portalContainer}>
                {supported.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
              placeholder={`Search ${providerLabel.toLocaleLowerCase()}`}
              aria-label={`Search ${providerLabel}`}
            />
          </div>

          <div className="min-h-48 overflow-y-auto rounded-md border p-1">
            {loading ? (
              <div className="flex flex-col gap-2 p-2" aria-label={`Loading ${providerLabel}`}>
                {[0, 1, 2].map((item) => (
                  <div key={item} className="space-y-2 rounded-md p-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="flex min-h-44 flex-col items-center justify-center gap-3 px-4 text-center">
                <div>
                  <p className="text-sm font-medium">Could not load {providerLabel}</p>
                  <p className="text-muted-foreground mt-1 text-sm break-words">{error}</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
                  Retry
                </Button>
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="text-muted-foreground flex min-h-44 items-center justify-center px-4 text-center text-sm">
                {items.length === 0
                  ? `No open ${providerLabel.toLocaleLowerCase()} are assigned to you.`
                  : 'No items match your search.'}
              </div>
            ) : (
              visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 flex-col gap-1 rounded-sm px-3 py-2 text-left outline-none focus-visible:ring-2"
                  onClick={() => {
                    if (!repository) return
                    onSelect({
                      title: item.title,
                      description: item.description,
                      repositoryId: repository.id,
                      sourceProvider: item.provider,
                      sourceId: item.id,
                      sourceUrl: item.url
                    })
                  }}
                >
                  <span className="flex w-full min-w-0 items-baseline gap-2">
                    <span className="text-muted-foreground shrink-0 text-xs">{item.displayId}</span>
                    <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
                  </span>
                  <span className="text-muted-foreground line-clamp-2 text-xs">
                    {item.description || item.state}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function TaskDetailDialog(props: TaskDetailDialogProps): React.JSX.Element {
  const { open, onOpenChange, task, importProvider = null } = props
  const [draft, setDraft] = React.useState<TaskDraft | null>(null)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) setDraft(null)
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {open && importProvider && !draft ? (
        <TaskImportPicker
          key={importProvider}
          provider={importProvider}
          repositories={props.repositories}
          onSelect={setDraft}
          onCancel={() => handleOpenChange(false)}
        />
      ) : open ? (
        <TaskDetailForm
          key={task?.id ?? draft?.sourceId ?? 'new'}
          {...props}
          initialDraft={draft ?? undefined}
          onBack={importProvider ? () => setDraft(null) : undefined}
        />
      ) : null}
    </Dialog>
  )
}
