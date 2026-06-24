import * as React from 'react'
import {
  ExternalLink as ExternalLinkIcon,
  FileText as FileTextIcon,
  Loader2 as Loader2Icon,
  MessageSquare as MessageSquareIcon,
  RefreshCw as RefreshCwIcon,
  Sparkles as SparklesIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePrThreads } from '@/hooks/use-pr-threads'
import { buildPrCommentsPrompt } from '@/lib/copilot-pr-prompt'
import { openExternal } from '@/lib/system'
import { useSessions } from '@/contexts/sessions-context'
import { cn } from '@/lib/utils'
import type { AdoPrThread, AdoPrThreadStatus } from '@shared/ado'

export interface PrCommentsPanelProps {
  folderPath: string
  pullRequestId: number
  prTitle?: string
  prWebUrl?: string
}

export function PrCommentsPanel({
  folderPath,
  pullRequestId,
  prTitle,
  prWebUrl
}: PrCommentsPanelProps): React.JSX.Element {
  const { data, error, isLoading, refresh } = usePrThreads(folderPath, pullRequestId, true)
  const [isLaunching, setIsLaunching] = React.useState(false)
  const { createSession } = useSessions()

  const threads = data?.threads ?? []
  const activeCount = threads.reduce((acc, t) => (t.status === 'active' ? acc + 1 : acc), 0)

  const description = data
    ? threads.length === 0
      ? 'No active comments.'
      : activeCount === 0
        ? `${threads.length} thread${threads.length === 1 ? '' : 's'} (none active).`
        : `${activeCount} active thread${activeCount === 1 ? '' : 's'} of ${threads.length}.`
    : isLoading
      ? 'Loading comments…'
      : 'Comments not loaded.'

  const addressDisabled = isLoading || isLaunching || !!error || activeCount === 0
  const addressTooltip = isLaunching
    ? 'Starting Copilot session…'
    : isLoading
      ? 'Loading comments…'
      : error
        ? 'Comments failed to load'
        : activeCount === 0
          ? 'No active comments to address'
          : `Address ${activeCount} active comment${activeCount === 1 ? '' : 's'} with Copilot CLI`

  const handleAddressWithCopilot = async (): Promise<void> => {
    if (addressDisabled) return
    setIsLaunching(true)
    try {
      const prompt = buildPrCommentsPrompt({
        folderPath,
        pullRequestId,
        prTitle,
        prWebUrl
      })
      const result = await createSession({
        folderPath,
        prompt,
        label: `PR #${pullRequestId} comments`
      })
      if (result.ok) {
        toast.success('Copilot session started.')
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
    <DashboardCard
      title="Comments"
      description={description}
      actions={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void handleAddressWithCopilot()}
                disabled={addressDisabled}
                aria-busy={isLaunching}
                aria-label="Address comments with Copilot"
              >
                {isLaunching ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{addressTooltip}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void refresh()}
                disabled={isLoading}
                aria-label="Refresh comments"
              >
                <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </>
      }
    >
      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : !data ? (
        <p className="text-muted-foreground text-xs italic">Loading…</p>
      ) : threads.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">No active comments on this PR.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} />
          ))}
        </ul>
      )}
    </DashboardCard>
  )
}

function ThreadRow({ thread }: { thread: AdoPrThread }): React.JSX.Element {
  const firstComment = thread.comments[0]
  const replyCount = Math.max(0, thread.comments.length - 1)
  const baseName = thread.filePath ? basename(thread.filePath) : null
  const locationLabel = baseName
    ? thread.lineNumber
      ? `${baseName}:${thread.lineNumber}`
      : baseName
    : 'PR overview'
  const ts = thread.lastUpdated ?? firstComment?.publishedDate ?? null

  return (
    <li>
      <button
        type="button"
        className="hover:bg-accent hover:text-accent-foreground flex w-full flex-col gap-1 rounded px-2 py-1.5 text-left"
        onClick={() => void openExternal(thread.webUrl)}
        title={thread.filePath ?? 'Open thread in Azure DevOps'}
      >
        <div className="flex min-w-0 items-center gap-2">
          <FileTextIcon className="text-muted-foreground size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{locationLabel}</span>
          <ThreadStatusBadge status={thread.status} />
          <ExternalLinkIcon className="text-muted-foreground size-3 shrink-0" />
        </div>
        {firstComment ? (
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-foreground shrink-0 text-[11px] font-medium">
              {firstComment.author.displayName}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {firstComment.content || '(no content)'}
            </span>
          </div>
        ) : null}
        <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
          {replyCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquareIcon className="size-3" />
              {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
            </span>
          ) : null}
          {ts ? (
            <span className="tabular-nums" title={ts}>
              {formatRelativeTime(ts)}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  )
}

function ThreadStatusBadge({ status }: { status: AdoPrThreadStatus }): React.JSX.Element {
  const { label, toneClass } = statusMeta(status)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        toneClass
      )}
    >
      {label}
    </span>
  )
}

function statusMeta(status: AdoPrThreadStatus): { label: string; toneClass: string } {
  switch (status) {
    case 'active':
      return { label: 'Active', toneClass: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' }
    case 'pending':
      return {
        label: 'Pending',
        toneClass: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      }
    case 'fixed':
      return {
        label: 'Fixed',
        toneClass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      }
    case 'wontFix':
      return { label: "Won't fix", toneClass: 'bg-muted text-muted-foreground' }
    case 'closed':
      return { label: 'Closed', toneClass: 'bg-muted text-muted-foreground' }
    case 'byDesign':
      return { label: 'By design', toneClass: 'bg-muted text-muted-foreground' }
    case 'unknown':
    default:
      return { label: 'Unknown', toneClass: 'bg-muted text-muted-foreground' }
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx < 0 ? trimmed : trimmed.slice(idx + 1)
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
