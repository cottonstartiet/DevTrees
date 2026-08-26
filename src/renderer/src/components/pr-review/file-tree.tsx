import * as React from 'react'
import {
  FileDiff as FileDiffIcon,
  FileMinus as FileMinusIcon,
  FilePen as FilePenIcon,
  FilePlus as FilePlusIcon,
  MessageSquare as MessageSquareIcon
} from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { PrChangedFile } from '@shared/pr-review'

export interface FileTreeProps {
  files: PrChangedFile[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Unresolved thread count per file path. */
  threadCounts: Map<string, number>
  /**
   * Add/delete counts discovered when a file's diff loads. Azure DevOps does not report them in
   * the change list, so the sidebar fills them in as diffs are viewed.
   */
  diffCounts: Map<string, { additions: number; deletions: number }>
  isLoading: boolean
}

/** Changed-file list for the review workspace, filtered and keyboard-navigable. */
export function FileTree({
  files,
  selectedPath,
  onSelect,
  threadCounts,
  diffCounts,
  isLoading
}: FileTreeProps): React.JSX.Element {
  const [query, setQuery] = React.useState('')

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.path.toLowerCase().includes(needle))
  }, [files, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files"
          aria-label="Filter changed files"
          className="h-7 text-xs"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {isLoading && files.length === 0 ? (
          <li className="text-muted-foreground px-2 py-1 text-xs italic">Loading files…</li>
        ) : filtered.length === 0 ? (
          <li className="text-muted-foreground px-2 py-1 text-xs italic">
            {files.length === 0 ? 'No changed files.' : 'No files match the filter.'}
          </li>
        ) : (
          filtered.map((file) => {
            const counts = diffCounts.get(file.path)
            const additions = counts?.additions ?? file.additions
            const deletions = counts?.deletions ?? file.deletions
            const threads = threadCounts.get(file.path) ?? 0
            const isSelected = file.path === selectedPath

            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => onSelect(file.path)}
                  aria-current={isSelected ? 'true' : undefined}
                  title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left',
                    isSelected
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <ChangeGlyph changeType={file.changeType} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {basename(file.path)}
                    <span className="text-muted-foreground"> {dirname(file.path)}</span>
                  </span>
                  {threads > 0 ? (
                    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[10px]">
                      <MessageSquareIcon className="size-3" />
                      {threads}
                    </span>
                  ) : null}
                  {additions > 0 || deletions > 0 ? (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{' '}
                      <span className="text-muted-foreground">-{deletions}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}

function ChangeGlyph({
  changeType
}: {
  changeType: PrChangedFile['changeType']
}): React.JSX.Element {
  const className = 'size-3 shrink-0 text-muted-foreground'
  switch (changeType) {
    case 'add':
      return <FilePlusIcon className={className} aria-label="Added" />
    case 'delete':
      return <FileMinusIcon className={className} aria-label="Deleted" />
    case 'rename':
      return <FilePenIcon className={className} aria-label="Renamed" />
    default:
      return <FileDiffIcon className={className} aria-label="Modified" />
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? '' : path.slice(0, idx)
}
