import * as React from 'react'
import {
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  Loader2Icon,
  RefreshCwIcon,
  SquareTerminalIcon
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { cn } from '@/lib/utils'
import type { EmbeddedDirectoryEntry, EmbeddedDirectoryListing } from '@shared/embedded-terminal'
import type { Repository } from '@shared/repository'
import type { Worktree } from '@shared/worktree'

type Root = {
  key: string
  path: string
  label: string
  repository: Repository
  branch?: string
}

type RootGroup = {
  repository: Repository
  root: Root
  worktrees: Root[]
}

type Breadcrumb = {
  label: string
  path: string
}

function listingKey(root: Root, path: string): string {
  return `${root.key}\0${path}`
}

export function TerminalLauncherDialog({
  open,
  onOpenChange,
  repositories,
  worktreesByRepositoryId
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repositories: Repository[]
  worktreesByRepositoryId: Record<string, Worktree[]>
}): React.JSX.Element {
  const { startEmbedded } = useTerminalSessions()
  const rootGroups = React.useMemo<RootGroup[]>(
    () =>
      repositories.map((repository) => ({
        repository,
        root: {
          key: `repo:${repository.id}`,
          path: repository.path,
          label: repository.name,
          repository
        },
        worktrees: (worktreesByRepositoryId[repository.id] ?? []).map((worktree) => ({
          key: `worktree:${worktree.path}`,
          path: worktree.path,
          label: worktree.path.split(/[\\/]/).pop() || worktree.path,
          repository,
          branch: worktree.branch ?? undefined
        }))
      })),
    [repositories, worktreesByRepositoryId]
  )
  const allRoots = React.useMemo(
    () => rootGroups.flatMap(({ root, worktrees }) => [root, ...worktrees]),
    [rootGroups]
  )
  const initialRoot = allRoots[0] ?? null
  const [rootKey, setRootKey] = React.useState<string | null>(() => initialRoot?.key ?? null)
  const root = allRoots.find((candidate) => candidate.key === rootKey) ?? initialRoot
  const [breadcrumbs, setBreadcrumbs] = React.useState<Breadcrumb[]>(() =>
    initialRoot ? [{ label: initialRoot.label, path: initialRoot.path }] : []
  )
  const activeBreadcrumbs =
    breadcrumbs.length > 0 ? breadcrumbs : root ? [{ label: root.label, path: root.path }] : []
  const path =
    activeBreadcrumbs.length > 0 ? activeBreadcrumbs[activeBreadcrumbs.length - 1].path : null
  const [listing, setListing] = React.useState<EmbeddedDirectoryListing | null>(null)
  const [loading, setLoading] = React.useState(Boolean(initialRoot))
  const [error, setError] = React.useState<string | null>(null)
  const [loadRevision, setLoadRevision] = React.useState(0)
  const [openRepositoryIds, setOpenRepositoryIds] = React.useState<Set<string>>(
    () => new Set(repositories.map((repository) => repository.id))
  )
  const [starting, setStarting] = React.useState(false)
  const cacheRef = React.useRef(new Map<string, EmbeddedDirectoryListing>())
  const inFlightRef = React.useRef(new Map<string, Promise<EmbeddedDirectoryListing>>())
  const requestRevisionRef = React.useRef(0)

  React.useEffect(() => {
    if (!open || !root || !path) return
    const cacheKey = listingKey(root, path)
    const requestRevision = ++requestRevisionRef.current
    const cached = cacheRef.current.get(cacheKey)
    if (cached) {
      setListing(cached)
      setLoading(false)
      setError(null)
      return
    }

    setListing(null)
    setLoading(true)
    setError(null)
    let request = inFlightRef.current.get(cacheKey)
    if (!request) {
      request = window.api.embeddedTerminals.listDirectories(root.repository.path, root.path, path)
      inFlightRef.current.set(cacheKey, request)
      const clearRequest = (): void => {
        if (inFlightRef.current.get(cacheKey) === request) {
          inFlightRef.current.delete(cacheKey)
        }
      }
      void request.then(clearRequest, clearRequest)
    }
    void request
      .then((next) => {
        cacheRef.current.set(cacheKey, next)
        if (requestRevisionRef.current !== requestRevision) return
        setListing(next)
        setLoading(false)
      })
      .catch((nextError) => {
        if (requestRevisionRef.current !== requestRevision) return
        setError(`Could not read this folder: ${String(nextError)}`)
        setLoading(false)
      })
  }, [path, root, open, loadRevision])

  const selectRoot = (next: Root): void => {
    setListing(null)
    setLoading(true)
    setError(null)
    setRootKey(next.key)
    setBreadcrumbs([{ label: next.label, path: next.path }])
  }

  const navigateTo = (entry: EmbeddedDirectoryEntry): void => {
    setListing(null)
    setLoading(true)
    setError(null)
    setBreadcrumbs((current) => [
      ...(current.length > 0 ? current : root ? [{ label: root.label, path: root.path }] : []),
      { label: entry.name, path: entry.path }
    ])
  }

  const navigateToBreadcrumb = (index: number): void => {
    setListing(null)
    setLoading(true)
    setError(null)
    setBreadcrumbs(activeBreadcrumbs.slice(0, index + 1))
  }

  const retry = (): void => {
    if (!root || !path) return
    setListing(null)
    setLoading(true)
    setError(null)
    cacheRef.current.delete(listingKey(root, path))
    setLoadRevision((revision) => revision + 1)
  }

  const start = async (): Promise<void> => {
    if (!root || !path) return
    setStarting(true)
    try {
      const terminal = await startEmbedded({
        folderPath: path,
        label: path.split(/[\\/]/).pop() || root.label,
        repository: root.repository.name,
        branch: root.branch,
        cols: 120,
        rows: 30
      })
      if (terminal) onOpenChange(false)
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[75vh] min-h-[420px] w-[75vw] min-w-[720px] !max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:!max-w-[75vw]">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Start embedded terminal</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="bg-muted/35 w-64 shrink-0 overflow-y-auto border-r p-2">
            {repositories.length === 0 ? (
              <p className="text-muted-foreground p-3 text-xs">
                Add a repository before starting an embedded terminal.
              </p>
            ) : (
              rootGroups.map(({ repository, root: repositoryRoot, worktrees }) => {
                const expanded = openRepositoryIds.has(repository.id)
                return (
                  <Collapsible
                    key={repository.id}
                    open={expanded}
                    onOpenChange={(nextOpen) =>
                      setOpenRepositoryIds((current) => {
                        const next = new Set(current)
                        if (nextOpen) next.add(repository.id)
                        else next.delete(repository.id)
                        return next
                      })
                    }
                  >
                    <div className="relative flex items-center">
                      {worktrees.length > 0 ? (
                        <CollapsibleTrigger asChild>
                          <button
                            type="button"
                            className="focus-visible:ring-ring absolute left-1 z-10 flex size-7 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${repository.name}`}
                          >
                            <ChevronRightIcon
                              className={cn(
                                'text-muted-foreground size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                                expanded && 'rotate-90'
                              )}
                            />
                          </button>
                        </CollapsibleTrigger>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => selectRoot(repositoryRoot)}
                        className={cn(
                          'hover:bg-accent focus-visible:ring-ring flex min-h-9 w-full items-center gap-2 rounded-md py-2 pr-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none',
                          worktrees.length > 0 ? 'pl-9' : 'pl-2',
                          root?.key === repositoryRoot.key && 'bg-accent text-accent-foreground'
                        )}
                        title={repository.path}
                      >
                        <FolderGit2Icon className="size-4 shrink-0" />
                        <span className="truncate">{repository.name}</span>
                      </button>
                    </div>
                    {worktrees.length > 0 ? (
                      <CollapsibleContent className="ml-5 border-l pl-2">
                        {worktrees.map((worktreeRoot) => (
                          <button
                            key={worktreeRoot.key}
                            type="button"
                            onClick={() => selectRoot(worktreeRoot)}
                            className={cn(
                              'hover:bg-accent focus-visible:ring-ring flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-2 focus-visible:outline-none',
                              root?.key === worktreeRoot.key && 'bg-accent text-accent-foreground'
                            )}
                            title={worktreeRoot.path}
                          >
                            <GitBranchIcon className="size-3.5 shrink-0" />
                            <span className="min-w-0">
                              <span className="block truncate">{worktreeRoot.label}</span>
                              {worktreeRoot.branch ? (
                                <span className="text-muted-foreground block truncate text-[10px]">
                                  {worktreeRoot.branch}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        ))}
                      </CollapsibleContent>
                    ) : null}
                  </Collapsible>
                )
              })
            )}
          </aside>
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-11 items-center border-b px-3">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {activeBreadcrumbs.map((crumb, index) => (
                  <React.Fragment key={`${index}:${crumb.path}`}>
                    {index > 0 ? (
                      <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => navigateToBreadcrumb(index)}
                      className="hover:bg-accent focus-visible:ring-ring shrink-0 rounded px-2 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
                      title={crumb.path}
                    >
                      {crumb.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="ml-2 size-8 shrink-0"
                onClick={retry}
                disabled={!path || loading}
                aria-label="Refresh folder"
              >
                <RefreshCwIcon
                  className={cn('size-3.5', loading && 'motion-reduce:animate-none animate-spin')}
                />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {loading ? (
                <div className="space-y-1" aria-label="Loading folders">
                  {[0, 1, 2, 3].map((item) => (
                    <div
                      key={item}
                      className="bg-muted motion-reduce:animate-none h-9 animate-pulse rounded-md"
                    />
                  ))}
                </div>
              ) : error ? (
                <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-destructive max-w-lg text-xs">{error}</p>
                  <Button variant="outline" size="sm" onClick={retry}>
                    Try again
                  </Button>
                </div>
              ) : listing?.entries.length ? (
                <div className="space-y-0.5">
                  {listing.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => navigateTo(entry)}
                      className="hover:bg-accent focus-visible:ring-ring flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
                      title={entry.path}
                    >
                      <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                    </button>
                  ))}
                  {listing.skippedEntries > 0 ? (
                    <p className="text-muted-foreground px-3 py-2 text-xs">
                      {listing.skippedEntries} inaccessible folder
                      {listing.skippedEntries === 1 ? '' : 's'} hidden.
                    </p>
                  ) : null}
                </div>
              ) : root ? (
                <div className="text-muted-foreground flex h-full min-h-48 flex-col items-center justify-center gap-1 text-center">
                  <FolderIcon className="size-8 opacity-35" />
                  <p className="text-foreground text-sm font-medium">
                    {listing?.skippedEntries ? 'No accessible subfolders' : 'No subfolders'}
                  </p>
                  <p className="text-xs">
                    {listing?.skippedEntries
                      ? `${listing.skippedEntries} inaccessible folder${listing.skippedEntries === 1 ? ' was' : 's were'} hidden.`
                      : 'Start the terminal in this folder or go back.'}
                  </p>
                </div>
              ) : null}
            </div>
            <footer className="flex items-center justify-between gap-4 border-t px-4 py-3">
              <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                {path}
              </span>
              <Button onClick={() => void start()} disabled={!path || starting}>
                {starting ? (
                  <Loader2Icon className="motion-reduce:animate-none animate-spin" />
                ) : (
                  <SquareTerminalIcon />
                )}
                Start terminal
              </Button>
            </footer>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
