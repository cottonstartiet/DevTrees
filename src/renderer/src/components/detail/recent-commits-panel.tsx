import * as React from 'react'
import { ExternalLink as ExternalLinkIcon, RefreshCw as RefreshCwIcon } from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRecentCommits } from '@/hooks/use-recent-commits'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'

export interface RecentCommitsPanelProps {
  folderPath: string
}

export function RecentCommitsPanel({ folderPath }: RecentCommitsPanelProps): React.JSX.Element {
  const { data, error, isLoading, refresh } = useRecentCommits(folderPath, true, 10)

  const description = data
    ? data.commits.length === 0
      ? 'No commits yet.'
      : `Last ${data.commits.length} commit${data.commits.length === 1 ? '' : 's'}.`
    : isLoading
      ? 'Loading recent commits…'
      : 'Recent commits not loaded.'

  return (
    <DashboardCard
      title="Recent commits"
      description={description}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void refresh()}
              disabled={isLoading}
              aria-label="Refresh recent commits"
            >
              <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      }
    >
      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : !data ? (
        <p className="text-muted-foreground text-xs italic">Loading…</p>
      ) : data.commits.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">No commits in this folder yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.commits.map((commit) => (
            <CommitRow
              key={commit.sha}
              sha={commit.sha}
              subject={commit.subject}
              author={commit.author}
              isoTime={commit.isoTime}
              adoCommitUrlPrefix={data.adoCommitUrlPrefix}
            />
          ))}
        </ul>
      )}
    </DashboardCard>
  )
}

function CommitRow({
  sha,
  subject,
  author,
  isoTime,
  adoCommitUrlPrefix
}: {
  sha: string
  subject: string
  author: string
  isoTime: string
  adoCommitUrlPrefix?: string
}): React.JSX.Element {
  const shortSha = sha.slice(0, 7)
  const relative = formatRelativeTime(isoTime)
  const url = adoCommitUrlPrefix ? `${adoCommitUrlPrefix}${sha}` : null

  const inner = (
    <>
      <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
        {shortSha}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs" title={subject}>
        {subject}
      </span>
      <span className="text-muted-foreground shrink-0 text-[11px]" title={author}>
        {author}
      </span>
      <span
        className="text-muted-foreground shrink-0 text-[11px] tabular-nums"
        title={new Date(isoTime).toLocaleString()}
      >
        {relative}
      </span>
      {url ? <ExternalLinkIcon className="text-muted-foreground size-3 shrink-0" /> : null}
    </>
  )

  if (url) {
    return (
      <li>
        <button
          type="button"
          className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded px-1.5 py-1 text-left"
          onClick={() => void openExternal(url)}
        >
          {inner}
        </button>
      </li>
    )
  }
  return <li className="flex items-center gap-2 px-1.5 py-1">{inner}</li>
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const diffMs = Date.now() - ts
  if (diffMs < 0) return 'in the future'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}
