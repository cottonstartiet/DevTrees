import * as React from 'react'
import {
  FolderGit2 as FolderGitIcon,
  GitBranch as GitBranchIcon,
  RefreshCw as RefreshCwIcon,
  X as XIcon
} from 'lucide-react'

import { ReviewWorkspace } from '@/components/pr-review/review-workspace'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocalReview, type LocalReviewTarget } from '@/hooks/use-local-review'
import { cn } from '@/lib/utils'

export interface LocalReviewPageProps {
  target: LocalReviewTarget
  onClose: () => void
}

/** Read-only review of the selected folder's aggregate working-copy changes against HEAD. */
export function LocalReviewPage({ target, onClose }: LocalReviewPageProps): React.JSX.Element {
  const review = useLocalReview(target)
  const folderName = basename(target.folderPath)
  const identity = target.branchLabel?.trim() || 'Current branch'

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
      <FolderGitIcon className="text-muted-foreground size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold" title={target.folderPath}>
          Review changes · {folderName}
        </span>
        <span className="text-muted-foreground flex min-w-0 items-center gap-1 truncate text-[11px]">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{identity}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate font-mono" title={target.folderPath}>
            {target.folderPath}
          </span>
        </span>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void review.refresh()}
            disabled={review.isLoading}
            aria-label="Refresh working-copy review"
          >
            <RefreshCwIcon className={cn('size-3.5', review.isLoading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh working-copy snapshot</TooltipContent>
      </Tooltip>
    </header>
  )

  return (
    <ReviewWorkspace
      header={header}
      files={review.files}
      diffStats={review.diffStats}
      error={review.error}
      isLoading={review.isLoading}
      fileDiffFor={review.fileDiffFor}
      ensureFileDiff={review.ensureFileDiff}
      fileContentFor={review.fileContentFor}
      ensureFileContent={review.ensureFileContent}
      onClose={onClose}
      reloadToken={review.refreshRevision}
      truncatedMessage="Diff truncated — open the file in your editor for the full change."
    />
  )
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return index < 0 ? normalized : normalized.slice(index + 1)
}
