import * as React from 'react'
import {
  ExternalLink as ExternalLinkIcon,
  FileDiff as FileDiffIcon,
  GitPullRequest as GitPullRequestIcon,
  Loader2 as Loader2Icon,
  RefreshCw as RefreshCwIcon,
  Sparkles as SparklesIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePrReviewWorkspace } from '@/contexts/pr-review-context'
import { useRepoOpenPrs } from '@/hooks/use-repo-open-prs'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { buildCodeReviewPrompt } from '@/lib/copilot-code-review-prompt'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { RepoPr } from '@shared/reviews'
import type { Repository } from '@shared/repository'

const RECENT_LIMIT = 50

export function ReviewsPage({ repository }: { repository: Repository | null }): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const { prs, error, isLoading, isUnsupported, refresh } = useRepoOpenPrs(
    repository?.path ?? null,
    repository?.remoteKind ?? null,
    true
  )

  const filtered = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const matches = (pr: RepoPr): boolean => {
      if (!normalizedQuery) return true
      return [
        pr.title,
        pr.description,
        pr.author,
        String(pr.id),
        `#${pr.id}`,
        pr.sourceRef,
        pr.targetRef
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    }
    const newestFirst = (left: RepoPr, right: RepoPr): number =>
      (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
    const matching = (prs ?? []).filter(matches)

    return {
      assigned: matching.filter((pr) => pr.category === 'assigned').sort(newestFirst),
      recent: matching
        .filter((pr) => pr.category === 'other')
        .sort(newestFirst)
        .slice(0, RECENT_LIMIT)
    }
  }, [prs, query])

  if (!repository) {
    return (
      <EmptyState
        title="Choose a repository"
        hint="Select a repository from the sidebar to review its open pull requests."
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b pb-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by description, title, author, PR #, or branch"
            aria-label="Filter pull requests"
            className="h-8 max-w-lg text-xs"
          />
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => void refresh()}
                disabled={isLoading || isUnsupported}
                aria-label="Refresh pull requests"
              >
                <RefreshCwIcon className={cn('size-4', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto py-5">
          {isUnsupported ? (
            <EmptyState
              title="Unsupported remote"
              hint={`Reviews supports Azure DevOps and GitHub repositories. "${repository.name}" uses an unsupported remote.`}
            />
          ) : error ? (
            <EmptyState title="Could not load pull requests" hint={error} />
          ) : (
            <>
              <PrSection
                title="Assigned to me"
                description="Pull requests awaiting your review"
                prs={filtered.assigned}
                emptyHint="No pull requests are awaiting your review."
                isLoading={isLoading && prs === null}
                folderPath={repository.path}
              />
              <PrSection
                title="Recent"
                description={`Newest review candidates · up to ${RECENT_LIMIT}`}
                prs={filtered.recent}
                emptyHint={
                  query
                    ? 'No recent pull requests match this filter.'
                    : 'No recent pull requests are available to review.'
                }
                isLoading={isLoading && prs === null}
                folderPath={repository.path}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PrSection({
  title,
  description,
  prs,
  emptyHint,
  isLoading,
  folderPath
}: {
  title: string
  description: string
  prs: RepoPr[]
  emptyHint: string
  isLoading: boolean
  folderPath: string
}): React.JSX.Element {
  return (
    <section aria-labelledby={`reviews-${title.toLowerCase().replaceAll(' ', '-')}`}>
      <div className="mb-2 flex items-baseline gap-2">
        <h3
          id={`reviews-${title.toLowerCase().replaceAll(' ', '-')}`}
          className="text-sm font-semibold"
        >
          {title}
        </h3>
        <span className="text-muted-foreground text-xs">
          {isLoading ? 'Loading…' : `${prs.length} · ${description}`}
        </span>
      </div>
      <div className="bg-card rounded-lg border">
        {isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading pull requests…
          </div>
        ) : prs.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-xs italic">{emptyHint}</p>
        ) : (
          <ul className="divide-y">
            {prs.map((pr) => (
              <PrRow key={`${pr.provider}-${pr.id}`} pr={pr} folderPath={folderPath} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function PrRow({ pr, folderPath }: { pr: RepoPr; folderPath: string }): React.JSX.Element {
  const [isLaunching, setIsLaunching] = React.useState(false)
  const launchCopilot = useCopilotLauncher()
  const { openPrReview } = usePrReviewWorkspace()

  const openInApp = (): void => {
    openPrReview({
      folderPath,
      remoteKind: pr.provider,
      pullRequestId: pr.id,
      title: pr.title
    })
  }

  const handleReview = async (): Promise<void> => {
    if (isLaunching) return
    setIsLaunching(true)
    try {
      const prompt = buildCodeReviewPrompt({
        kind: 'pull-request',
        folderPath,
        provider: pr.provider,
        prNumber: pr.id,
        prTitle: pr.title,
        prWebUrl: pr.webUrl,
        sourceRef: pr.sourceRef,
        targetRef: pr.targetRef
      })
      const result = await launchCopilot({
        folderPath,
        prompt,
        label: `Review PR #${pr.id}`
      })
      if (result.ok) {
        toast.success('Copilot review session started.')
      } else {
        toast.error(`Could not start Copilot session: ${result.error}`)
      }
    } catch (err) {
      toast.error(
        `Could not start Copilot session: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    } finally {
      setIsLaunching(false)
    }
  }

  return (
    <li className="hover:bg-accent/50 flex items-center gap-2 px-3 py-2 transition-colors">
      <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
        #{pr.id}
      </span>
      <button
        type="button"
        onClick={openInApp}
        className="focus-visible:ring-ring/50 min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-3"
        title={`Review PR #${pr.id} in DevTrees`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">{pr.title}</span>
          {pr.isDraft ? (
            <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
              Draft
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground block truncate text-[10px]" title={pr.author}>
          {pr.author || 'Unknown'} · {pr.sourceRef} → {pr.targetRef}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={openInApp}
            aria-label={`Review PR #${pr.id} in DevTrees`}
          >
            <FileDiffIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Review in app</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleReview()}
            disabled={isLaunching}
            aria-busy={isLaunching}
            aria-label={`Review PR #${pr.id} with Copilot`}
          >
            {isLaunching ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Review with Copilot</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void openExternal(pr.webUrl)}
            aria-label={`Open PR #${pr.id} in browser`}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in browser</TooltipContent>
      </Tooltip>
    </li>
  )
}

function EmptyState({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <GitPullRequestIcon className="size-8 opacity-40" />
      <p className="text-foreground text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs">{hint}</p>
    </div>
  )
}
