import * as React from 'react'

import { DiffView } from '@/components/pr-review/diff-view'
import { FileTree } from '@/components/pr-review/file-tree'
import { MarkdownPreview } from '@/components/pr-review/markdown-preview'
import { MermaidViewer } from '@/components/pr-review/mermaid-viewer'
import { MermaidZoomProvider, useMermaidZoom } from '@/contexts/mermaid-zoom-context'
import { cn } from '@/lib/utils'
import type { ReviewDiffStats, ReviewFileEntry } from '@/hooks/use-local-review'
import type { PrChangedFile, PrCommentAnchor, PrFileContent, PrFileDiff } from '@shared/pr-review'
import { isMarkdownPath } from '@shared/pr-review'
import type { RepoPrThread } from '@shared/reviews'

type ViewMode = 'diff' | 'preview' | 'raw'

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'diff', label: 'Diff' },
  { key: 'preview', label: 'Preview' },
  { key: 'raw', label: 'Raw' }
]

export type ReviewCommentCapabilities = {
  threads: RepoPrThread[]
  onCreateThread: (anchor: PrCommentAnchor, content: string) => Promise<string | null>
  onReply: (thread: RepoPrThread, content: string) => Promise<string | null>
  onToggleResolved: (thread: RepoPrThread, resolved: boolean) => Promise<string | null>
}

export interface ReviewWorkspaceProps {
  header: React.ReactNode
  files: PrChangedFile[]
  diffStats: Map<string, ReviewDiffStats>
  error: string | null
  isLoading: boolean
  fileDiffFor: (path: string | null) => ReviewFileEntry<PrFileDiff>
  ensureFileDiff: (path: string) => void
  fileContentFor: (path: string | null) => ReviewFileEntry<PrFileContent>
  ensureFileContent: (path: string) => void
  onClose: () => void
  reloadToken?: unknown
  comments?: ReviewCommentCapabilities
  truncatedMessage?: string
}

export function ReviewWorkspace(props: ReviewWorkspaceProps): React.JSX.Element {
  return (
    <MermaidZoomProvider>
      <ReviewWorkspaceContent {...props} />
    </MermaidZoomProvider>
  )
}

function ReviewWorkspaceContent({
  header,
  files,
  diffStats,
  error,
  isLoading,
  fileDiffFor,
  ensureFileDiff,
  fileContentFor,
  ensureFileContent,
  onClose,
  reloadToken,
  comments,
  truncatedMessage
}: ReviewWorkspaceProps): React.JSX.Element {
  const [explicitPath, setExplicitPath] = React.useState<string | null>(null)
  const [viewMode, setViewMode] = React.useState<ViewMode>('diff')
  const { isOpen: isDiagramOpen } = useMermaidZoom()

  const selectedPath =
    explicitPath && files.some((file) => file.path === explicitPath)
      ? explicitPath
      : (files[0]?.path ?? null)
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null
  const isMarkdown =
    selectedPath !== null &&
    isMarkdownPath(selectedPath) &&
    selectedFile?.changeType !== 'delete' &&
    selectedFile?.isBinary !== true
  const effectiveMode: ViewMode = isMarkdown ? viewMode : 'diff'

  React.useEffect(() => {
    if (!selectedPath) return
    if (effectiveMode === 'diff') ensureFileDiff(selectedPath)
    else ensureFileContent(selectedPath)
  }, [selectedPath, effectiveMode, ensureFileDiff, ensureFileContent, reloadToken])

  React.useEffect(() => {
    if (selectedPath && isMarkdown) ensureFileContent(selectedPath)
  }, [selectedPath, isMarkdown, ensureFileContent, reloadToken])

  const diffEntry = fileDiffFor(selectedPath)
  const contentEntry = fileContentFor(selectedPath)

  const threadsByFile = React.useMemo(() => {
    const map = new Map<string, RepoPrThread[]>()
    for (const thread of comments?.threads ?? []) {
      const path = thread.filePath?.replace(/^\//, '') ?? ''
      const list = map.get(path) ?? []
      list.push(thread)
      map.set(path, list)
    }
    return map
  }, [comments?.threads])

  const unresolvedCounts = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const thread of comments?.threads ?? []) {
      if (thread.isResolved) continue
      const path = thread.filePath?.replace(/^\//, '') ?? ''
      map.set(path, (map.get(path) ?? 0) + 1)
    }
    return map
  }, [comments?.threads])

  const fileThreads = selectedPath ? (threadsByFile.get(selectedPath) ?? []) : []

  const moveSelection = React.useCallback(
    (delta: number): void => {
      if (files.length === 0) return
      const index = files.findIndex((file) => file.path === selectedPath)
      const next = Math.min(files.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))
      setExplicitPath(files[next].path)
    },
    [files, selectedPath]
  )

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isDiagramOpen) return

      const target = event.target as HTMLElement | null
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true

      if (event.key === 'Escape' && !isTyping) {
        event.preventDefault()
        onClose()
        return
      }
      if (isTyping || event.ctrlKey || event.metaKey || event.altKey) return

      if (event.key === 'j') {
        event.preventDefault()
        moveSelection(1)
      } else if (event.key === 'k') {
        event.preventDefault()
        moveSelection(-1)
      } else if (event.key === 'p' && isMarkdown) {
        event.preventDefault()
        setViewMode((current) => (current === 'preview' ? 'diff' : 'preview'))
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moveSelection, onClose, isMarkdown, isDiagramOpen])

  return (
    <div className="bg-background fixed inset-0 z-50 flex flex-col">
      {header}

      {error ? (
        <p className="text-destructive border-b px-3 py-1.5 text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="bg-sidebar w-72 shrink-0 border-r">
          <FileTree
            files={files}
            selectedPath={selectedPath}
            onSelect={setExplicitPath}
            threadCounts={unresolvedCounts}
            diffCounts={diffStats}
            isLoading={isLoading}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px]"
              title={selectedPath ?? ''}
            >
              {selectedPath ?? 'No file selected'}
            </span>
            {isMarkdown ? (
              <div
                className="flex items-center rounded-md border p-0.5"
                role="group"
                aria-label="View mode"
              >
                {VIEW_MODES.map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    onClick={() => setViewMode(mode.key)}
                    aria-pressed={viewMode === mode.key}
                    className={cn(
                      'rounded px-2 py-0.5 text-[11px] transition-colors',
                      viewMode === mode.key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            {!selectedPath ? (
              <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
                {isLoading ? 'Loading changed files…' : 'Select a file to review.'}
              </div>
            ) : effectiveMode === 'diff' ? (
              <DiffView
                key={selectedPath}
                path={selectedPath}
                diff={diffEntry.data}
                error={diffEntry.error}
                isLoading={diffEntry.isLoading}
                threads={fileThreads}
                headText={contentEntry.data?.text ?? null}
                onCreateThread={comments?.onCreateThread}
                onReply={comments?.onReply}
                onToggleResolved={comments?.onToggleResolved}
                truncatedMessage={truncatedMessage}
              />
            ) : contentEntry.isLoading ? (
              <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
                Loading file…
              </div>
            ) : contentEntry.error ? (
              <div className="text-destructive flex flex-1 items-center justify-center p-8 text-xs">
                {contentEntry.error}
              </div>
            ) : effectiveMode === 'preview' ? (
              <MarkdownPreview
                key={selectedPath}
                path={selectedPath}
                text={contentEntry.data?.text ?? ''}
                threads={fileThreads}
                onCreateThread={comments?.onCreateThread}
                onReply={comments?.onReply}
                onToggleResolved={comments?.onToggleResolved}
              />
            ) : (
              <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">
                {contentEntry.data?.text ?? ''}
              </pre>
            )}

            <MermaidViewer />
          </div>
        </div>
      </div>
    </div>
  )
}
