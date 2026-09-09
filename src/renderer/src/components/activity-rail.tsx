import * as React from 'react'
import {
  CoffeeIcon,
  FolderGit2Icon,
  GaugeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  KanbanSquareIcon,
  LineChartIcon,
  SettingsIcon,
  SquareTerminalIcon
} from 'lucide-react'
import { toast } from 'sonner'

import type { AppView } from '@/components/app-sidebar'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { cn } from '@/lib/utils'
import { isTerminalSessionFinished } from '@shared/terminal-session'
import { nativeSessionNeedsUserAction } from '@shared/native-session'

const TOP_ITEMS: ReadonlyArray<{
  view: AppView
  label: string
  Icon: typeof GaugeIcon
}> = [
  { view: 'dashboard', label: 'Dashboard', Icon: GaugeIcon },
  { view: 'tasks', label: 'Tasks', Icon: KanbanSquareIcon },
  { view: 'repositories', label: 'Repos', Icon: FolderGit2Icon },
  { view: 'reviews', label: 'Reviews', Icon: GitPullRequestIcon },
  { view: 'sessions', label: 'Sessions', Icon: SquareTerminalIcon },
  { view: 'history', label: 'History', Icon: HistoryIcon },
  { view: 'analytics', label: 'Analytics', Icon: LineChartIcon }
]

function RailButton({
  view,
  label,
  Icon,
  activeView,
  onSelect,
  attentionCount = 0
}: {
  view: AppView
  label: string
  Icon: typeof GaugeIcon
  activeView: AppView
  onSelect: (view: AppView) => void
  attentionCount?: number
}): React.JSX.Element {
  const active = view === activeView
  const accessibleLabel =
    attentionCount > 0
      ? `${label}, ${attentionCount} running ${attentionCount === 1 ? 'session needs' : 'sessions need'} your action`
      : label
  return (
    <button
      type="button"
      aria-label={accessibleLabel}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(view)}
      className={cn(
        'relative flex w-14 flex-col items-center gap-0.5 rounded-md py-1.5 text-sidebar-foreground/65 transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
    >
      {active ? (
        <span className="bg-sidebar-foreground absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r" />
      ) : null}
      <span className="relative">
        <Icon className="size-5" />
        {attentionCount > 0 ? (
          <span
            aria-hidden="true"
            className="ring-sidebar absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500 ring-2"
          />
        ) : null}
      </span>
      <span className="max-w-full truncate text-[10px] leading-none font-medium">{label}</span>
    </button>
  )
}

function KeepAwakeButton({
  enabled,
  pending,
  onToggle
}: {
  enabled: boolean
  pending: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Keep computer awake: ${enabled ? 'on' : 'off'}`}
      aria-pressed={enabled}
      disabled={pending}
      onClick={onToggle}
      className={cn(
        'flex w-14 flex-col items-center gap-0.5 rounded-md py-1.5 text-sidebar-foreground/65 transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
        'disabled:pointer-events-none disabled:opacity-50',
        enabled && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
    >
      <CoffeeIcon className="size-5" />
      <span className="max-w-full truncate text-[10px] leading-none font-medium">Awake</span>
    </button>
  )
}

export function ActivityRail({
  activeView,
  onSelect
}: {
  activeView: AppView
  onSelect: (view: AppView) => void
}): React.JSX.Element {
  const { sessions, nativeById } = useTerminalSessions()
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false)
  const [keepAwakePending, setKeepAwakePending] = React.useState(true)
  const sessionsNeedingAction = React.useMemo(
    () =>
      sessions.filter((session) => {
        if (isTerminalSessionFinished(session.status)) return false
        return nativeSessionNeedsUserAction(session, nativeById[session.id])
      }).length,
    [nativeById, sessions]
  )

  React.useEffect(() => {
    let cancelled = false

    void window.api.system.getKeepAwake().then((result) => {
      if (cancelled) return
      setKeepAwakeEnabled(result.enabled)
      setKeepAwakePending(false)
      if (!result.ok) toast.error(`Could not read keep-awake state: ${result.error}`)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const handleKeepAwakeToggle = React.useCallback(async (): Promise<void> => {
    if (keepAwakePending) return
    setKeepAwakePending(true)
    const result = await window.api.system.setKeepAwake(!keepAwakeEnabled)
    setKeepAwakeEnabled(result.enabled)
    setKeepAwakePending(false)
    if (!result.ok) toast.error(`Could not change keep-awake state: ${result.error}`)
  }, [keepAwakeEnabled, keepAwakePending])

  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar z-20 flex h-[calc(100svh-1.25rem)] w-16 shrink-0 flex-col items-center border-r border-sidebar-border py-2"
    >
      <div className="flex flex-col gap-1">
        {TOP_ITEMS.map((item) => (
          <RailButton
            key={item.view}
            {...item}
            activeView={activeView}
            onSelect={onSelect}
            attentionCount={item.view === 'dashboard' ? sessionsNeedingAction : 0}
          />
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-1">
        <KeepAwakeButton
          enabled={keepAwakeEnabled}
          pending={keepAwakePending}
          onToggle={() => void handleKeepAwakeToggle()}
        />
        <RailButton
          view="settings"
          label="Settings"
          Icon={SettingsIcon}
          activeView={activeView}
          onSelect={onSelect}
        />
      </div>
    </nav>
  )
}
