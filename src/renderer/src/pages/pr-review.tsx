import * as React from 'react'
import {
  ExternalLink as ExternalLinkIcon,
  GitPullRequest as GitPullRequestIcon,
  RefreshCw as RefreshCwIcon,
  X as XIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { ReviewWorkspace } from '@/components/pr-review/review-workspace'
import { VoteMenu } from '@/components/pr-review/vote-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePrReview, type PrReviewTarget } from '@/hooks/use-pr-review'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { PrVote } from '@shared/pr-review'

export interface PrReviewPageProps {
  target: PrReviewTarget
  /** Fallback title shown until the PR detail arrives. */
  initialTitle?: string
  onClose: () => void
}

/** Provider-backed full-screen review workspace with comments, voting, and browser actions. */
export function PrReviewPage({
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

  const handleVote = async (value: PrVote): Promise<void> => {
    const message = await vote(value)
    if (message) toast.error(`Vote failed: ${message}`)
    else toast.success('Vote submitted.')
  }

  const handleCreateThread = async (
    anchor: Parameters<typeof createThread>[0],
    content: string
  ): Promise<string | null> => {
    if (!anchor) return 'Choose a line or markdown block to comment on.'
    const message = await createThread(anchor, content)
    if (!message) toast.success('Comment posted.')
    return message
  }

  const title = detail?.title ?? initialTitle ?? `Pull request #${target.pullRequestId}`
  const webUrl = detail?.webUrl

  const header = (
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
  )

  return (
    <ReviewWorkspace
      header={header}
      files={files}
      diffStats={review.diffStats}
      error={error}
      isLoading={isLoading}
      fileDiffFor={fileDiffFor}
      ensureFileDiff={ensureFileDiff}
      fileContentFor={(path) => fileContentFor(path, 'head')}
      ensureFileContent={(path) => ensureFileContent(path, 'head')}
      onClose={onClose}
      comments={{
        threads,
        onCreateThread: handleCreateThread,
        onReply: reply,
        onToggleResolved: setThreadResolved
      }}
    />
  )
}
