import * as React from 'react'
import {
  AlertTriangleIcon,
  ClockIcon,
  CopyIcon,
  FolderOpenIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareTerminalIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useCopilotHistory } from '@/hooks/use-copilot-history'
import { openPath } from '@/lib/system'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { baseName, cn } from '@/lib/utils'
import type { CopilotHistorySession } from '@shared/copilot-history'

type HostFilter = 'github' | 'ado'
type TimeFilter = 'today' | '7d' | '30d'

const TIME_FILTERS: { value: TimeFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' }
]

/** Lower-bound epoch (ms) a session's `updatedAt` must reach to pass the time filter. */
function timeCutoff(filter: TimeFilter): number {
  if (filter === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  const days = filter === '7d' ? 7 : 30
  return Date.now() - days * 24 * 60 * 60 * 1000
}

/** A small clickable filter chip styled after the Sessions view-mode toggle. */
function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
    >
      {children}
    </button>
  )
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  if (diffMs < 0) return 'just now'
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(then).toLocaleDateString()
}

/** A readable title for a recorded session: its summary, else the folder name, else the cwd/id. */
function historyLabel(session: CopilotHistorySession): string {
  if (session.summary && session.summary.trim()) return session.summary.trim()
  if (session.cwd) return baseName(session.cwd)
  return session.id
}

function matchesQuery(session: CopilotHistorySession, query: string): boolean {
  const haystack = [session.summary, session.repository, session.branch, session.cwd]
    .filter((v): v is string => !!v)
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

export function HistoryPage(): React.JSX.Element {
  const { sessions, error, isLoading, refresh } = useCopilotHistory()
  const [query, setQuery] = React.useState('')
  const [hostFilter, setHostFilter] = React.useState<HostFilter | null>(null)
  const [timeFilter, setTimeFilter] = React.useState<TimeFilter>('7d')
  const launchCopilot = useCopilotLauncher()

  const toggleHost = React.useCallback((host: HostFilter): void => {
    setHostFilter((prev) => (prev === host ? null : host))
  }, [])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const cutoff = timeFilter === '30d' ? null : timeCutoff(timeFilter)
    return sessions.filter((s) => {
      if (q && !matchesQuery(s, q)) return false
      if (hostFilter !== null && s.hostType !== hostFilter) return false
      if (cutoff !== null) {
        const t = s.updatedAt ? Date.parse(s.updatedAt) : NaN
        if (Number.isNaN(t) || t < cutoff) return false
      }
      return true
    })
  }, [sessions, query, hostFilter, timeFilter])

  const resumeInTerminal = React.useCallback(
    async (session: CopilotHistorySession): Promise<void> => {
      if (!session.cwd) {
        toast.error('This session has no recorded folder to resume in.')
        return
      }
      const result = await launchCopilot({
        folderPath: session.cwd,
        resumeSessionId: session.id,
        label: baseName(session.cwd) || 'Resumed session',
        branch: session.branch ?? undefined,
        repository: session.repository ?? undefined
      })
      if (!result.ok) toast.error(result.error)
    },
    [launchCopilot]
  )

  const openFolder = React.useCallback(async (session: CopilotHistorySession): Promise<void> => {
    if (!session.cwd) {
      toast.error('This session has no recorded folder.')
      return
    }
    const result = await openPath(session.cwd)
    if (!result.ok) toast.error(`Could not open folder: ${result.error}`)
  }, [])

  const copyId = React.useCallback(async (session: CopilotHistorySession): Promise<void> => {
    try {
      await navigator.clipboard.writeText(session.id)
      toast.success('Session id copied.')
    } catch {
      toast.error('Could not copy session id.')
    }
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by repository, branch, folder, or summary…"
              className="pl-8"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh session history"
          >
            <RefreshCwIcon className={cn(isLoading && 'animate-spin')} />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={hostFilter === 'github'} onClick={() => toggleHost('github')}>
            GitHub
          </FilterChip>
          <FilterChip active={hostFilter === 'ado'} onClick={() => toggleHost('ado')}>
            Azure DevOps
          </FilterChip>
          <span className="bg-border mx-1 h-4 w-px" />
          {TIME_FILTERS.map(({ value, label }) => (
            <FilterChip
              key={value}
              active={timeFilter === value}
              onClick={() => setTimeFilter(value)}
            >
              <ClockIcon className="size-3" />
              {label}
            </FilterChip>
          ))}
        </div>
      </div>

      {error ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangleIcon className="size-10 opacity-40" />
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">Couldn&apos;t read session history</p>
            <p className="text-xs">{error}</p>
          </div>
        </div>
      ) : isLoading && sessions.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <HistoryIcon className="size-10 opacity-40" />
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">
              {sessions.length === 0 ? 'No Copilot sessions yet' : 'No matching sessions'}
            </p>
            <p className="text-xs">
              {sessions.length === 0
                ? 'Sessions started from DevTrees or any terminal will appear here.'
                : 'Try a different search.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="divide-y">
            {filtered.map((session) => {
              return (
                <li
                  key={session.id}
                  className="hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {historyLabel(session)}
                      </span>
                      {session.hostType ? (
                        <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px] uppercase">
                          {session.hostType}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                      <span className="truncate">{session.repository ?? session.cwd ?? '—'}</span>
                      {session.branch ? (
                        <>
                          <span className="opacity-50">·</span>
                          <span className="truncate">{session.branch}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {relativeTime(session.updatedAt)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void resumeInTerminal(session)}
                    disabled={!session.cwd}
                    title={session.cwd ?? 'No recorded folder'}
                  >
                    <SquareTerminalIcon />
                    Resume
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="More actions">
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem
                        disabled={!session.cwd}
                        onSelect={() => void openFolder(session)}
                      >
                        <FolderOpenIcon />
                        Open folder
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void copyId(session)}>
                        <CopyIcon />
                        Copy session id
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
