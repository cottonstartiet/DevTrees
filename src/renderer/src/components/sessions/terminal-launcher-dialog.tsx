import * as React from 'react'
import { ChevronRightIcon, FolderIcon, Loader2Icon, SquareTerminalIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import type { Repository } from '@shared/repository'
import type { Worktree } from '@shared/worktree'

type Root = {
  key: string
  path: string
  label: string
  repository: Repository
  branch?: string
}

type DirectoryEntry = {
  name: string
  path: string
}

type DirectoryNode = {
  entries?: DirectoryEntry[]
  loading: boolean
  error?: string
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
  const roots = React.useMemo<Root[]>(
    () =>
      repositories.flatMap((repository) => [
        {
          key: `repo:${repository.id}`,
          path: repository.path,
          label: repository.name,
          repository
        },
        ...(worktreesByRepositoryId[repository.id] ?? []).map((worktree) => ({
          key: `worktree:${worktree.path}`,
          path: worktree.path,
          label: worktree.path.split(/[\\/]/).pop() || worktree.path,
          repository,
          branch: worktree.branch ?? undefined
        }))
      ]),
    [repositories, worktreesByRepositoryId]
  )
  const [root, setRoot] = React.useState<Root | null>(() => roots[0] ?? null)
  const [path, setPath] = React.useState<string | null>(() => roots[0]?.path ?? null)
  const [loadRevision, setLoadRevision] = React.useState(0)
  const [nodes, setNodes] = React.useState<Record<string, DirectoryNode>>(() =>
    roots[0] ? { [roots[0].path]: { loading: true } } : {}
  )
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(
    () => new Set(roots[0] ? [roots[0].path] : [])
  )
  const [starting, setStarting] = React.useState(false)
  const activeRootKeyRef = React.useRef(root?.key)

  React.useEffect(() => {
    activeRootKeyRef.current = root?.key
  }, [root?.key])

  React.useEffect(() => {
    if (!open || !root) return
    let active = true
    const rootKey = root.key
    void window.api.embeddedTerminals
      .listDirectories(root.path)
      .then((next) => {
        if (!active || activeRootKeyRef.current !== rootKey) return
        setNodes((current) => ({
          ...current,
          [root.path]: { entries: next, loading: false }
        }))
      })
      .catch((error) => {
        if (!active || activeRootKeyRef.current !== rootKey) return
        setNodes((current) => ({
          ...current,
          [root.path]: {
            loading: false,
            error: `Could not read this folder: ${String(error)}`
          }
        }))
      })
    return () => {
      active = false
    }
  }, [open, root, loadRevision])

  const breadcrumbs = React.useMemo(() => {
    if (!root || !path) return []
    const relative = path.slice(root.path.length).replace(/^[\\/]+/, '')
    const parts = relative ? relative.split(/[\\/]/) : []
    const separator = root.path.includes('\\') ? '\\' : '/'
    return [
      { label: root.label, path: root.path },
      ...parts.map((part, index) => ({
        label: part,
        path: `${root.path}${separator}${parts.slice(0, index + 1).join(separator)}`
      }))
    ]
  }, [path, root])

  const selectRoot = (next: Root): void => {
    activeRootKeyRef.current = next.key
    setRoot(next)
    setPath(next.path)
    setExpandedPaths(new Set([next.path]))
    setNodes({ [next.path]: { loading: true } })
    if (next.key === root?.key) setLoadRevision((revision) => revision + 1)
  }

  const loadChildren = React.useCallback(
    async (folderPath: string): Promise<void> => {
      const rootKey = root?.key
      if (!rootKey) return
      setNodes((current) => ({
        ...current,
        [folderPath]: { ...current[folderPath], loading: true, error: undefined }
      }))
      try {
        const entries = await window.api.embeddedTerminals.listDirectories(folderPath)
        if (activeRootKeyRef.current !== rootKey) return
        setNodes((current) => ({
          ...current,
          [folderPath]: { entries, loading: false }
        }))
      } catch (error) {
        if (activeRootKeyRef.current !== rootKey) return
        setNodes((current) => ({
          ...current,
          [folderPath]: {
            loading: false,
            error: `Could not read this folder: ${String(error)}`
          }
        }))
      }
    },
    [root?.key]
  )

  const toggleFolder = (folderPath: string): void => {
    const expanded = expandedPaths.has(folderPath)
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (expanded) next.delete(folderPath)
      else next.add(folderPath)
      return next
    })
    if (!expanded && !nodes[folderPath]?.entries && !nodes[folderPath]?.loading) {
      void loadChildren(folderPath)
    }
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

  const renderFolder = (
    entry: DirectoryEntry,
    depth: number,
    label = entry.name
  ): React.ReactNode => {
    const node = nodes[entry.path]
    const expanded = expandedPaths.has(entry.path)
    const selected = path === entry.path
    return (
      <React.Fragment key={entry.path}>
        <div
          className={cn(
            'group/folder flex min-h-8 items-center rounded-md text-sm',
            selected
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground hover:bg-accent/70'
          )}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          <button
            type="button"
            onClick={() => toggleFolder(entry.path)}
            className="focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            aria-expanded={expanded}
          >
            {node?.loading ? (
              <Loader2Icon className="text-muted-foreground size-3.5 animate-spin" />
            ) : (
              <ChevronRightIcon
                className={cn(
                  'text-muted-foreground size-3.5 transition-transform duration-150',
                  expanded && 'rotate-90'
                )}
              />
            )}
          </button>
          <button
            type="button"
            onClick={() => setPath(entry.path)}
            className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded py-1.5 pr-3 text-left focus-visible:ring-2 focus-visible:outline-none"
            title={entry.path}
          >
            <FolderIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        </div>
        {expanded ? (
          <>
            {node?.error ? (
              <button
                type="button"
                onClick={() => void loadChildren(entry.path)}
                className="text-destructive hover:bg-destructive/5 ml-8 block rounded-md px-3 py-2 text-left text-xs"
                style={{ marginLeft: `${depth * 16 + 32}px` }}
              >
                {node.error} Click to retry.
              </button>
            ) : null}
            {node?.entries?.map((child) => renderFolder(child, depth + 1))}
            {!node?.loading && !node?.error && node?.entries?.length === 0 ? (
              <p
                className="text-muted-foreground py-1.5 pr-3 text-xs"
                style={{ paddingLeft: `${(depth + 1) * 16 + 32}px` }}
              >
                No subfolders
              </p>
            ) : null}
          </>
        ) : null}
      </React.Fragment>
    )
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
              roots.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  onClick={() => selectRoot(candidate)}
                  className={cn(
                    'hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                    root?.key === candidate.key && 'bg-accent text-accent-foreground'
                  )}
                >
                  <FolderIcon className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate">{candidate.label}</span>
                    {candidate.key.startsWith('worktree:') && (
                      <span className="text-muted-foreground block truncate text-[10px]">
                        {candidate.repository.name}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </aside>
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-11 items-center gap-1 overflow-x-auto border-b px-3">
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.path}>
                  {index > 0 && (
                    <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <button
                    type="button"
                    onClick={() => setPath(crumb.path)}
                    className="hover:bg-accent shrink-0 rounded px-2 py-1 text-xs"
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {root
                ? renderFolder(
                    { name: root.label, path: root.path },
                    0,
                    root.label
                  )
                : null}
            </div>
            <footer className="flex items-center justify-between gap-4 border-t px-4 py-3">
              <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                {path}
              </span>
              <Button onClick={() => void start()} disabled={!path || starting}>
                {starting ? (
                  <Loader2Icon className="animate-spin" />
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
