import * as React from 'react'
import { ExternalLink as ExternalLinkIcon, RefreshCw as RefreshCwIcon } from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRepoOpenPrs } from '@/hooks/use-repo-open-prs'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'
import type { RepoPr } from '@shared/reviews'
import type { RepositoryRemoteKind } from '@shared/repository'

export interface MyOpenPrsPanelProps {
  folderPath: string
  remoteKind: RepositoryRemoteKind
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

export function MyOpenPrsPanel({
  folderPath,
  remoteKind
}: MyOpenPrsPanelProps): React.JSX.Element {
  const { prs, error, isLoading, isUnsupported, refresh } = useRepoOpenPrs(
    folderPath,
    remoteKind,
    true
  )
  const myPrs = React.useMemo(() => (prs ?? []).filter((pr) => pr.category === 'mine'), [prs])

  const description = isUnsupported
    ? 'Unsupported remote.'
    : prs
      ? myPrs.length === 0
        ? 'No active PRs in this repo.'
        : `${myPrs.length} active PR${myPrs.length === 1 ? '' : 's'}.`
      : isLoading
        ? 'Loading your PRs…'
        : 'Your PRs not loaded.'

  return (
    <DashboardCard
      title="My open PRs"
      description={description}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void refresh()}
              disabled={isUnsupported || isLoading}
              aria-label="Refresh my open PRs"
            >
              <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      }
    >
      {isUnsupported ? (
        <p className="text-muted-foreground text-xs italic">
          Open PRs are only available for GitHub and Azure DevOps remotes.
        </p>
      ) : error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : !prs ? (
        <p className="text-muted-foreground text-xs italic">Loading…</p>
      ) : myPrs.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {myPrs.map((pr) => (
            <PrRow key={pr.id} pr={pr} />
          ))}
        </ul>
      )}
    </DashboardCard>
  )
}

function PrRow({ pr }: { pr: RepoPr }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded px-1.5 py-1 text-left"
        onClick={() => void openExternal(pr.webUrl)}
      >
        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
          #{pr.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs" title={pr.title}>
          {pr.title}
        </span>
        {pr.isDraft ? (
          <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
            Draft
          </span>
        ) : null}
        <span
          className="text-muted-foreground shrink-0 truncate font-mono text-[10px]"
          title={`${pr.sourceRef} → ${pr.targetRef}`}
        >
          {shortRef(pr.sourceRef)} → {shortRef(pr.targetRef)}
        </span>
        <ExternalLinkIcon className={cn('text-muted-foreground size-3 shrink-0')} />
      </button>
    </li>
  )
}
