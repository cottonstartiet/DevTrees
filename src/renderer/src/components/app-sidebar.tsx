import * as React from 'react'
import {
  ChevronRight as ChevronRightIcon,
  CircleDot as CircleDotIcon,
  Folder as FolderIcon,
  GitBranch as GitBranchIcon,
  GitBranchPlus as GitBranchPlusIcon,
  GitPullRequest as GitPullRequestIcon,
  GripVertical as GripVerticalIcon,
  History as HistoryIcon,
  Loader2 as Loader2Icon,
  MoreHorizontal as MoreHorizontalIcon,
  Plus as PlusIcon,
  Settings as SettingsIcon,
  Sparkles as SparklesIcon,
  SquareTerminal as SquareTerminalIcon,
  Trash2 as Trash2Icon,
  X as XIcon
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type { Repository, RepositoryRemoteKind } from '@shared/repository'
import type { Worktree } from '@shared/worktree'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { openInWindowsTerminal } from '@/lib/system'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { useSessions } from '@/contexts/sessions-context'
import { useTerminalMode } from '@/contexts/terminal-mode-context'
import { sessionPrimaryLabel, sessionRepoLabel } from '@/lib/session-label'

function GithubIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function AzureDevOpsIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z" />
    </svg>
  )
}

function repositoryIcon(remoteKind: RepositoryRemoteKind): React.JSX.Element {
  if (remoteKind === 'github') return <GithubIcon className="size-4" />
  if (remoteKind === 'ado') return <AzureDevOpsIcon className="size-4" />
  return <FolderIcon />
}

export type AppView = 'home' | 'settings' | 'repository' | 'history' | 'sessions' | 'reviews'

interface AppSidebarProps {
  activeView: AppView
  onSelectView: (view: AppView) => void
  repositories: Repository[]
  activeRepositoryId: string | null
  activeWorktreePath: string | null
  worktreesByRepositoryId: Record<string, Worktree[]>
  deletingWorktreePaths: ReadonlySet<string>
  onAddRepository: () => void
  onSelectRepository: (id: string) => void
  onRemoveRepository: (id: string) => void
  onReorderRepositories: (orderedIds: string[]) => void
  onCreateWorktree: (repository: Repository) => void
  onSelectWorktree: (repositoryId: string, worktreePath: string) => void
  onDeleteWorktree: (repositoryId: string, worktree: Worktree) => void
}

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

function worktreeSubtitle(wt: Worktree): string | null {
  if (wt.isDetached) return null
  if (wt.branch && wt.branch.length > 0) return wt.branch
  return null
}

interface SortableRepositoryItemProps {
  ws: Repository
  worktrees: Worktree[]
  activeView: AppView
  activeRepositoryId: string | null
  activeWorktreePath: string | null
  deletingWorktreePaths: ReadonlySet<string>
  onSelectRepository: (id: string) => void
  onCreateWorktree: (repository: Repository) => void
  onRemoveRepository: (id: string) => void
  onSelectWorktree: (repositoryId: string, worktreePath: string) => void
  onDeleteWorktree: (repositoryId: string, worktree: Worktree) => void
  onOpenTerminal: (wt: Worktree) => void
  onStartCopilotSession: (wt: Worktree, repository?: string) => void
}

function SortableRepositoryItem({
  ws,
  worktrees,
  activeView,
  activeRepositoryId,
  activeWorktreePath,
  deletingWorktreePaths,
  onSelectRepository,
  onCreateWorktree,
  onRemoveRepository,
  onSelectWorktree,
  onDeleteWorktree,
  onOpenTerminal,
  onStartCopilotSession
}: SortableRepositoryItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ws.id
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  const isWsRowActive =
    activeView === 'repository' && activeRepositoryId === ws.id && !activeWorktreePath

  return (
    <SidebarMenuItem ref={setNodeRef} style={style} className={cn(isDragging && 'z-50 opacity-80')}>
      <Collapsible defaultOpen className="group/collapsible">
        <SidebarMenuAction
          {...attributes}
          {...listeners}
          showOnHover
          title="Drag to reorder"
          aria-label="Drag to reorder repository"
          className="right-[3.25rem] cursor-grab touch-none active:cursor-grabbing group-data-[collapsible=icon]:hidden"
        >
          <GripVerticalIcon />
          <span className="sr-only">Drag to reorder</span>
        </SidebarMenuAction>

        {worktrees.length > 0 ? (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              title="Toggle worktrees"
              aria-label="Toggle worktrees"
              className="absolute top-1.5 left-1 z-10 flex size-5 items-center justify-center rounded-md text-sidebar-foreground/70 transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden group-data-[state=open]/collapsible:rotate-90 group-data-[collapsible=icon]:hidden [&>svg]:size-3.5"
            >
              <ChevronRightIcon />
            </button>
          </CollapsibleTrigger>
        ) : null}

        <SidebarMenuButton
          tooltip={ws.path}
          isActive={isWsRowActive}
          onClick={() => onSelectRepository(ws.id)}
          className={cn(worktrees.length > 0 && 'pl-7 group-data-[collapsible=icon]:!pl-2')}
        >
          {repositoryIcon(ws.remoteKind)}
          <span>{ws.name}</span>
        </SidebarMenuButton>

        <SidebarMenuAction
          showOnHover
          className="right-7"
          title="Create worktree"
          onClick={() => onCreateWorktree(ws)}
        >
          <PlusIcon />
          <span className="sr-only">Create worktree</span>
        </SidebarMenuAction>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover title="Repository actions">
              <MoreHorizontalIcon />
              <span className="sr-only">Repository actions</span>
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onSelect={() => onCreateWorktree(ws)}>
              <GitBranchPlusIcon />
              <span>Create worktree</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onRemoveRepository(ws.id)}>
              <Trash2Icon />
              <span>Remove from list</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {worktrees.length > 0 ? (
          <CollapsibleContent>
            <SidebarMenuSub className="mr-0 pr-0">
              {worktrees.map((wt) => {
                const isActive =
                  activeView === 'repository' &&
                  activeRepositoryId === ws.id &&
                  activeWorktreePath === wt.path
                const isDeleting = deletingWorktreePaths.has(wt.path)
                const subtitle = worktreeSubtitle(wt)
                const tooltip = isDeleting
                  ? `Deleting ${wt.path}…`
                  : subtitle
                    ? `${wt.path}\n${subtitle}`
                    : wt.path
                return (
                  <SidebarMenuSubItem
                    key={wt.path}
                    className={cn('relative', isDeleting && 'pointer-events-none opacity-50')}
                    aria-disabled={isDeleting || undefined}
                  >
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <SidebarMenuSubButton
                          asChild
                          isActive={isActive}
                          title={tooltip}
                          className="h-auto py-1"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (isDeleting) return
                              onSelectWorktree(ws.id, wt.path)
                            }}
                            className="w-full text-left"
                            disabled={isDeleting}
                          >
                            {isDeleting ? (
                              <Loader2Icon className="animate-spin" />
                            ) : (
                              <GitBranchIcon />
                            )}
                            <div className="flex min-w-0 flex-1 flex-col leading-tight">
                              <span className="truncate">{worktreeLabel(wt.path)}</span>
                              {subtitle ? (
                                <span className="truncate text-[10px] text-sidebar-foreground/70">
                                  {subtitle}
                                </span>
                              ) : null}
                            </div>
                          </button>
                        </SidebarMenuSubButton>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-52">
                        <ContextMenuItem onSelect={() => onOpenTerminal(wt)}>
                          <SquareTerminalIcon />
                          <span>Terminal</span>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onStartCopilotSession(wt, ws.name)}>
                          <SparklesIcon />
                          <span>Copilot</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => onDeleteWorktree(ws.id, wt)}
                        >
                          <Trash2Icon />
                          <span>Delete worktree</span>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    {!isDeleting ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuAction
                            showOnHover
                            title="Worktree actions"
                            className="top-0.5"
                          >
                            <MoreHorizontalIcon />
                            <span className="sr-only">Worktree actions</span>
                          </SidebarMenuAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start">
                          <DropdownMenuItem onSelect={() => onOpenTerminal(wt)}>
                            <SquareTerminalIcon />
                            <span>Terminal</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onStartCopilotSession(wt, ws.name)}>
                            <SparklesIcon />
                            <span>Copilot</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => onDeleteWorktree(ws.id, wt)}
                          >
                            <Trash2Icon />
                            <span>Delete worktree</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </SidebarMenuSubItem>
                )
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </SidebarMenuItem>
  )
}

export function AppSidebar({
  activeView,
  onSelectView,
  repositories,
  activeRepositoryId,
  activeWorktreePath,
  worktreesByRepositoryId,
  deletingWorktreePaths,
  onAddRepository,
  onSelectRepository,
  onRemoveRepository,
  onReorderRepositories,
  onCreateWorktree,
  onSelectWorktree,
  onDeleteWorktree
}: AppSidebarProps): React.JSX.Element {
  const [repositoriesOpen, setRepositoriesOpen] = React.useState(true)
  const [sessionsOpen, setSessionsOpen] = React.useState(true)
  const launchCopilot = useCopilotLauncher()
  const { terminalMode } = useTerminalMode()
  const { sessions, activeSessionId, selectSession, requestCloseSession } = useSessions()
  const runningCount = sessions.filter((s) => s.status === 'running').length
  const showSessions = terminalMode === 'embedded' || sessions.length > 0

  const handleStartCopilotSession = React.useCallback(
    async (wt: Worktree, repository?: string): Promise<void> => {
      try {
        const result = await launchCopilot({
          folderPath: wt.path,
          label: worktreeLabel(wt.path),
          branch: wt.branch || undefined,
          repository
        })
        if (result.ok) {
          toast.success('Copilot session started.')
        } else {
          toast.error(`Could not start Copilot session: ${result.error}`)
        }
      } catch (err) {
        toast.error(
          `Could not start Copilot session: ${err instanceof Error ? err.message : 'unknown error'}`
        )
      }
    },
    [launchCopilot]
  )

  const handleOpenTerminal = React.useCallback(async (wt: Worktree): Promise<void> => {
    try {
      const result = await openInWindowsTerminal(wt.path)
      if (!result.ok) {
        toast.error(`Could not open terminal: ${result.error}`)
      }
    } catch (err) {
      toast.error(
        `Could not open terminal: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    }
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleRepositoryDragEnd = React.useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const ids = repositories.map((w) => w.id)
      const oldIndex = ids.indexOf(String(active.id))
      const newIndex = ids.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return
      onReorderRepositories(arrayMove(ids, oldIndex, newIndex))
    },
    [repositories, onReorderRepositories]
  )

  return (
    <Sidebar collapsible="icon" className="top-0 bottom-5 h-[calc(100svh-1.25rem)]">
      <SidebarContent className="overflow-x-hidden">
        <Collapsible
          open={repositoriesOpen}
          onOpenChange={setRepositoriesOpen}
          className="flex flex-col"
        >
          <SidebarGroup className="shrink-0">
            <SidebarGroupLabel
              asChild
              className="h-9 cursor-pointer rounded-md text-sm font-semibold text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <CollapsibleTrigger className="group/ws-label flex w-full items-center">
                <ChevronRightIcon className="mr-1.5 size-4 transition-transform group-data-[state=open]/ws-label:rotate-90 group-data-[collapsible=icon]:hidden" />
                Repositories
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <SidebarGroupAction title="Add repository" onClick={onAddRepository}>
              <PlusIcon />
              <span className="sr-only">Add repository</span>
            </SidebarGroupAction>
          </SidebarGroup>
          <CollapsibleContent className="group-data-[collapsible=icon]:overflow-visible">
            <SidebarGroupContent>
              {repositories.length === 0 ? (
                <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs group-data-[collapsible=icon]:hidden">
                  No repositories yet. Click + to add a git repository.
                </p>
              ) : (
                <SidebarMenu>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleRepositoryDragEnd}
                  >
                    <SortableContext
                      items={repositories.map((w) => w.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {repositories.map((ws) => (
                        <SortableRepositoryItem
                          key={ws.id}
                          ws={ws}
                          worktrees={worktreesByRepositoryId[ws.id] ?? []}
                          activeView={activeView}
                          activeRepositoryId={activeRepositoryId}
                          activeWorktreePath={activeWorktreePath}
                          deletingWorktreePaths={deletingWorktreePaths}
                          onSelectRepository={onSelectRepository}
                          onCreateWorktree={onCreateWorktree}
                          onRemoveRepository={onRemoveRepository}
                          onSelectWorktree={onSelectWorktree}
                          onDeleteWorktree={onDeleteWorktree}
                          onOpenTerminal={handleOpenTerminal}
                          onStartCopilotSession={handleStartCopilotSession}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </CollapsibleContent>
        </Collapsible>

        {showSessions && (
          <Collapsible
            open={sessionsOpen}
            onOpenChange={setSessionsOpen}
            className="flex shrink-0 flex-col"
          >
            <SidebarGroup className="shrink-0">
              <SidebarGroupLabel
                asChild
                className="h-9 cursor-pointer rounded-md text-sm font-semibold text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <CollapsibleTrigger className="group/se-label flex w-full items-center">
                  <ChevronRightIcon className="mr-1.5 size-4 transition-transform group-data-[state=open]/se-label:rotate-90 group-data-[collapsible=icon]:hidden" />
                  Sessions
                  {runningCount > 0 && (
                    <span className="ml-auto rounded-full bg-primary/15 px-1.5 text-xs font-medium tabular-nums text-primary group-data-[collapsible=icon]:hidden">
                      {runningCount}
                    </span>
                  )}
                </CollapsibleTrigger>
              </SidebarGroupLabel>
            </SidebarGroup>
            <CollapsibleContent className="group-data-[collapsible=icon]:overflow-visible">
              <SidebarGroupContent>
                {sessions.length === 0 ? (
                  <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs group-data-[collapsible=icon]:hidden">
                    No active sessions.
                  </p>
                ) : (
                  <SidebarMenu>
                    {sessions.map((session) => {
                      const primary = sessionPrimaryLabel(session)
                      const repoLabel = sessionRepoLabel(session)
                      return (
                        <SidebarMenuItem key={session.id}>
                          <SidebarMenuButton
                            tooltip={repoLabel ? `${primary} · ${repoLabel}` : primary}
                            isActive={activeView === 'sessions' && activeSessionId === session.id}
                            className="h-auto py-1"
                            onClick={() => {
                              selectSession(session.id)
                              onSelectView('sessions')
                            }}
                          >
                            <CircleDotIcon
                              className={cn(
                                'size-3.5 shrink-0',
                                session.status === 'running'
                                  ? 'text-emerald-500'
                                  : 'text-muted-foreground'
                              )}
                            />
                            <div className="flex min-w-0 flex-1 flex-col leading-tight">
                              <span className="truncate">{primary}</span>
                              {repoLabel ? (
                                <span className="text-sidebar-foreground/70 truncate text-[10px]">
                                  {repoLabel}
                                </span>
                              ) : null}
                            </div>
                          </SidebarMenuButton>
                          <SidebarMenuAction
                            showOnHover
                            title="Close session"
                            onClick={() => requestCloseSession(session.id)}
                          >
                            <XIcon />
                            <span className="sr-only">Close session</span>
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                )}
              </SidebarGroupContent>
            </CollapsibleContent>
          </Collapsible>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Reviews"
              isActive={activeView === 'reviews'}
              onClick={() => onSelectView('reviews')}
            >
              <GitPullRequestIcon />
              <span>Reviews</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="History"
              isActive={activeView === 'history'}
              onClick={() => onSelectView('history')}
            >
              <HistoryIcon />
              <span>History</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              isActive={activeView === 'settings'}
              onClick={() => onSelectView('settings')}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
