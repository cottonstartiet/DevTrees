import * as React from 'react'
import {
  Check as CheckIcon,
  ChevronsUpDown as ChevronsUpDownIcon,
  ExternalLink as ExternalLinkIcon,
  GitPullRequest as GitPullRequestIcon,
  Loader2 as Loader2Icon,
  RefreshCw as RefreshCwIcon,
  Sparkles as SparklesIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRepoOpenPrs } from '@/hooks/use-repo-open-prs'
import { buildPrCodeReviewPrompt } from '@/lib/copilot-pr-review-prompt'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { PrCategory, RepoPr } from '@shared/reviews'
import type { Repository, RepositoryRemoteKind } from '@shared/repository'

export interface ReviewsPageProps {
  repositories: Repository[]
  activeRepositoryId: string | null
}

const CATEGORY_ORDER: { key: PrCategory; title: string; empty: string }[] = [
  { key: 'mine', title: 'My PRs', empty: 'You have no open PRs in this repo.' },
  { key: 'assigned', title: 'Assigned to me', empty: 'No PRs are awaiting your review.' },
  { key: 'other', title: 'Others', empty: 'No other open PRs.' }
]

function isSupported(kind: RepositoryRemoteKind): boolean {
  return kind === 'ado' || kind === 'github'
}

function providerLabel(kind: RepositoryRemoteKind): string {
  if (kind === 'ado') return 'Azure DevOps'
  if (kind === 'github') return 'GitHub'
  return 'Unsupported remote'
}

export function ReviewsPage({
  repositories,
  activeRepositoryId
}: ReviewsPageProps): React.JSX.Element {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  // Resolve the effective selection: keep an explicit choice when still valid, otherwise default to
  // the active repository (when supported), then the first supported repository, then anything.
  const effectiveId = React.useMemo(() => {
    const known = new Set(repositories.map((w) => w.id))
    if (selectedId && known.has(selectedId)) return selectedId
    const active = repositories.find((w) => w.id === activeRepositoryId)
    if (active && isSupported(active.remoteKind)) return active.id
    const supported = repositories.find((w) => isSupported(w.remoteKind))
    if (supported) return supported.id
    return active?.id ?? repositories[0]?.id ?? null
  }, [selectedId, repositories, activeRepositoryId])

  const selected = repositories.find((w) => w.id === effectiveId) ?? null

  const { prs, error, isLoading, isUnsupported, refresh } = useRepoOpenPrs(
    selected?.path ?? null,
    selected?.remoteKind ?? null,
    true
  )

  const grouped = React.useMemo(() => {
    const buckets: Record<PrCategory, RepoPr[]> = { mine: [], assigned: [], other: [] }
    for (const pr of prs ?? []) buckets[pr.category].push(pr)
    return buckets
  }, [prs])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-6 py-3">
        <RepoSwitcher repositories={repositories} selected={selected} onSelect={setSelectedId} />
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => void refresh()}
              disabled={isLoading || !selected || isUnsupported}
              aria-label="Refresh pull requests"
            >
              <RefreshCwIcon className={cn('size-4', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {!selected ? (
          <EmptyState title="No repository" hint="Add a repository to review its pull requests." />
        ) : isUnsupported ? (
          <EmptyState
            title="Unsupported remote"
            hint={`Reviews supports Azure DevOps and GitHub repositories. "${selected.name}" uses an unsupported remote.`}
          />
        ) : error ? (
          <EmptyState title="Could not load pull requests" hint={error} />
        ) : (
          CATEGORY_ORDER.map(({ key, title, empty }) => (
            <CategorySection
              key={key}
              title={title}
              prs={grouped[key]}
              emptyHint={empty}
              isLoading={isLoading && prs === null}
              folderPath={selected.path}
            />
          ))
        )}
      </div>
    </div>
  )
}

function RepoSwitcher({
  repositories,
  selected,
  onSelect
}: {
  repositories: Repository[]
  selected: Repository | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 max-w-[18rem] gap-2">
          <GitPullRequestIcon className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{selected ? selected.name : 'Select repository'}</span>
          <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Repository</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {repositories.length === 0 ? (
          <DropdownMenuItem disabled>No repositories</DropdownMenuItem>
        ) : (
          repositories.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => onSelect(w.id)}
              disabled={!isSupported(w.remoteKind)}
              className="gap-2"
            >
              <CheckIcon
                className={cn(
                  'size-4 shrink-0',
                  selected?.id === w.id ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-muted-foreground shrink-0 text-[10px]">
                {providerLabel(w.remoteKind)}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CategorySection({
  title,
  prs,
  emptyHint,
  isLoading,
  folderPath
}: {
  title: string
  prs: RepoPr[]
  emptyHint: string
  isLoading: boolean
  folderPath: string
}): React.JSX.Element {
  const description = isLoading
    ? 'Loading…'
    : `${prs.length} pull request${prs.length === 1 ? '' : 's'}`

  return (
    <DashboardCard title={title} description={description}>
      {isLoading ? (
        <p className="text-muted-foreground text-xs italic">Loading…</p>
      ) : prs.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {prs.map((pr) => (
            <PrRow key={`${pr.provider}-${pr.id}`} pr={pr} folderPath={folderPath} />
          ))}
        </ul>
      )}
    </DashboardCard>
  )
}

function PrRow({ pr, folderPath }: { pr: RepoPr; folderPath: string }): React.JSX.Element {
  const [isLaunching, setIsLaunching] = React.useState(false)
  const launchCopilot = useCopilotLauncher()

  const handleReview = async (): Promise<void> => {
    if (isLaunching) return
    setIsLaunching(true)
    try {
      const prompt = buildPrCodeReviewPrompt({
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
    <li className="hover:bg-accent/50 flex items-center gap-2 rounded px-1.5 py-1">
      <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
        #{pr.id}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs" title={pr.title}>
          {pr.title}
        </span>
        <span className="text-muted-foreground truncate text-[10px]" title={pr.author}>
          {pr.author || 'Unknown'} · {pr.sourceRef} → {pr.targetRef}
        </span>
      </div>
      {pr.isDraft ? (
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
          Draft
        </span>
      ) : null}
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
