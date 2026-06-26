import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { AppSidebar, type AppView } from '@/components/app-sidebar'
import { CreateBranchDialog } from '@/components/create-branch-dialog'
import { CreateWorktreeDialog } from '@/components/create-worktree-dialog'
import { DeleteWorktreeDialog } from '@/components/delete-worktree-dialog'
import { DetailToolbar } from '@/components/detail-toolbar'
import { StatusBar } from '@/components/status-bar'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TasksProvider } from '@/contexts/tasks-context'
import { ThemeProvider } from '@/contexts/theme-context'
import { TerminalModeProvider } from '@/contexts/terminal-mode-context'
import { SessionsProvider } from '@/contexts/sessions-context'
import { useRepoStatus } from '@/hooks/use-repo-status'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useAutoUpdate } from '@/hooks/use-auto-update'
import { openExternal } from '@/lib/system'
import { DetailView } from '@/pages/detail-view'
import { HistoryPage } from '@/pages/history'
import { SettingsPage } from '@/pages/settings'
import { SessionsPage, SessionsHeaderControls } from '@/pages/sessions'
import {
  loadViewMode,
  persistViewMode,
  type SessionViewMode
} from '@/pages/sessions-view-mode'
import type { ExistingPullRequest } from '@shared/repo'
import type { Workspace } from '@shared/workspace'
import type { Worktree, WorktreeStatusResult } from '@shared/worktree'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

function AppShell(): React.JSX.Element {
  useAutoUpdate()
  const [view, setView] = useState<AppView>('home')
  const [sessionsViewMode, setSessionsViewMode] = useState<SessionViewMode>(() => loadViewMode())
  const [activeWorktreePath, setActiveWorktreePath] = useState<string | null>(null)
  const [dialogWorkspace, setDialogWorkspace] = useState<Workspace | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    workspaceId: string
    worktree: Worktree
  } | null>(null)
  const [deleteStatus, setDeleteStatus] = useState<WorktreeStatusResult | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [createBranchTarget, setCreateBranchTarget] = useState<{
    workspace: Workspace
    worktree: Worktree
  } | null>(null)
  const [createBranchOpen, setCreateBranchOpen] = useState(false)

  const {
    workspaces,
    worktreesByWorkspaceId,
    activeId: activeWorkspaceId,
    deletingWorktreePaths,
    selectWorkspace,
    addWorkspace,
    removeWorkspace,
    createWorktree,
    createBranchInWorktree,
    deleteWorktree,
    checkWorktreeStatus
  } = useWorkspaces()

  const handleSelectWorkspace = useCallback(
    (id: string): void => {
      selectWorkspace(id)
      setActiveWorktreePath(null)
      setView('workspace')
    },
    [selectWorkspace]
  )

  const handleSelectWorktree = useCallback(
    (workspaceId: string, worktreePath: string): void => {
      selectWorkspace(workspaceId)
      setActiveWorktreePath(worktreePath)
      setView('workspace')
    },
    [selectWorkspace]
  )

  const handleAddWorkspace = useCallback((): void => {
    void addWorkspace()
  }, [addWorkspace])

  const handleRemoveWorkspace = useCallback(
    (id: string): void => {
      void removeWorkspace(id)
    },
    [removeWorkspace]
  )

  const handleCreateWorktreeClick = useCallback((workspace: Workspace): void => {
    setDialogWorkspace(workspace)
    setDialogOpen(true)
  }, [])

  const handleDialogSubmit = useCallback(
    async (name: string): Promise<boolean> => {
      if (!dialogWorkspace) return false
      return createWorktree(dialogWorkspace, name)
    },
    [createWorktree, dialogWorkspace]
  )

  const handleDeleteWorktreeClick = useCallback(
    (workspaceId: string, worktree: Worktree): void => {
      setDeleteTarget({ workspaceId, worktree })
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
    const workspace = workspaces.find((w) => w.id === deleteTarget.workspaceId)
    if (!workspace) return
    const target = deleteTarget.worktree
    if (activeWorktreePath === target.path) {
      setActiveWorktreePath(null)
    }
    void deleteWorktree(workspace, target)
  }, [deleteTarget, deleteWorktree, workspaces, activeWorktreePath])

  const handleDeleteOpenChange = useCallback((open: boolean): void => {
    setDeleteOpen(open)
    if (!open) {
      setDeleteTarget(null)
      setDeleteStatus(null)
    }
  }, [])

  const activeWorkspace =
    view === 'workspace' && activeWorkspaceId
      ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
      : null

  const activeWorktree =
    activeWorkspace && activeWorktreePath
      ? (worktreesByWorkspaceId[activeWorkspace.id]?.find((w) => w.path === activeWorktreePath) ??
        null)
      : null

  const handleCreateBranchClick = useCallback((): void => {
    if (!activeWorkspace || !activeWorktree) return
    setCreateBranchTarget({ workspace: activeWorkspace, worktree: activeWorktree })
    setCreateBranchOpen(true)
  }, [activeWorkspace, activeWorktree])

  const handleCreateBranchSubmit = useCallback(
    async (fullBranchName: string): Promise<boolean> => {
      if (!createBranchTarget) return false
      return createBranchInWorktree(
        createBranchTarget.workspace,
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

  const handleSessionsViewModeChange = useCallback((mode: SessionViewMode): void => {
    setSessionsViewMode(mode)
    persistViewMode(mode)
  }, [])

  const handleNavigateToSessions = useCallback((): void => {
    setView('sessions')
  }, [])

  const headerTitle =
    view === 'settings'
      ? 'Settings'
      : view === 'history'
        ? 'History'
        : view === 'sessions'
          ? 'Sessions'
          : activeWorktree
            ? worktreeLabel(activeWorktree.path)
            : activeWorkspace
              ? activeWorkspace.name
              : 'DevTrees'

  const repo = useRepoStatus(activeWorkspace?.path ?? null, view === 'workspace')

  const [prCache, setPrCache] = useState<Map<string, ExistingPullRequest | null>>(new Map())
  const prGenRef = useRef(0)
  const [creatingPrFolders, setCreatingPrFolders] = useState<Set<string>>(new Set())

  const handleCreatePullRequest = useCallback(async (): Promise<void> => {
    const folderPath = activeWorktree?.path ?? activeWorkspace?.path ?? null
    if (!folderPath) return
    const branchName = activeWorktree
      ? activeWorktree.branch
      : (repo.workspaceCurrentBranch ?? null)
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
          status: 'active'
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
          toast.error('Only Azure DevOps Services cloud remotes are supported.')
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
  }, [activeWorkspace, activeWorktree, repo.workspaceCurrentBranch, repo.defaultBranch])

  const detailFolderPath = activeWorktree?.path ?? activeWorkspace?.path ?? null
  const detailBranch = activeWorktree
    ? activeWorktree.branch
    : (repo.workspaceCurrentBranch ?? null)
  const detailIsDetached = activeWorktree?.isDetached ?? false
  const detailHeadState: 'branch' | 'detached' | undefined = activeWorktree
    ? activeWorktree.isDetached
      ? 'detached'
      : 'branch'
    : detailBranch
      ? 'branch'
      : undefined
  const showDetailToolbar = view === 'workspace' && !!activeWorkspace && !!detailFolderPath

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

  return (
    <TerminalModeProvider>
      <SessionsProvider onNavigateToSessions={handleNavigateToSessions}>
        <SidebarProvider className="flex h-svh flex-col">
        <div className="flex min-h-0 w-full flex-1">
          <AppSidebar
            activeView={view}
            onSelectView={(v) => {
              setView(v)
              setActiveWorktreePath(null)
            }}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            activeWorktreePath={activeWorktreePath}
            worktreesByWorkspaceId={worktreesByWorkspaceId}
            deletingWorktreePaths={deletingWorktreePaths}
            onAddWorkspace={handleAddWorkspace}
            onSelectWorkspace={handleSelectWorkspace}
            onRemoveWorkspace={handleRemoveWorkspace}
            onCreateWorktree={handleCreateWorktreeClick}
            onSelectWorktree={handleSelectWorktree}
            onDeleteWorktree={handleDeleteWorktreeClick}
          />
          <SidebarInset className="min-w-0 overflow-hidden">
            {showDetailToolbar && detailFolderPath ? (
              <DetailToolbar
                title={headerTitle}
                folderPath={detailFolderPath}
                branch={detailBranch}
                isDetached={detailIsDetached}
                headState={detailHeadState}
                isWorktree={!!activeWorktree}
                workspacePath={activeWorkspace?.path ?? null}
                repo={repo}
                existingPullRequest={existingPullRequest}
                onOpenPullRequest={existingPullRequest ? handleOpenPullRequest : undefined}
                branchWebUrl={branchWebUrl}
                onOpenBranch={branchWebUrl ? handleOpenBranch : undefined}
              />
            ) : (
              <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mr-2 h-4" />
                <h2 className="text-sm font-medium">{headerTitle}</h2>
                {view === 'sessions' && (
                  <SessionsHeaderControls
                    viewMode={sessionsViewMode}
                    onChange={handleSessionsViewModeChange}
                  />
                )}
              </header>
            )}
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
              {view === 'settings' ? (
                <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
                  <SettingsPage />
                </div>
              ) : view === 'history' ? (
                <HistoryPage />
              ) : view === 'sessions' ? (
                <SessionsPage viewMode={sessionsViewMode} />
              ) : (
                <DetailView
                  workspace={activeWorkspace}
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
                  isCreatingPullRequest={
                    !!detailFolderPath && creatingPrFolders.has(detailFolderPath)
                  }
                  isPullRequestStatusResolved={isPullRequestStatusResolved}
                  onSelectWorktreePath={
                    activeWorkspace
                      ? (path: string) => handleSelectWorktree(activeWorkspace.id, path)
                      : undefined
                  }
                />
              )}
            </div>
          </SidebarInset>
        </div>
        <StatusBar />
        <CreateWorktreeDialog
          workspace={dialogWorkspace}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleDialogSubmit}
        />
        <DeleteWorktreeDialog
          worktree={deleteTarget?.worktree ?? null}
          workspaceName={
            deleteTarget
              ? (workspaces.find((w) => w.id === deleteTarget.workspaceId)?.name ?? null)
              : null
          }
          status={deleteStatus}
          open={deleteOpen}
          onOpenChange={handleDeleteOpenChange}
          onConfirm={handleDeleteConfirm}
        />
        <CreateBranchDialog
          workspace={createBranchTarget?.workspace ?? null}
          worktree={createBranchTarget?.worktree ?? null}
          open={createBranchOpen}
          onOpenChange={handleCreateBranchOpenChange}
          onSubmit={handleCreateBranchSubmit}
        />
        <Toaster richColors closeButton position="bottom-right" />
        </SidebarProvider>
      </SessionsProvider>
    </TerminalModeProvider>
  )
}

function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <TasksProvider>
        <AppShell />
      </TasksProvider>
    </ThemeProvider>
  )
}

export default App
