import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { AppSidebar, type AppView } from '@/components/app-sidebar'
import { ActivityRail } from '@/components/activity-rail'
import { CreateBranchDialog } from '@/components/create-branch-dialog'
import { CreateWorktreeDialog } from '@/components/create-worktree-dialog'
import { DeleteWorktreeDialog } from '@/components/delete-worktree-dialog'
import { DetailToolbar } from '@/components/detail-toolbar'
import { StatusBar, type StatusBarContext } from '@/components/status-bar'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { PrReviewProvider } from '@/contexts/pr-review-context'
import { TasksProvider } from '@/contexts/tasks-context'
import { TaskBoardProvider, useTaskBoard } from '@/contexts/task-board-context'
import { ThemeProvider } from '@/contexts/theme-context'
import {
  TerminalSessionsProvider,
  useTerminalSessions,
  isTerminalSessionFinished
} from '@/contexts/terminal-sessions-context'
import { DashboardProvider } from '@/contexts/dashboard-context'
import { useRepoStatus } from '@/hooks/use-repo-status'
import { useRepositories } from '@/hooks/use-repositories'
import { useAutoUpdate } from '@/hooks/use-auto-update'
import { openExternal } from '@/lib/system'
import { DetailView } from '@/pages/detail-view'
import { DashboardPage } from '@/pages/dashboard'
import { HistoryPage } from '@/pages/history'
import { ReviewsPage } from '@/pages/reviews'
import { SettingsPage } from '@/pages/settings'
import { SessionsPage, SessionsHeaderControls } from '@/pages/sessions'
import { TasksPage, TasksHeaderControls } from '@/pages/tasks'
import { setTaskCopilotSession } from '@/lib/tasks'
import { listWorktreesForRepository } from '@/lib/worktrees'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { buildTaskCodeReviewPrompt } from '@/lib/copilot-task-review-prompt'
import type { ExistingPullRequest } from '@shared/repo'
import type { Repository } from '@shared/repository'
import type { Task, TaskStatus } from '@shared/task'
import type { Worktree, WorktreeStatusResult } from '@shared/worktree'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

interface TasksPageContainerProps {
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
  createWorktree: (repository: Repository, name: string) => Promise<boolean>
  refreshWorktreesFor: (repositoryId: string) => Promise<void>
  checkWorktreeStatus: (path: string) => Promise<WorktreeStatusResult>
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  activeTask: Task | null
  onOpenTask: (task: Task | null) => void
}

/** Owns the "Start task" action, launching a managed Copilot session for the task. */
function TasksPageContainer({
  repositories,
  worktreesByRepositoryId,
  createWorktree,
  refreshWorktreesFor,
  checkWorktreeStatus,
  dialogOpen,
  onDialogOpenChange,
  activeTask,
  onOpenTask
}: TasksPageContainerProps): React.JSX.Element {
  const { byId: terminalSessionsById } = useTerminalSessions()
  const launchCopilot = useCopilotLauncher()
  const { moveTask, setTaskLocal, updateTask } = useTaskBoard()

  const materializeTaskWorktree = useCallback(
    async (task: Task): Promise<Task | null> => {
      const name = task.pendingWorktreeName
      if (!name) return task

      const repository = repositories.find((r) => r.id === task.repositoryId)
      if (!repository) {
        toast.error('The repository for this task is unavailable.')
        return null
      }

      try {
        let worktree = (await listWorktreesForRepository(repository.path)).find(
          (candidate) => !candidate.isMain && worktreeLabel(candidate.path) === name
        )
        if (!worktree) {
          const created = await createWorktree(repository, name)
          if (!created) return null
          worktree = (await listWorktreesForRepository(repository.path)).find(
            (candidate) => !candidate.isMain && worktreeLabel(candidate.path) === name
          )
        }
        if (!worktree) {
          toast.error('The new worktree was created but could not be resolved.')
          return null
        }

        const updated = await updateTask({
          id: task.id,
          title: task.title,
          description: task.description,
          repositoryId: task.repositoryId,
          repositoryName: task.repositoryName,
          repositoryPath: task.repositoryPath,
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          pendingWorktreeName: null
        })
        if (!updated) return null
        await refreshWorktreesFor(repository.id)
        return updated
      } catch (error) {
        console.error('[tasks] failed to prepare planned worktree:', error)
        toast.error(
          error instanceof Error ? error.message : 'Could not prepare the worktree for this task.'
        )
        return null
      }
    },
    [createWorktree, refreshWorktreesFor, repositories, updateTask]
  )

  const handleMoveTask = useCallback(
    async (task: Task, status: TaskStatus, beforeId?: string | null): Promise<void> => {
      const resolved = status === 'in_progress' ? await materializeTaskWorktree(task) : task
      if (!resolved) return
      await moveTask(resolved.id, status, beforeId)
    },
    [materializeTaskWorktree, moveTask]
  )

  const handleStartTask = useCallback(
    async (task: Task): Promise<void> => {
      const resolvedTask = await materializeTaskWorktree(task)
      if (!resolvedTask) return

      if (resolvedTask.status === 'todo') {
        await moveTask(resolvedTask.id, 'in_progress')
      }

      // Already running? Don't spawn a second terminal for the same task.
      const linkedId = resolvedTask.copilotSessionId
      const linkedTerminal = linkedId ? terminalSessionsById[linkedId] : undefined
      if (linkedTerminal != null && !isTerminalSessionFinished(linkedTerminal.status)) {
        toast.info('A Copilot session for this task is already running.')
        return
      }

      // The worktree may have been deleted outside the app since the task was created.
      const worktreePath = resolvedTask.worktreePath
      const repository = repositories.find((r) => r.id === resolvedTask.repositoryId) ?? null
      try {
        const status = await checkWorktreeStatus(worktreePath)
        const missing =
          (status.ok && status.folderMissing) || (!status.ok && status.error === 'not-found')
        if (missing) {
          if (!repository) {
            toast.error('The worktree for this task is missing and its repository is unavailable.')
            return
          }
          const recreated = await createWorktree(repository, worktreeLabel(worktreePath))
          const after = recreated ? await checkWorktreeStatus(worktreePath) : null
          const stillMissing =
            !after ||
            (after.ok && after.folderMissing) ||
            (!after.ok && after.error === 'not-found')
          if (stillMissing) {
            toast.error('Could not recreate the missing worktree for this task.')
            return
          }
        }
      } catch (error) {
        console.error('[tasks] worktree status check failed:', error)
      }

      const prompt = [resolvedTask.title.trim(), resolvedTask.description.trim()]
        .filter(Boolean)
        .join('\n\n')
      const result = await launchCopilot({
        folderPath: worktreePath,
        prompt,
        label: resolvedTask.title.trim() || resolvedTask.repositoryName,
        branch: resolvedTask.worktreeBranch ?? undefined,
        repository: resolvedTask.repositoryName,
        taskId: resolvedTask.id
      })

      if (!result.ok) {
        toast.error(result.error || 'Could not start a Copilot session for this task.')
        return
      }

      // Link the mirrored CLI session to the task, so a second Start reuses it.
      const sessionId = result.sessionId
      setTaskLocal({ ...resolvedTask, copilotSessionId: sessionId })
      try {
        const res = await setTaskCopilotSession({
          id: resolvedTask.id,
          copilotSessionId: sessionId
        })
        if (res.ok) setTaskLocal(res.task)
        else toast.error(res.message ?? 'Could not link the session to this task.')
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Could not link the session to this task.'
        )
      }

      if (resolvedTask.status === 'todo') await moveTask(resolvedTask.id, 'in_progress')

      toast.success(`Copilot started for "${resolvedTask.title}".`)
    },
    [
      checkWorktreeStatus,
      createWorktree,
      launchCopilot,
      moveTask,
      materializeTaskWorktree,
      repositories,
      setTaskLocal,
      terminalSessionsById
    ]
  )

  const canReviewTask = useCallback(
    (task: Task): boolean => {
      if (task.status !== 'in_progress') return false
      const linkedId = task.copilotSessionId
      if (!linkedId) return false
      const session = terminalSessionsById[linkedId]
      if (!session) return false
      // "Work is done" = the session finished, or its turn ended and it is idle at the prompt.
      return isTerminalSessionFinished(session.status) || session.status === 'idle'
    },
    [terminalSessionsById]
  )

  const handleReviewTask = useCallback(
    async (task: Task): Promise<void> => {
      const worktreePath = task.worktreePath
      const repository = repositories.find((r) => r.id === task.repositoryId) ?? null
      try {
        const status = await checkWorktreeStatus(worktreePath)
        const missing =
          (status.ok && status.folderMissing) || (!status.ok && status.error === 'not-found')
        if (missing) {
          if (!repository) {
            toast.error('The worktree for this task is missing and its repository is unavailable.')
            return
          }
          const recreated = await createWorktree(repository, worktreeLabel(worktreePath))
          const after = recreated ? await checkWorktreeStatus(worktreePath) : null
          const stillMissing =
            !after ||
            (after.ok && after.folderMissing) ||
            (!after.ok && after.error === 'not-found')
          if (stillMissing) {
            toast.error('Could not find the worktree to review for this task.')
            return
          }
        }
      } catch (error) {
        console.error('[tasks] worktree status check failed:', error)
      }

      const prompt = buildTaskCodeReviewPrompt({
        folderPath: worktreePath,
        taskTitle: task.title,
        taskDescription: task.description,
        repositoryName: task.repositoryName,
        branch: task.worktreeBranch
      })

      const result = await launchCopilot({
        folderPath: worktreePath,
        prompt,
        label: `Review: ${task.title.trim() || task.repositoryName}`,
        branch: task.worktreeBranch ?? undefined,
        repository: task.repositoryName,
        taskId: task.id
      })

      if (!result.ok) {
        toast.error(result.error || 'Could not start the code review for this task.')
        return
      }

      // The review session becomes the task's current session, so the card tracks it.
      const sessionId = result.sessionId
      setTaskLocal({ ...task, copilotSessionId: sessionId })
      try {
        const res = await setTaskCopilotSession({ id: task.id, copilotSessionId: sessionId })
        if (res.ok) setTaskLocal(res.task)
        else toast.error(res.message ?? 'Could not link the review session to this task.')
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Could not link the review session to this task.'
        )
      }

      await moveTask(task.id, 'review')
      toast.success(`Code review started for "${task.title}" in a terminal.`)
    },
    [checkWorktreeStatus, createWorktree, launchCopilot, moveTask, repositories, setTaskLocal]
  )

  return (
    <TasksPage
      repositories={repositories}
      worktreesByRepositoryId={worktreesByRepositoryId}
      onStartTask={handleStartTask}
      onMoveTask={handleMoveTask}
      onReviewTask={handleReviewTask}
      canReviewTask={canReviewTask}
      dialogOpen={dialogOpen}
      onDialogOpenChange={onDialogOpenChange}
      activeTask={activeTask}
      onOpenTask={onOpenTask}
    />
  )
}

function AppShell(): React.JSX.Element {
  useAutoUpdate()
  const [view, setView] = useState<AppView>('dashboard')
  const [activeWorktreePath, setActiveWorktreePath] = useState<string | null>(null)
  const [reviewsRepositoryId, setReviewsRepositoryId] = useState<string | null>(null)
  const [dialogRepository, setDialogRepository] = useState<Repository | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    repositoryId: string
    worktree: Worktree
  } | null>(null)
  const [deleteStatus, setDeleteStatus] = useState<WorktreeStatusResult | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [createBranchTarget, setCreateBranchTarget] = useState<{
    repository: Repository
    worktree: Worktree
  } | null>(null)
  const [createBranchOpen, setCreateBranchOpen] = useState(false)

  const {
    repositories,
    worktreesByRepositoryId,
    activeId: activeRepositoryId,
    deletingWorktreePaths,
    selectRepository,
    addRepository,
    removeRepository,
    reorderRepositories,
    createWorktree,
    createBranchInWorktree,
    deleteWorktree,
    checkWorktreeStatus,
    refreshWorktreesFor
  } = useRepositories()

  const handleSelectRepository = useCallback(
    (id: string): void => {
      selectRepository(id)
      setActiveWorktreePath(null)
      setView('repositories')
    },
    [selectRepository]
  )

  const handleSelectWorktree = useCallback(
    (repositoryId: string, worktreePath: string): void => {
      selectRepository(repositoryId)
      setActiveWorktreePath(worktreePath)
      setView('repositories')
    },
    [selectRepository]
  )

  const handleSelectReviewsRepository = useCallback((id: string): void => {
    setReviewsRepositoryId(id)
    setView('reviews')
  }, [])

  const handleAddRepository = useCallback((): void => {
    void addRepository()
  }, [addRepository])

  const handleRemoveRepository = useCallback(
    (id: string): void => {
      void removeRepository(id)
    },
    [removeRepository]
  )

  const handleCreateWorktreeClick = useCallback((repository: Repository): void => {
    setDialogRepository(repository)
    setDialogOpen(true)
  }, [])

  const handleDialogSubmit = useCallback(
    async (name: string): Promise<boolean> => {
      if (!dialogRepository) return false
      return createWorktree(dialogRepository, name)
    },
    [createWorktree, dialogRepository]
  )

  const handleDeleteWorktreeClick = useCallback(
    (repositoryId: string, worktree: Worktree): void => {
      setDeleteTarget({ repositoryId, worktree })
      setDeleteStatus(null)
      setDeleteOpen(true)
      const requestedPath = worktree.path
      void checkWorktreeStatus(requestedPath).then((result) => {
        setDeleteTarget((current) => {
          if (current && current.worktree.path === requestedPath) {
            setDeleteStatus(result)
          }
          return current
        })
      })
    },
    [checkWorktreeStatus]
  )

  const handleDeleteConfirm = useCallback((): void => {
    if (!deleteTarget) return
    const repository = repositories.find((w) => w.id === deleteTarget.repositoryId)
    if (!repository) return
    const target = deleteTarget.worktree
    if (activeWorktreePath === target.path) {
      setActiveWorktreePath(null)
    }
    void deleteWorktree(repository, target)
  }, [deleteTarget, deleteWorktree, repositories, activeWorktreePath])

  const handleDeleteOpenChange = useCallback((open: boolean): void => {
    setDeleteOpen(open)
    if (!open) {
      setDeleteTarget(null)
      setDeleteStatus(null)
    }
  }, [])

  const activeRepository =
    view === 'repositories' && activeRepositoryId
      ? (repositories.find((w) => w.id === activeRepositoryId) ?? null)
      : null

  const reviewsRepository =
    view === 'reviews' && reviewsRepositoryId
      ? (repositories.find((repository) => repository.id === reviewsRepositoryId) ?? null)
      : null

  const activeWorktree =
    activeRepository && activeWorktreePath
      ? (worktreesByRepositoryId[activeRepository.id]?.find((w) => w.path === activeWorktreePath) ??
        null)
      : null

  const handleCreateBranchClick = useCallback((): void => {
    if (!activeRepository || !activeWorktree) return
    setCreateBranchTarget({ repository: activeRepository, worktree: activeWorktree })
    setCreateBranchOpen(true)
  }, [activeRepository, activeWorktree])

  const handleCreateBranchSubmit = useCallback(
    async (fullBranchName: string): Promise<boolean> => {
      if (!createBranchTarget) return false
      return createBranchInWorktree(
        createBranchTarget.repository,
        createBranchTarget.worktree,
        fullBranchName
      )
    },
    [createBranchInWorktree, createBranchTarget]
  )

  const handleCreateBranchOpenChange = useCallback((open: boolean): void => {
    setCreateBranchOpen(open)
    if (!open) setCreateBranchTarget(null)
  }, [])

  const handleNavigateToSessions = useCallback((): void => {
    setView('sessions')
  }, [])

  const { tasks: allTasks } = useTaskBoard()
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [activeTaskForDialog, setActiveTaskForDialog] = useState<Task | null>(null)

  const handleOpenAddTaskDialog = useCallback((): void => {
    setActiveTaskForDialog(null)
    setTaskDialogOpen(true)
  }, [])

  const handleOpenTaskDialog = useCallback((task: Task | null): void => {
    setActiveTaskForDialog(task)
    setTaskDialogOpen(true)
  }, [])

  const headerTitle =
    view === 'dashboard'
      ? 'Dashboard'
      : view === 'tasks'
        ? 'Tasks'
        : view === 'reviews'
          ? 'Reviews'
          : view === 'settings'
            ? 'Settings'
            : view === 'history'
              ? 'History'
              : view === 'sessions'
                ? 'Sessions'
                : activeWorktree
                  ? worktreeLabel(activeWorktree.path)
                  : activeRepository
                    ? activeRepository.name
                    : view === 'repositories'
                      ? 'Repositories'
                      : 'DevTrees'

  const repo = useRepoStatus(activeRepository?.path ?? null, view === 'repositories')

  const [prCache, setPrCache] = useState<Map<string, ExistingPullRequest | null>>(new Map())
  const prGenRef = useRef(0)
  const [creatingPrFolders, setCreatingPrFolders] = useState<Set<string>>(new Set())

  const handleCreatePullRequest = useCallback(async (): Promise<void> => {
    const folderPath = activeWorktree?.path ?? activeRepository?.path ?? null
    if (!folderPath) return
    const branchName = activeWorktree
      ? activeWorktree.branch
      : (repo.repositoryCurrentBranch ?? null)
    setCreatingPrFolders((prev) => {
      if (prev.has(folderPath)) return prev
      const next = new Set(prev)
      next.add(folderPath)
      return next
    })
    try {
      const result = await window.api.repo.openPullRequest({ folderPath })
      if (result.ok) {
        toast.success(`Draft PR #${result.pullRequestId} created.`)
        const optimistic: ExistingPullRequest = {
          id: result.pullRequestId,
          title: branchName ?? `PR #${result.pullRequestId}`,
          webUrl: result.webUrl,
          status: 'active',
          mergeStatus: 'notSet'
        }
        if (branchName && repo.defaultBranch) {
          const key = `${folderPath}::${branchName}::${repo.defaultBranch}`
          setPrCache((prev) => new Map(prev).set(key, optimistic))
        }
        return
      }

      const fallback = (msg: string): string => result.message?.trim() || msg
      switch (result.code) {
        case 'detached':
          toast.error('HEAD is detached — switch to a branch first.')
          return
        case 'same-as-default':
          toast.error("You're already on the default branch.")
          return
        case 'uncommitted':
          toast.error('Commit your local changes first, then create the PR.')
          return
        case 'unpushed':
          toast.error('Push your committed changes first, then create the PR.')
          return
        case 'no-remote-branch':
          toast.error(
            branchName
              ? `Branch "${branchName}" is not on origin yet — push it first.`
              : 'This branch is not on origin yet — push it first.'
          )
          return
        case 'fetch-failed':
          toast.error(`Could not reach origin: ${fallback('git fetch failed')}`)
          return
        case 'no-origin':
          toast.error('This repo has no "origin" remote configured.')
          return
        case 'unsupported-remote':
          toast.error('Only GitHub and Azure DevOps Services cloud remotes are supported.')
          return
        case 'no-default-branch':
          toast.error('Could not determine the default branch.')
          return
        case 'az-not-installed':
          toast.error(
            'Azure CLI (az) is not installed or not on PATH. Install from https://aka.ms/azure-cli.'
          )
          return
        case 'az-extension-missing':
          toast.error(
            'Azure DevOps CLI extension is missing. Run: az extension add --name azure-devops'
          )
          return
        case 'az-not-logged-in':
          toast.error('You are not signed in to Azure. Run: az login')
          return
        case 'az-pr-exists':
          toast.error('A pull request already exists for this branch.')
          return
        case 'az-failed':
          toast.error(`Azure CLI failed: ${fallback('az repos pr create failed.')}`)
          return
        case 'gh-not-installed':
          toast.error(
            'GitHub CLI (gh) is not installed or not on PATH. Install from https://cli.github.com.'
          )
          return
        case 'gh-not-logged-in':
          toast.error('You are not signed in to GitHub. Run: gh auth login')
          return
        case 'gh-pr-exists':
          toast.error('A pull request already exists for this branch.')
          return
        case 'gh-failed':
          toast.error(`GitHub CLI failed: ${fallback('gh pr create failed.')}`)
          return
        case 'git-failed':
        default:
          toast.error(fallback('Git command failed.'))
      }
    } finally {
      setCreatingPrFolders((prev) => {
        if (!prev.has(folderPath)) return prev
        const next = new Set(prev)
        next.delete(folderPath)
        return next
      })
    }
  }, [activeRepository, activeWorktree, repo.repositoryCurrentBranch, repo.defaultBranch])

  const detailFolderPath = activeWorktree?.path ?? activeRepository?.path ?? null
  const detailBranch = activeWorktree
    ? activeWorktree.branch
    : (repo.repositoryCurrentBranch ?? null)
  const detailIsDetached = activeWorktree?.isDetached ?? false
  const detailHeadState: 'branch' | 'detached' | undefined = activeWorktree
    ? activeWorktree.isDetached
      ? 'detached'
      : 'branch'
    : detailBranch
      ? 'branch'
      : undefined
  const showDetailToolbar = view === 'repositories' && !!activeRepository && !!detailFolderPath

  const prCacheKey = useMemo(() => {
    if (
      detailHeadState !== 'branch' ||
      !detailFolderPath ||
      !detailBranch ||
      !repo.defaultBranch ||
      detailBranch === repo.defaultBranch
    ) {
      return null
    }
    return `${detailFolderPath}::${detailBranch}::${repo.defaultBranch}`
  }, [detailFolderPath, detailBranch, detailHeadState, repo.defaultBranch])

  const existingPullRequest = useMemo<ExistingPullRequest | null>(() => {
    if (!prCacheKey) return null
    return prCache.get(prCacheKey) ?? null
  }, [prCacheKey, prCache])

  // The PR status is "resolved" once the lookup has populated the cache. When a
  // lookup applies (prCacheKey set) but the cache is empty, the status is still
  // being determined and the PR action buttons should stay disabled.
  const isPullRequestStatusResolved = useMemo<boolean>(() => {
    if (!prCacheKey) return true
    return prCache.has(prCacheKey)
  }, [prCacheKey, prCache])

  useEffect(() => {
    if (!prCacheKey || !detailFolderPath) return
    if (prCache.has(prCacheKey)) return
    const folderPath = detailFolderPath
    const cacheKey = prCacheKey
    const gen = ++prGenRef.current
    let cancelled = false

    void (async () => {
      try {
        const result = await window.api.repo.findActivePullRequest({ folderPath })
        if (cancelled || gen !== prGenRef.current) return
        setPrCache((prev) => new Map(prev).set(cacheKey, result.ok ? result.pullRequest : null))
      } catch {
        // Silent: button stays in Create PR mode; user click surfaces actionable errors.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [prCacheKey, detailFolderPath, prCache])

  const handleOpenPullRequest = useCallback(async (): Promise<void> => {
    if (!existingPullRequest) return
    const result = await openExternal(existingPullRequest.webUrl)
    if (!result.ok) toast.error(`Failed to open PR in browser: ${result.error}`)
  }, [existingPullRequest])

  // Refetch the active PR (in place) so its mergeStatus reflects the remote's async
  // re-evaluation. Used when the Pull Request tab becomes active.
  const handleRefreshPullRequest = useCallback((): void => {
    if (!prCacheKey || !detailFolderPath) return
    const folderPath = detailFolderPath
    const cacheKey = prCacheKey
    const gen = ++prGenRef.current
    void (async () => {
      try {
        const result = await window.api.repo.findActivePullRequest({ folderPath })
        if (gen !== prGenRef.current) return
        setPrCache((prev) => new Map(prev).set(cacheKey, result.ok ? result.pullRequest : null))
      } catch {
        // Silent: keep the previously cached value.
      }
    })()
  }, [prCacheKey, detailFolderPath])

  const [branchUrlCache, setBranchUrlCache] = useState<Map<string, string | null>>(new Map())
  const branchUrlGenRef = useRef(0)

  const branchUrlCacheKey = useMemo(() => {
    if (!detailFolderPath || !detailBranch || detailHeadState !== 'branch') return null
    return `${detailFolderPath}::${detailBranch}`
  }, [detailFolderPath, detailBranch, detailHeadState])

  const branchWebUrl = useMemo<string | null>(() => {
    if (!branchUrlCacheKey) return null
    return branchUrlCache.get(branchUrlCacheKey) ?? null
  }, [branchUrlCacheKey, branchUrlCache])

  useEffect(() => {
    if (!branchUrlCacheKey || !detailFolderPath || !detailBranch) return
    if (branchUrlCache.has(branchUrlCacheKey)) return
    const folderPath = detailFolderPath
    const branch = detailBranch
    const cacheKey = branchUrlCacheKey
    const gen = ++branchUrlGenRef.current
    let cancelled = false

    void (async () => {
      try {
        const result = await window.api.repo.branchWebUrl({ folderPath, branch })
        if (cancelled || gen !== branchUrlGenRef.current) return
        setBranchUrlCache((prev) => new Map(prev).set(cacheKey, result.webUrl ?? null))
      } catch {
        // Silent: branch label simply remains non-clickable.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [branchUrlCacheKey, detailFolderPath, detailBranch, branchUrlCache])

  const handleOpenBranch = useCallback(async (): Promise<void> => {
    if (!branchWebUrl) return
    const result = await openExternal(branchWebUrl)
    if (!result.ok) toast.error(`Failed to open branch in browser: ${result.error}`)
  }, [branchWebUrl])

  const statusContext = useMemo<StatusBarContext | null>(() => {
    if (view !== 'repositories' || !activeRepository || !detailFolderPath) return null
    return {
      folderLabel: activeWorktree ? worktreeLabel(activeWorktree.path) : activeRepository.name,
      folderPath: detailFolderPath,
      branch: detailBranch,
      isDetached: detailIsDetached,
      isWorktree: !!activeWorktree,
      ahead: repo.status?.ahead ?? 0,
      behind: repo.status?.behind ?? 0,
      hasRemote: repo.status?.hasRemote ?? false,
      syncing: repo.isFetching || repo.isPulling,
      pr: existingPullRequest
        ? { id: existingPullRequest.id, title: existingPullRequest.title }
        : null
    }
  }, [
    view,
    activeRepository,
    activeWorktree,
    detailFolderPath,
    detailBranch,
    detailIsDetached,
    repo.status,
    repo.isFetching,
    repo.isPulling,
    existingPullRequest
  ])

  return (
    <TerminalSessionsProvider onNavigateToSessions={handleNavigateToSessions}>
      <DashboardProvider repositories={repositories}>
        <SidebarProvider className="flex h-svh flex-col">
          <div className="flex min-h-0 w-full flex-1">
            <ActivityRail activeView={view} onSelect={setView} />
            {view === 'repositories' || view === 'reviews' || view === 'sessions' ? (
              <AppSidebar
                activeView={view}
                onSelectView={setView}
                repositories={repositories}
                activeRepositoryId={view === 'reviews' ? reviewsRepositoryId : activeRepositoryId}
                activeWorktreePath={view === 'repositories' ? activeWorktreePath : null}
                worktreesByRepositoryId={worktreesByRepositoryId}
                deletingWorktreePaths={deletingWorktreePaths}
                onAddRepository={handleAddRepository}
                onSelectRepository={
                  view === 'reviews' ? handleSelectReviewsRepository : handleSelectRepository
                }
                onRemoveRepository={handleRemoveRepository}
                onReorderRepositories={reorderRepositories}
                onCreateWorktree={handleCreateWorktreeClick}
                onSelectWorktree={handleSelectWorktree}
                onDeleteWorktree={handleDeleteWorktreeClick}
              />
            ) : null}
            <SidebarInset className="min-w-0 overflow-hidden">
              {showDetailToolbar && detailFolderPath ? (
                <DetailToolbar
                  title={headerTitle}
                  folderPath={detailFolderPath}
                  branch={detailBranch}
                  isDetached={detailIsDetached}
                  headState={detailHeadState}
                  isWorktree={!!activeWorktree}
                  repositoryPath={activeRepository?.path ?? null}
                  repo={repo}
                  existingPullRequest={existingPullRequest}
                  onOpenPullRequest={existingPullRequest ? handleOpenPullRequest : undefined}
                  branchWebUrl={branchWebUrl}
                  onOpenBranch={branchWebUrl ? handleOpenBranch : undefined}
                />
              ) : (
                <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                  {view === 'repositories' || view === 'reviews' || view === 'sessions' ? (
                    <>
                      <SidebarTrigger className="-ml-1" />
                      <Separator orientation="vertical" className="mr-2 h-4" />
                    </>
                  ) : null}
                  <h2 className="text-sm font-medium">{headerTitle}</h2>
                  {view === 'sessions' && <SessionsHeaderControls />}
                  {view === 'tasks' && (
                    <TasksHeaderControls
                      taskCount={allTasks.length}
                      onAddTask={handleOpenAddTaskDialog}
                    />
                  )}
                </header>
              )}
              <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
                {view === 'dashboard' ? (
                  <DashboardPage
                    repositories={repositories}
                    onNavigateToSessions={handleNavigateToSessions}
                    onNavigateToReviews={() => setView('reviews')}
                  />
                ) : view === 'tasks' ? (
                  <TasksPageContainer
                    repositories={repositories}
                    worktreesByRepositoryId={worktreesByRepositoryId}
                    createWorktree={createWorktree}
                    refreshWorktreesFor={refreshWorktreesFor}
                    checkWorktreeStatus={checkWorktreeStatus}
                    dialogOpen={taskDialogOpen}
                    onDialogOpenChange={setTaskDialogOpen}
                    activeTask={activeTaskForDialog}
                    onOpenTask={handleOpenTaskDialog}
                  />
                ) : view === 'settings' ? (
                  <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
                    <SettingsPage />
                  </div>
                ) : view === 'history' ? (
                  <HistoryPage />
                ) : view === 'reviews' ? (
                  <ReviewsPage repository={reviewsRepository} />
                ) : view === 'sessions' ? (
                  <SessionsPage />
                ) : (
                  <DetailView
                    repository={activeRepository}
                    worktree={activeWorktree}
                    folderPath={detailFolderPath}
                    branch={detailBranch}
                    defaultBranch={repo.defaultBranch ?? null}
                    headState={detailHeadState}
                    existingPullRequest={existingPullRequest}
                    onCreateBranch={
                      activeWorktree && activeWorktree.isDetached
                        ? handleCreateBranchClick
                        : undefined
                    }
                    onCreatePullRequest={
                      detailHeadState === 'branch' &&
                      detailFolderPath &&
                      detailBranch &&
                      repo.defaultBranch &&
                      detailBranch !== repo.defaultBranch &&
                      !existingPullRequest
                        ? handleCreatePullRequest
                        : undefined
                    }
                    onOpenPullRequest={existingPullRequest ? handleOpenPullRequest : undefined}
                    onPullRequestTabActive={
                      existingPullRequest ? handleRefreshPullRequest : undefined
                    }
                    isCreatingPullRequest={
                      !!detailFolderPath && creatingPrFolders.has(detailFolderPath)
                    }
                    isPullRequestStatusResolved={isPullRequestStatusResolved}
                    onSelectWorktreePath={
                      activeRepository
                        ? (path: string) => handleSelectWorktree(activeRepository.id, path)
                        : undefined
                    }
                  />
                )}
              </div>
            </SidebarInset>
          </div>
          <StatusBar context={statusContext} />
          <CreateWorktreeDialog
            repository={dialogRepository}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={handleDialogSubmit}
          />
          <DeleteWorktreeDialog
            worktree={deleteTarget?.worktree ?? null}
            repositoryName={
              deleteTarget
                ? (repositories.find((w) => w.id === deleteTarget.repositoryId)?.name ?? null)
                : null
            }
            status={deleteStatus}
            open={deleteOpen}
            onOpenChange={handleDeleteOpenChange}
            onConfirm={handleDeleteConfirm}
          />
          <CreateBranchDialog
            repository={createBranchTarget?.repository ?? null}
            worktree={createBranchTarget?.worktree ?? null}
            open={createBranchOpen}
            onOpenChange={handleCreateBranchOpenChange}
            onSubmit={handleCreateBranchSubmit}
          />
          <Toaster richColors closeButton position="bottom-right" />
        </SidebarProvider>
      </DashboardProvider>
    </TerminalSessionsProvider>
  )
}

function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <TasksProvider>
        <PrReviewProvider>
          <TaskBoardProvider>
            <AppShell />
          </TaskBoardProvider>
        </PrReviewProvider>
      </TasksProvider>
    </ThemeProvider>
  )
}

export default App
