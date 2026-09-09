import * as React from 'react'
import {
  Bot as BotIcon,
  Info as InfoIcon,
  ListTodo as ListTodoIcon,
  MessageSquare as MessageSquareIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  Palette as PaletteIcon,
  SquareTerminal as SquareTerminalIcon,
  Sun as SunIcon
} from 'lucide-react'

import appIcon from '../assets/icon.png'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useTheme, type Theme } from '@/contexts/theme-context'
import { cn } from '@/lib/utils'
import { getAppInfo } from '@/lib/system'
import type { AppInfo } from '@shared/system'
import {
  sessionLaunchModeLabel,
  type SessionLaunchMode,
  type TaskQueueMode,
  type TaskQueueSettings
} from '@shared/settings'

type SettingsSection = 'copilot' | 'queue' | 'appearance' | 'about'

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon }
]

const SETTINGS_SECTIONS: ReadonlyArray<{
  value: SettingsSection
  label: string
  description: string
  Icon: typeof BotIcon
}> = [
  {
    value: 'copilot',
    label: 'Copilot',
    description: 'Session launch behavior',
    Icon: BotIcon
  },
  {
    value: 'queue',
    label: 'Task queue',
    description: 'Execution and concurrency',
    Icon: ListTodoIcon
  },
  {
    value: 'appearance',
    label: 'Appearance',
    description: 'Theme and display',
    Icon: PaletteIcon
  },
  {
    value: 'about',
    label: 'About',
    description: 'App and version details',
    Icon: InfoIcon
  }
]

const SESSION_MODE_OPTIONS: ReadonlyArray<{
  value: SessionLaunchMode
  Icon: typeof SunIcon
}> = [
  { value: 'external', Icon: SquareTerminalIcon },
  { value: 'acp', Icon: MessageSquareIcon }
]

const QUEUE_MODE_OPTIONS: ReadonlyArray<{
  value: TaskQueueMode
  label: string
  description: string
}> = [
  {
    value: 'automatic',
    label: 'Automatic',
    description: 'Start queued tasks whenever capacity is available.'
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Wait for Run queue before starting queued tasks.'
  }
]

function TaskQueueSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = React.useState<TaskQueueSettings | null>(null)
  const [concurrencyDraft, setConcurrencyDraft] = React.useState('2')
  const [busy, setBusy] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    void window.api.settings
      .taskQueue()
      .then((result) => {
        if (!active) return
        setSettings(result)
        setConcurrencyDraft(String(result.concurrency))
      })
      .catch((error) => {
        if (active) setError(`Could not load task queue settings: ${String(error)}`)
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [])

  const save = async (next: TaskQueueSettings): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.setTaskQueue(next)
      setSettings(next)
      setConcurrencyDraft(String(next.concurrency))
      window.dispatchEvent(new CustomEvent('task-queue-settings-changed', { detail: next }))
    } catch (error) {
      setError(`Could not save task queue settings: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const saveConcurrency = (): void => {
    if (!settings) return
    const parsed = Number(concurrencyDraft)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      setError('Concurrency must be a whole number between 1 and 10.')
      setConcurrencyDraft(String(settings.concurrency))
      return
    }
    if (parsed !== settings.concurrency) void save({ ...settings, concurrency: parsed })
  }

  return (
    <section aria-labelledby="queue-settings-title" className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 id="queue-settings-title" className="text-base font-semibold tracking-tight">
          Task queue
        </h1>
        <p className="text-muted-foreground text-sm">
          Control when queued To Do and Review tasks start.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h2 id="queue-mode-label" className="text-sm font-medium">
            Execution
          </h2>
          <p id="queue-mode-help" className="text-muted-foreground text-xs">
            Automatic mode keeps the queue moving. Manual mode starts only after an explicit run.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="queue-mode-label"
          aria-describedby="queue-mode-help"
          aria-busy={busy}
          className="grid grid-cols-2 gap-2"
        >
          {QUEUE_MODE_OPTIONS.map((option) => (
            <label key={option.value} className="min-w-0">
              <input
                type="radio"
                name="task-queue-mode"
                value={option.value}
                checked={settings?.mode === option.value}
                disabled={busy || settings === null}
                onChange={() => {
                  if (settings) void save({ ...settings, mode: option.value })
                }}
                className="peer sr-only"
              />
              <span className="text-muted-foreground hover:bg-accent hover:text-accent-foreground peer-checked:bg-secondary peer-checked:text-secondary-foreground peer-focus-visible:ring-ring/50 flex min-h-20 cursor-pointer flex-col justify-center gap-1 rounded-md border px-3 py-3 text-left transition-colors peer-focus-visible:ring-3 peer-disabled:pointer-events-none peer-disabled:opacity-50">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs leading-5">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-end justify-between gap-6 border-t pt-5">
        <div className="flex max-w-md flex-col gap-1">
          <label htmlFor="task-queue-concurrency" className="text-sm font-medium">
            Concurrency
          </label>
          <p id="task-queue-concurrency-help" className="text-muted-foreground text-xs leading-5">
            Maximum Copilot tasks running at the same time. New installations start at 2.
          </p>
        </div>
        <Input
          id="task-queue-concurrency"
          type="number"
          min={1}
          max={10}
          step={1}
          inputMode="numeric"
          aria-describedby="task-queue-concurrency-help"
          value={concurrencyDraft}
          disabled={busy || settings === null}
          onChange={(event) => setConcurrencyDraft(event.target.value)}
          onBlur={saveConcurrency}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          className="w-20"
        />
      </div>

      {busy && (
        <p role="status" className="text-muted-foreground text-xs">
          {settings === null ? 'Loading...' : 'Saving...'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </section>
  )
}

function AppearanceSettings(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <section aria-labelledby="appearance-settings-title" className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 id="appearance-settings-title" className="text-base font-semibold tracking-tight">
          Appearance
        </h1>
        <p className="text-muted-foreground text-sm">Choose how DevTrees looks on this device.</p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Theme</h2>
          <p id="theme-help" className="text-muted-foreground text-xs">
            Use a light or dark palette, or follow your Windows setting.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Theme"
          aria-describedby="theme-help"
          className="grid grid-cols-3 gap-2"
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => {
            const isActive = theme === value
            return (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                variant={isActive ? 'secondary' : 'outline'}
                onClick={() => setTheme(value)}
                className={cn(
                  'h-20 flex-col gap-2 px-3 shadow-none',
                  !isActive && 'text-muted-foreground'
                )}
              >
                <Icon className="size-4" />
                <span className="text-xs font-medium">{label}</span>
              </Button>
            )
          })}
        </div>
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
    <section aria-labelledby="copilot-settings-title" className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 id="copilot-settings-title" className="text-base font-semibold tracking-tight">
          Copilot
        </h1>
        <p className="text-muted-foreground text-sm">
          Configure how DevTrees opens Copilot sessions.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h2 id="session-launch-label" className="text-sm font-medium">
            Session launch mode
          </h2>
          <p id="session-launch-help" className="text-muted-foreground max-w-xl text-xs leading-5">
            Running sessions stay where they are. End a session before resuming it in a different
            mode. External sessions show live status only while DevTrees is open. In-app sessions
            use the configuration already set in Copilot CLI.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="session-launch-label"
          aria-describedby="session-launch-help"
          aria-busy={busy}
          className="grid grid-cols-2 gap-2"
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
              <span className="text-muted-foreground hover:bg-accent hover:text-accent-foreground peer-checked:bg-secondary peer-checked:text-secondary-foreground peer-focus-visible:ring-ring/50 flex h-20 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border px-3 text-center text-xs font-medium transition-colors peer-focus-visible:ring-3 peer-disabled:pointer-events-none peer-disabled:cursor-default peer-disabled:opacity-50">
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span>{sessionLaunchModeLabel(value)}</span>
              </span>
            </label>
          ))}
        </div>
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
            className="self-start"
            onClick={() => {
              setBusy(true)
              setError(null)
              setLoadRevision((current) => current + 1)
            }}
          >
            Retry
          </Button>
        )}
      </div>
    </section>
  )
}

function AboutSettings({ info }: { info: AppInfo | null }): React.JSX.Element {
  return (
    <section aria-labelledby="about-settings-title" className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 id="about-settings-title" className="text-base font-semibold tracking-tight">
          About
        </h1>
        <p className="text-muted-foreground text-sm">Application and version information.</p>
      </div>

      <div className="flex items-center gap-4 border-t pt-5">
        <img
          src={appIcon}
          alt=""
          draggable={false}
          className="size-16 shrink-0 select-none rounded-xl ring-1 ring-black/5"
        />
        <div className="min-w-0">
          {info ? (
            <>
              <h2 className="truncate text-base font-semibold tracking-tight">{info.name}</h2>
              <p className="text-muted-foreground mt-1 text-xs">Version {info.version}</p>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-20" />
            </div>
          )}
        </div>
      </div>

      <p className="text-muted-foreground max-w-xl text-sm leading-6">
        Manage git worktrees and repositories for fast, parallel development.
      </p>
    </section>
  )
}

export function SettingsPage(): React.JSX.Element {
  const [activeSection, setActiveSection] = React.useState<SettingsSection>('copilot')
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
    <div className="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)] overflow-hidden sm:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="bg-sidebar text-sidebar-foreground flex min-h-0 flex-col border-r">
        <nav
          aria-label="Settings sections"
          className="flex flex-col gap-1 overflow-y-auto p-2 pt-3"
        >
          {SETTINGS_SECTIONS.map(({ value, label, description, Icon }) => {
            const isActive = activeSection === value
            return (
              <button
                key={value}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setActiveSection(value)}
                className={cn(
                  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring/50 flex min-w-0 items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none',
                  isActive && 'bg-sidebar-accent text-sidebar-accent-foreground'
                )}
              >
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{label}</span>
                  <span className="text-muted-foreground mt-0.5 hidden truncate text-xs sm:block">
                    {description}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
          <div hidden={activeSection !== 'copilot'}>
            <CopilotSessionSettings />
          </div>
          <div hidden={activeSection !== 'appearance'}>
            <AppearanceSettings />
          </div>
          <div hidden={activeSection !== 'queue'}>
            <TaskQueueSettingsPanel />
          </div>
          <div hidden={activeSection !== 'about'}>
            <AboutSettings info={info} />
          </div>
        </div>
      </main>
    </div>
  )
}
