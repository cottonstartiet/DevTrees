import * as React from 'react'
import { RefreshCw as RefreshCwIcon } from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorktreesOverview } from '@/hooks/use-worktrees-overview'
import { cn } from '@/lib/utils'
import type { WorktreeOverviewRow } from '@shared/repo'

export interface WorktreesOverviewPanelProps {
  repositoryPath: string
  activeFolderPath: string | null
  onSelectWorktree?: (worktreePath: string) => void
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return idx < 0 ? p : p.slice(idx + 1)
}

export function WorktreesOverviewPanel({
  repositoryPath,
  activeFolderPath,
  onSelectWorktree
}: WorktreesOverviewPanelProps): React.JSX.Element {
  const { data, error, isLoading, refresh } = useWorktreesOverview(repositoryPath, true)

  const rows = data?.rows ?? []
  const description = data
    ? `${rows.length} worktree${rows.length === 1 ? '' : 's'}.`
    : isLoading
      ? 'Loading worktrees…'
      : 'Worktrees not loaded.'

  return (
    <DashboardCard
      className="xl:col-span-2"
      title="Worktrees overview"
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
              aria-label="Refresh worktrees"
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
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">No worktrees.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] table-auto text-left text-[11px]">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="py-1.5 pr-3 font-medium">Folder</th>
                <th className="py-1.5 pr-3 font-medium">Branch</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium text-right">Ahead / Behind</th>
                <th className="py-1.5 pr-3 font-medium">Last commit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <WorktreeRow
                  key={row.path}
                  row={row}
                  isActive={activeFolderPath === row.path}
                  onSelect={onSelectWorktree}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardCard>
  )
}

function WorktreeRow({
  row,
  isActive,
  onSelect
}: {
  row: WorktreeOverviewRow
  isActive: boolean
  onSelect?: (path: string) => void
}): React.JSX.Element {
  const handleClick = (): void => {
    if (onSelect) onSelect(row.path)
  }
  return (
    <tr
      className={cn(
        'border-b last:border-0',
        onSelect ? 'hover:bg-accent/40 cursor-pointer' : '',
        isActive ? 'bg-accent/30' : ''
      )}
      onClick={onSelect ? handleClick : undefined}
      title={row.path}
    >
      <td className="py-1.5 pr-3">
        <div className="flex flex-col">
          <span className="text-foreground truncate font-medium">
            {basename(row.path)}
            {row.isMain ? (
              <span className="text-muted-foreground ml-1 text-[10px]">(main)</span>
            ) : null}
          </span>
          <span className="text-muted-foreground truncate font-mono text-[10px]">{row.path}</span>
        </div>
      </td>
      <td className="py-1.5 pr-3">
        {row.isDetached ? (
          <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]">
            detached
          </span>
        ) : row.branch ? (
          <span className="font-mono text-[11px]">{row.branch}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex flex-wrap gap-1">
          {row.isDirty ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              dirty
            </span>
          ) : (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              clean
            </span>
          )}
          {row.isLocked ? (
            <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]">
              locked
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums">
        {row.hasRemote ? `${row.ahead} / ${row.behind}` : '—'}
      </td>
      <td className="py-1.5 pr-3">
        <span title={row.lastCommitSubject ?? ''}>
          {row.lastCommitIso ? formatRelativeTime(row.lastCommitIso) : '—'}
        </span>
      </td>
    </tr>
  )
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
