import * as React from 'react'
import {
  ExternalLink as ExternalLinkIcon,
  GitPullRequest as GitPullRequestIcon,
  RefreshCw as RefreshCwIcon,
  X as XIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { DiffView } from '@/components/pr-review/diff-view'
import { FileTree } from '@/components/pr-review/file-tree'
import { MarkdownPreview } from '@/components/pr-review/markdown-preview'
import { MermaidViewer } from '@/components/pr-review/mermaid-viewer'
import { VoteMenu } from '@/components/pr-review/vote-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MermaidZoomProvider, useMermaidZoom } from '@/contexts/mermaid-zoom-context'
import { usePrReview, type PrReviewTarget } from '@/hooks/use-pr-review'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { PrVote } from '@shared/pr-review'
import { isMarkdownPath } from '@shared/pr-review'

type ViewMode = 'diff' | 'preview' | 'raw'

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'diff', label: 'Diff' },
  { key: 'preview', label: 'Preview' },
  { key: 'raw', label: 'Raw' }
]

export interface PrReviewPageProps {
  target: PrReviewTarget
  /** Fallback title shown until the PR detail arrives. */
  initialTitle?: string
  onClose: () => void
}

/**
 * Full-screen review workspace: changed files on the left, the diff (or markdown preview) in the
 * main pane, and review actions in the header.
 *
 * Keyboard: `Esc` closes, `j` / `k` move through files, `p` toggles preview for markdown files.
 */
export function PrReviewPage(props: PrReviewPageProps): React.JSX.Element {
  return (
    <MermaidZoomProvider>
      <PrReviewWorkspace {...props} />
    </MermaidZoomProvider>
  )
}

function PrReviewWorkspace({
  target,
  initialTitle,
  onClose
}: PrReviewPageProps): React.JSX.Element {
  const review = usePrReview(target)
  const {
    detail,
    files,
    threads,
    error,
    isLoading,
    isMutating,
    fileDiffFor,
    ensureFileDiff,
    fileContentFor,
    ensureFileContent,
    refresh,
    createThread,
    reply,
    setThreadResolved,
    vote
  } = review

  const [explicitPath, setExplicitPath] = React.useState<string | null>(null)
  const [viewMode, setViewMode] = React.useState<ViewMode>('diff')
  const { isOpen: isDiagramOpen } = useMermaidZoom()

  // The first changed file is selected by derivation rather than an effect, so the file list and
  // the selection can never disagree for a render.
  const selectedPath =
    explicitPath && files.some((file) => file.path === explicitPath)
      ? explicitPath
      : (files[0]?.path ?? null)
  const setSelectedPath = setExplicitPath

  const selectedFile = files.find((file) => file.path === selectedPath) ?? null
  // A deleted file has no head blob, so preview and raw views are not offered for it.
  const isMarkdown =
    selectedPath !== null &&
    isMarkdownPath(selectedPath) &&
    selectedFile?.changeType !== 'delete' &&
    selectedFile?.isBinary !== true
  const effectiveMode: ViewMode = isMarkdown ? viewMode : 'diff'

  React.useEffect(() => {
    if (!selectedPath) return
    if (effectiveMode === 'diff') ensureFileDiff(selectedPath)
    else ensureFileContent(selectedPath, 'head')
  }, [selectedPath, effectiveMode, ensureFileDiff, ensureFileContent])

  // Markdown files need the head blob for both the preview and diff context expansion.
  React.useEffect(() => {
    if (selectedPath && isMarkdown) ensureFileContent(selectedPath, 'head')
  }, [selectedPath, isMarkdown, ensureFileContent])

  const diffEntry = fileDiffFor(selectedPath)
  const contentEntry = fileContentFor(selectedPath, 'head')

  // Fill in add/delete counts for providers that do not report them up front (Azure DevOps);
  // the hook accumulates them as diffs load.
  const diffCounts = review.diffStats

  const threadsByFile = React.useMemo(() => {
    const map = new Map<string, typeof threads>()
    for (const thread of threads) {
      const path = thread.filePath?.replace(/^\//, '') ?? ''
      const list = map.get(path) ?? []
      list.push(thread)
      map.set(path, list)
    }
    return map
  }, [threads])

  const unresolvedCounts = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const thread of threads) {
      if (thread.isResolved) continue
      const path = thread.filePath?.replace(/^\//, '') ?? ''
      map.set(path, (map.get(path) ?? 0) + 1)
    }
    return map
  }, [threads])

  const fileThreads = selectedPath ? (threadsByFile.get(selectedPath) ?? []) : []

  const moveSelection = React.useCallback(
    (delta: number): void => {
      if (files.length === 0) return
      const index = files.findIndex((file) => file.path === selectedPath)
      const next = Math.min(files.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))
      setSelectedPath(files[next].path)
    },
    [files, selectedPath, setSelectedPath]
  )

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // The diagram viewer owns the keyboard while it is open: `Esc` must close it rather than the
      // whole workspace, and `j` / `k` must not swap the file out from under it.
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

  const handleVote = async (value: PrVote): Promise<void> => {
    const message = await vote(value)
    if (message) toast.error(`Vote failed: ${message}`)
    else toast.success('Vote submitted.')
  }

  const handleCreateThread = async (
    anchor: Parameters<typeof createThread>[0],
    content: string
  ): Promise<string | null> => {
    const message = await createThread(anchor, content)
    if (!message) toast.success('Comment posted.')
    return message
  }

  const title = detail?.title ?? initialTitle ?? `Pull request #${target.pullRequestId}`
  const webUrl = detail?.webUrl

  return (
    <div className="bg-background fixed inset-0 z-50 flex flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close review (Esc)"
        >
          <XIcon className="size-4" />
        </Button>
        <GitPullRequestIcon className="text-muted-foreground size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold" title={title}>
            <span className="text-muted-foreground font-mono">#{target.pullRequestId}</span> {title}
          </span>
          <span className="text-muted-foreground truncate text-[11px]">
            {detail
              ? `${detail.author || 'Unknown'} · ${detail.sourceRef} → ${detail.targetRef}`
              : 'Loading pull request…'}
          </span>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void refresh()}
              disabled={isLoading}
              aria-label="Refresh"
            >
              <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
        {webUrl ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void openExternal(webUrl)}
                aria-label="Open pull request in browser"
              >
                <ExternalLinkIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in browser</TooltipContent>
          </Tooltip>
        ) : null}
        <VoteMenu
          remoteKind={target.remoteKind}
          currentVote={detail?.myVote ?? 'none'}
          isBusy={isMutating}
          onVote={(value) => void handleVote(value)}
        />
      </header>

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
            onSelect={setSelectedPath}
            threadCounts={unresolvedCounts}
            diffCounts={diffCounts}
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

          {/* The diagram viewer is positioned against this container, so it covers the document
              but leaves the file sidebar and the toolbar above visible and clickable. */}
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
                onCreateThread={handleCreateThread}
                onReply={reply}
                onToggleResolved={setThreadResolved}
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
                onCreateThread={handleCreateThread}
                onReply={reply}
                onToggleResolved={setThreadResolved}
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
