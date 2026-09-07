import * as React from 'react'
import {
  MessageSquare as MessageSquareIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  SquareTerminal as SquareTerminalIcon,
  Sun as SunIcon
} from 'lucide-react'

import appIcon from '../assets/icon.png'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTheme, type Theme } from '@/contexts/theme-context'
import { cn } from '@/lib/utils'
import { getAppInfo } from '@/lib/system'
import type { AppInfo } from '@shared/system'
import { sessionLaunchModeLabel, type SessionLaunchMode } from '@shared/settings'

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon }
]

const SESSION_MODE_OPTIONS: ReadonlyArray<{
  value: SessionLaunchMode
  Icon: typeof SunIcon
}> = [
  { value: 'external', Icon: SquareTerminalIcon },
  { value: 'sdk', Icon: MessageSquareIcon }
]

function AppearanceSettings(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <section className="bg-card text-card-foreground flex w-full max-w-sm flex-col gap-3 rounded-2xl border px-6 py-5 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight">Appearance</h2>
        <p className="text-muted-foreground text-xs">Choose how DevTrees looks.</p>
      </div>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1"
      >
        {THEME_OPTIONS.map(({ value, label, Icon }) => {
          const isActive = theme === value
          return (
            <Button
              key={value}
              type="button"
              role="radio"
              aria-checked={isActive}
              variant={isActive ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTheme(value)}
              className={cn(
                'flex-col gap-1 h-auto py-2',
                isActive ? 'shadow-xs' : 'text-muted-foreground'
              )}
            >
              <Icon className="size-4" />
              <span className="text-xs font-medium">{label}</span>
            </Button>
          )
        })}
      </div>
    </section>
  )
}

function CopilotSessionSettings(): React.JSX.Element {
  const [mode, setMode] = React.useState<SessionLaunchMode | null>(null)
  const [busy, setBusy] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [loadRevision, setLoadRevision] = React.useState(0)

  React.useEffect(() => {
    let active = true
    void window.api.settings
      .sessionLaunchMode()
      .then((mode) => {
        if (active) setMode(mode)
      })
      .catch((error) => {
        if (active) setError(`Could not load the session setting: ${String(error)}`)
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [loadRevision])

  const save = async (next: SessionLaunchMode): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.setSessionLaunchMode(next)
      setMode(next)
    } catch (error) {
      setError(`Could not save the session setting: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="copilot-settings-title"
      className="bg-card text-card-foreground flex w-full max-w-sm flex-col gap-3 rounded-2xl border px-6 py-5 shadow-sm"
    >
      <div className="flex flex-col gap-1">
        <h2 id="copilot-settings-title" className="text-sm font-semibold tracking-tight">
          Copilot sessions
        </h2>
        <p id="session-launch-label" className="text-muted-foreground text-xs">
          Open new and resumed sessions in
        </p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="session-launch-label"
        aria-describedby="session-launch-help"
        aria-busy={busy}
        className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1"
      >
        {SESSION_MODE_OPTIONS.map(({ value, Icon }) => (
          <label key={value} className="min-w-0">
            <input
              type="radio"
              name="session-launch-mode"
              value={value}
              checked={mode === value}
              disabled={busy || mode === null}
              onChange={() => void save(value)}
              className="peer sr-only"
            />
            <span className="text-muted-foreground hover:bg-accent hover:text-accent-foreground peer-checked:bg-secondary peer-checked:text-secondary-foreground peer-checked:shadow-xs peer-focus-visible:ring-ring/50 flex h-full min-h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-2 py-2 text-center text-xs font-medium transition-colors peer-focus-visible:ring-3 peer-disabled:pointer-events-none peer-disabled:cursor-default peer-disabled:opacity-50">
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span>{sessionLaunchModeLabel(value)}</span>
            </span>
          </label>
        ))}
      </div>
      <p id="session-launch-help" className="text-muted-foreground text-xs leading-relaxed">
        Running sessions stay where they are. End a session before resuming it in a different mode.
        External sessions show live status only while DevTrees is open.
      </p>
      {busy && (
        <p role="status" className="text-muted-foreground text-xs">
          {mode === null ? 'Loading...' : 'Saving...'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {!busy && mode === null && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setBusy(true)
            setError(null)
            setLoadRevision((current) => current + 1)
          }}
        >
          Retry
        </Button>
      )}
    </section>
  )
}

export function SettingsPage(): React.JSX.Element {
  const [info, setInfo] = React.useState<AppInfo | null>(null)

  React.useEffect(() => {
    let active = true
    void getAppInfo().then((result) => {
      if (active) setInfo(result)
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto p-6 [&>section]:shrink-0">
      <section className="bg-card text-card-foreground flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border px-10 py-12 text-center shadow-sm">
        <img
          src={appIcon}
          alt={`${info?.name ?? 'App'} logo`}
          draggable={false}
          className="size-24 select-none rounded-2xl shadow-md ring-1 ring-black/5"
        />

        <div className="flex flex-col items-center gap-2">
          {info ? (
            <h1 className="text-2xl font-semibold tracking-tight">{info.name}</h1>
          ) : (
            <Skeleton className="h-7 w-32" />
          )}

          {info ? (
            <span className="bg-muted text-muted-foreground rounded-full border px-3 py-1 text-xs font-medium">
              v{info.version}
            </span>
          ) : (
            <Skeleton className="h-6 w-16 rounded-full" />
          )}
        </div>

        <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
          Manage your git worktrees and repositories for fast, parallel development.
        </p>
      </section>

      <CopilotSessionSettings />
      <AppearanceSettings />
    </div>
  )
}
