import * as React from 'react'
import { RefreshCw as RefreshCwIcon } from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMyBranches } from '@/hooks/use-my-branches'
import { cn } from '@/lib/utils'
import type { MyBranchRow } from '@shared/repo'

export interface MyBranchesPanelProps {
  workspacePath: string
  activeFolderPath: string | null
  onSelectWorktree?: (worktreePath: string) => void
}

type BranchFilterKey = 'local' | 'remote' | 'checkedOut'

const FILTER_DEFS: ReadonlyArray<{
  key: BranchFilterKey
  label: string
  activeClass: string
}> = [
  {
    key: 'local',
    label: 'Local',
    activeClass:
      'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300'
  },
  {
    key: 'remote',
    label: 'Remote',
    activeClass:
      'bg-violet-500/15 text-violet-700 ring-violet-500/30 dark:text-violet-300'
  },
  {
    key: 'checkedOut',
    label: 'Checked out',
    activeClass:
      'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300'
  }
]

function matchesFilters(row: MyBranchRow, filters: Record<BranchFilterKey, boolean>): boolean {
  return (
    (filters.local && row.hasLocal) ||
    (filters.remote && row.hasRemote) ||
    (filters.checkedOut && row.hasWorktree)
  )
}

export function MyBranchesPanel({
  workspacePath,
  activeFolderPath,
  onSelectWorktree
}: MyBranchesPanelProps): React.JSX.Element {
  const { data, error, isLoading, refresh } = useMyBranches(workspacePath, true)
  const [filters, setFilters] = React.useState<Record<BranchFilterKey, boolean>>({
    local: false,
    remote: false,
    checkedOut: true
  })

  const toggleFilter = (key: BranchFilterKey): void =>
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }))

  const rows = data?.rows ?? []
  const filteredRows = rows.filter((row) => matchesFilters(row, filters))
  const description = data
    ? `${filteredRows.length} of ${rows.length} branch${rows.length === 1 ? '' : 'es'} you created.`
    : isLoading
      ? 'Loading branches…'
      : 'Branches not loaded.'

  return (
    <DashboardCard
      className="xl:col-span-2"
      title="My branches"
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
              aria-label="Refresh my branches"
            >
              <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FILTER_DEFS.map((def) => {
          const active = filters[def.key]
          return (
            <button
              key={def.key}
              type="button"
              aria-pressed={active}
              onClick={() => toggleFilter(def.key)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 transition-colors',
                active
                  ? def.activeClass
                  : 'text-muted-foreground ring-border hover:bg-accent/40'
              )}
            >
              {def.label}
            </button>
          )
        })}
      </div>
      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : !data ? (
        <p className="text-muted-foreground text-xs italic">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">No branches you created.</p>
      ) : filteredRows.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">No branches match the selected filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] table-auto text-left text-[11px]">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="py-1.5 pr-3 font-medium">Branch</th>
                <th className="py-1.5 pr-3 font-medium">Location</th>
                <th className="py-1.5 pr-3 font-medium">Worktree</th>
                <th className="py-1.5 pr-3 font-medium">Last commit</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <MyBranchRowItem
                  key={row.name}
                  row={row}
                  isActive={activeFolderPath != null && row.worktreePath === activeFolderPath}
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

function MyBranchRowItem({
  row,
  isActive,
  onSelect
}: {
  row: MyBranchRow
  isActive: boolean
  onSelect?: (path: string) => void
}): React.JSX.Element {
  const canSelect = Boolean(onSelect && row.hasWorktree && row.worktreePath)
  const handleClick = (): void => {
    if (onSelect && row.worktreePath) onSelect(row.worktreePath)
  }
  return (
    <tr
      className={cn(
        'border-b last:border-0',
        canSelect ? 'hover:bg-accent/40 cursor-pointer' : '',
        isActive ? 'bg-accent/30' : ''
      )}
      onClick={canSelect ? handleClick : undefined}
      title={row.worktreePath ?? row.name}
    >
      <td className="py-1.5 pr-3">
        <span className={cn('text-foreground font-mono text-[11px]', row.hasWorktree && 'font-bold')}>
          {row.name}
        </span>
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex flex-wrap gap-1">
          {row.hasLocal ? (
            <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
              local
            </span>
          ) : null}
          {row.hasRemote ? (
            <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              remote
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-1.5 pr-3">
        {row.hasWorktree ? (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            checked out
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
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
