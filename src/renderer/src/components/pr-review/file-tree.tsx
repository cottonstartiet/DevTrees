import * as React from 'react'
import {
  ChevronRight as ChevronRightIcon,
  FileDiff as FileDiffIcon,
  FileMinus as FileMinusIcon,
  FilePen as FilePenIcon,
  FilePlus as FilePlusIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
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

type FileNode = {
  kind: 'file'
  name: string
  path: string
  file: PrChangedFile
}

type FolderNode = {
  kind: 'folder'
  name: string
  path: string
  children: TreeNode[]
}

type TreeNode = FileNode | FolderNode

/** Changed-file tree for the review workspace, filtered and keyboard-navigable. */
export function FileTree({
  files,
  selectedPath,
  onSelect,
  threadCounts,
  diffCounts,
  isLoading
}: FileTreeProps): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [collapsedFolders, setCollapsedFolders] = React.useState<Map<string, string | null>>(
    () => new Map()
  )

  const filteredFiles = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.path.toLowerCase().includes(needle))
  }, [files, query])
  const tree = React.useMemo(() => buildFileTree(filteredFiles), [filteredFiles])
  const isFiltering = query.trim().length > 0
  const selectedAncestors = React.useMemo(
    () => new Set(selectedPath ? ancestorPaths(selectedPath) : []),
    [selectedPath]
  )

  const toggleFolder = React.useCallback(
    (path: string): void => {
      setCollapsedFolders((current) => {
        const next = new Map(current)
        if (next.has(path)) next.delete(path)
        else next.set(path, selectedPath)
        return next
      })
    },
    [selectedPath]
  )

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
      <ul
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
        role="tree"
        aria-label="Changed files"
      >
        {isLoading && files.length === 0 ? (
          <li className="text-muted-foreground px-2 py-1 text-xs italic" role="none">
            Loading files…
          </li>
        ) : filteredFiles.length === 0 ? (
          <li className="text-muted-foreground px-2 py-1 text-xs italic" role="none">
            {files.length === 0 ? 'No changed files.' : 'No files match the filter.'}
          </li>
        ) : (
          <TreeNodes
            nodes={tree}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
            threadCounts={threadCounts}
            diffCounts={diffCounts}
            collapsedFolders={collapsedFolders}
            selectedAncestors={selectedAncestors}
            isFiltering={isFiltering}
            onToggleFolder={toggleFolder}
          />
        )}
      </ul>
    </div>
  )
}

interface TreeNodesProps {
  nodes: TreeNode[]
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  threadCounts: Map<string, number>
  diffCounts: Map<string, { additions: number; deletions: number }>
  collapsedFolders: Map<string, string | null>
  selectedAncestors: Set<string>
  isFiltering: boolean
  onToggleFolder: (path: string) => void
}

function TreeNodes({
  nodes,
  depth,
  selectedPath,
  onSelect,
  threadCounts,
  diffCounts,
  collapsedFolders,
  selectedAncestors,
  isFiltering,
  onToggleFolder
}: TreeNodesProps): React.JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const isSelectionAncestor = selectedAncestors.has(node.path)
          const isExpanded =
            isFiltering ||
            !collapsedFolders.has(node.path) ||
            (isSelectionAncestor && collapsedFolders.get(node.path) !== selectedPath)

          return (
            <li key={node.path} role="none">
              <button
                type="button"
                role="treeitem"
                aria-expanded={isExpanded}
                aria-level={depth + 1}
                title={node.path}
                onClick={() => {
                  if (!isFiltering) onToggleFolder(node.path)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' && !isExpanded) {
                    event.preventDefault()
                    onToggleFolder(node.path)
                  } else if (event.key === 'ArrowLeft' && isExpanded && !isFiltering) {
                    event.preventDefault()
                    onToggleFolder(node.path)
                  }
                }}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-1 rounded py-1 pr-2 text-left"
                style={{ paddingLeft: `${4 + depth * 12}px` }}
              >
                <ChevronRightIcon
                  className={cn(
                    'text-muted-foreground size-3 shrink-0 transition-transform',
                    isExpanded && 'rotate-90'
                  )}
                />
                {isExpanded ? (
                  <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{node.name}</span>
              </button>
              {isExpanded ? (
                <ul role="group">
                  <TreeNodes
                    nodes={node.children}
                    depth={depth + 1}
                    selectedPath={selectedPath}
                    onSelect={onSelect}
                    threadCounts={threadCounts}
                    diffCounts={diffCounts}
                    collapsedFolders={collapsedFolders}
                    selectedAncestors={selectedAncestors}
                    isFiltering={isFiltering}
                    onToggleFolder={onToggleFolder}
                  />
                </ul>
              ) : null}
            </li>
          )
        }

        const { file } = node
        const counts = diffCounts.get(file.path)
        const additions = counts?.additions ?? file.additions
        const deletions = counts?.deletions ?? file.deletions
        const threads = threadCounts.get(file.path) ?? 0
        const isSelected = file.path === selectedPath

        return (
          <li key={file.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={isSelected}
              onClick={() => onSelect(file.path)}
              aria-current={isSelected ? 'true' : undefined}
              title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
              className={cn(
                'flex w-full items-center gap-2 rounded py-1 pr-2 text-left',
                isSelected
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
            >
              <ChangeGlyph changeType={file.changeType} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{node.name}</span>
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
      })}
    </>
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

function buildFileTree(files: PrChangedFile[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] }

  for (const file of files) {
    const parts = file.path.split('/')
    const fileName = parts.pop()
    if (!fileName) continue

    let parent = root
    let parentPath = ''
    for (const part of parts) {
      parentPath = parentPath ? `${parentPath}/${part}` : part
      const existing = parent.children.find(
        (child): child is FolderNode => child.kind === 'folder' && child.name === part
      )
      if (existing) {
        parent = existing
        continue
      }

      const folder: FolderNode = {
        kind: 'folder',
        name: part,
        path: parentPath,
        children: []
      }
      parent.children.push(folder)
      parent = folder
    }

    parent.children.push({
      kind: 'file',
      name: fileName,
      path: file.path,
      file
    })
  }

  return root.children
}

function ancestorPaths(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}
