import * as React from 'react'
import {
  Bot as BotIcon,
  FileText as FileTextIcon,
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useTheme, type ColorTheme, type Theme } from '@/contexts/theme-context'
import { cn } from '@/lib/utils'
import { getAppInfo } from '@/lib/system'
import { saveTaskQueueSettings } from '@/lib/task-queue-settings'
import type { AppInfo } from '@shared/system'
import {
  copilotPermissionProfileLabel,
  sessionLaunchModeLabel,
  type CopilotPermissionProfile,
  type SavedPrompt,
  type SessionLaunchMode,
  type TaskQueueMode,
  type TaskQueueSettings
} from '@shared/settings'

type SettingsSection = 'copilot' | 'prompts' | 'queue' | 'appearance' | 'about'

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon }
]

const COLOR_THEME_OPTIONS: ReadonlyArray<{
  value: ColorTheme
  label: string
  description: string
}> = [
  { value: 'chalk', label: 'Chalk', description: 'Quiet blue-gray surfaces with ink controls.' },
  { value: 'velocity', label: 'Velocity', description: 'Cool neutral surfaces with vivid blue.' }
]

type ThemePreviewColors = {
  background: string
  sidebar: string
  primary: string
  border: string
}

const COLOR_THEME_PREVIEWS: Record<
  ColorTheme,
  { light: ThemePreviewColors; dark: ThemePreviewColors }
> = {
  chalk: {
    light: {
      background: 'oklch(0.9745 0.0079 253.8524)',
      sidebar: 'oklch(0.9601 0.0103 261.7889)',
      primary: 'oklch(0.2038 0.0264 260.9332)',
      border: 'oklch(0.9013 0.0156 257.2001)'
    },
    dark: {
      background: 'oklch(0.2292 0.0304 259.0329)',
      sidebar: 'oklch(0.2452 0.0305 256.8649)',
      primary: 'oklch(0.8993 0.0119 239.9205)',
      border: 'oklch(0.3299 0.0322 257.6775)'
    }
  },
  velocity: {
    light: {
      background: 'oklch(0.9713 0.0053 286.3006)',
      sidebar: 'oklch(1 0 0)',
      primary: 'oklch(0.5607 0.2181 266.5346)',
      border: 'oklch(0.8947 0.0149 286.0941)'
    },
    dark: {
      background: 'oklch(0.1921 0.004 286.0181)',
      sidebar: 'oklch(0.2099 0.0039 286.0588)',
      primary: 'oklch(0.5607 0.2181 266.5346)',
      border: 'oklch(0.249 0.0056 285.9851)'
    }
  }
}

function PreviewHalf({ colors }: { colors: ThemePreviewColors }): React.JSX.Element {
  return (
    <span
      className="flex min-w-0 flex-1 overflow-hidden"
      style={{ backgroundColor: colors.background }}
    >
      <span
        className="w-5 shrink-0 border-r"
        style={{ backgroundColor: colors.sidebar, borderColor: colors.border }}
      />
      <span className="flex flex-1 items-center justify-center">
        <span className="h-2 w-7 rounded-sm" style={{ backgroundColor: colors.primary }} />
      </span>
    </span>
  )
}

function ColorThemeSwatch({ colorTheme }: { colorTheme: ColorTheme }): React.JSX.Element {
  const preview = COLOR_THEME_PREVIEWS[colorTheme]
  return (
    <span className="flex h-9 w-full overflow-hidden rounded-md border" aria-hidden>
      <PreviewHalf colors={preview.light} />
      <PreviewHalf colors={preview.dark} />
    </span>
  )
}

function ModeSwatch({
  theme,
  colorTheme
}: {
  theme: Theme
  colorTheme: ColorTheme
}): React.JSX.Element {
  const preview = COLOR_THEME_PREVIEWS[colorTheme]
  const modes = theme === 'system' ? [preview.light, preview.dark] : [preview[theme]]
  return (
    <span className="flex h-8 w-full overflow-hidden rounded-md border" aria-hidden>
      {modes.map((colors, index) => (
        <PreviewHalf key={`${theme}-${index}`} colors={colors} />
      ))}
    </span>
  )
}

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
    value: 'prompts',
    label: 'Saved prompts',
    description: 'Reusable agent instructions',
    Icon: FileTextIcon
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

type PromptDraft = {
  id: string | null
  name: string
  details: string
}

const EMPTY_PROMPT_DRAFT: PromptDraft = { id: null, name: '', details: '' }

function promptDraft(prompt: SavedPrompt): PromptDraft {
  return { id: prompt.id, name: prompt.name, details: prompt.details }
}

function SavedPromptsSettings(): React.JSX.Element {
  const [prompts, setPrompts] = React.useState<SavedPrompt[]>([])
  const [assignedId, setAssignedId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<PromptDraft>(EMPTY_PROMPT_DRAFT)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void Promise.all([
      window.api.settings.savedPrompts(),
      window.api.settings.browserCodeReviewPrompt()
    ])
      .then(([savedPrompts, browserPrompt]) => {
        if (!active) return
        setPrompts(savedPrompts)
        setAssignedId(browserPrompt.id)
        setDraft(savedPrompts[0] ? promptDraft(savedPrompts[0]) : EMPTY_PROMPT_DRAFT)
      })
      .catch((error) => {
        if (active) setError(`Could not load saved prompts: ${String(error)}`)
      })
      .finally(() => {
        if (active) {
          setLoaded(true)
          setBusy(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const selectedPrompt = draft.id
    ? (prompts.find((prompt) => prompt.id === draft.id) ?? null)
    : null
  const dirty = selectedPrompt
    ? draft.name !== selectedPrompt.name || draft.details !== selectedPrompt.details
    : Boolean(draft.name || draft.details)

  const selectPrompt = (prompt: SavedPrompt): void => {
    setDraft(promptDraft(prompt))
    setError(null)
  }

  const save = async (): Promise<void> => {
    const name = draft.name.trim()
    const details = draft.details.trim()
    if (!name) {
      setError('Prompt name is required.')
      return
    }
    if (!details) {
      setError('Prompt details are required.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const saved = draft.id
        ? await window.api.settings.updateSavedPrompt({ id: draft.id, name, details })
        : await window.api.settings.createSavedPrompt({ name, details })
      setPrompts((current) =>
        [...current.filter((prompt) => prompt.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      )
      setDraft(promptDraft(saved))
    } catch (error) {
      setError(`Could not save prompt: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const assign = async (): Promise<void> => {
    if (!draft.id || dirty) return
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.setBrowserCodeReviewPrompt(draft.id)
      setAssignedId(draft.id)
    } catch (error) {
      setError(`Could not assign prompt: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const deletePrompt = async (): Promise<void> => {
    if (!draft.id) return
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.deleteSavedPrompt(draft.id)
      const remaining = prompts.filter((prompt) => prompt.id !== draft.id)
      setPrompts(remaining)
      setDraft(remaining[0] ? promptDraft(remaining[0]) : EMPTY_PROMPT_DRAFT)
    } catch (error) {
      setError(`Could not delete prompt: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="saved-prompts-title" className="flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 id="saved-prompts-title" className="text-base font-semibold tracking-tight">
            Saved prompts
          </h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Keep reusable agent instructions in DevTrees and choose which one starts browser code
            reviews.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDraft(EMPTY_PROMPT_DRAFT)
            setError(null)
          }}
        >
          New prompt
        </Button>
      </div>

      <div className="grid min-h-[28rem] grid-cols-[minmax(10rem,15rem)_minmax(0,1fr)] border-t">
        <div className="flex min-w-0 flex-col gap-1 border-r py-4 pr-4">
          {!loaded ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : prompts.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-xs">
              No saved prompts. Create one to get started.
            </p>
          ) : (
            prompts.map((prompt) => {
              const selected = draft.id === prompt.id
              return (
                <button
                  key={prompt.id}
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => selectPrompt(prompt)}
                  className={cn(
                    'hover:bg-accent focus-visible:ring-ring/50 flex min-w-0 flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none',
                    selected && 'bg-secondary'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {prompt.name}
                    </span>
                    {assignedId === prompt.id ? (
                      <span className="bg-primary text-primary-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                        Browser
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground line-clamp-2 text-xs leading-4">
                    {prompt.details}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5 py-4 pl-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="saved-prompt-name" className="text-sm font-medium">
              Short name
            </label>
            <Input
              id="saved-prompt-name"
              maxLength={80}
              value={draft.name}
              disabled={busy}
              placeholder="Code review"
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <label htmlFor="saved-prompt-details" className="text-sm font-medium">
              Prompt details
            </label>
            <Textarea
              id="saved-prompt-details"
              value={draft.details}
              disabled={busy}
              placeholder="Write the instructions Copilot should follow..."
              className="min-h-64 flex-1 resize-y"
              onChange={(event) =>
                setDraft((current) => ({ ...current, details: event.target.value }))
              }
            />
            <p className="text-muted-foreground text-xs leading-5">
              Browser reviews support {'{{url}}'}, {'{{pageTitle}}'}, and {'{{host}}'} placeholders.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div>
              {draft.id ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy || assignedId === draft.id}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {draft.id && assignedId !== draft.id ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || dirty}
                  onClick={() => void assign()}
                >
                  Use for browser reviews
                </Button>
              ) : assignedId === draft.id && draft.id ? (
                <span className="text-muted-foreground self-center text-xs">
                  Used for browser reviews
                </span>
              ) : null}
              {dirty && selectedPrompt ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDraft(promptDraft(selectedPrompt))}
                >
                  Cancel
                </Button>
              ) : null}
              <Button type="button" size="sm" disabled={busy || !dirty} onClick={() => void save()}>
                {busy ? 'Saving...' : 'Save prompt'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete saved prompt?"
        description={
          draft.name
            ? `“${draft.name}” will be permanently removed.`
            : 'This prompt will be permanently removed.'
        }
        confirmLabel="Delete prompt"
        confirmVariant="destructive"
        onConfirm={() => void deletePrompt()}
      />
    </section>
  )
}

const SESSION_MODE_OPTIONS: ReadonlyArray<{
  value: SessionLaunchMode
  Icon: typeof SunIcon
}> = [
  { value: 'external', Icon: SquareTerminalIcon },
  { value: 'acp', Icon: MessageSquareIcon }
]

const PERMISSION_PROFILE_OPTIONS: ReadonlyArray<{
  value: CopilotPermissionProfile
  description: string
}> = [
  {
    value: 'default',
    description: 'Ask when Copilot needs access not already saved for the project.'
  },
  {
    value: 'allow-all',
    description: 'Approve all tools, paths, and URLs when an in-app session starts.'
  }
]

const QUEUE_MODE_OPTIONS: ReadonlyArray<{
  value: TaskQueueMode
  label: string
  description: string
}> = [
  {
    value: 'automatic',
    label: 'Automatic',
    description: 'Start the next To Do or Review task whenever capacity is available.'
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Start work only when you move a task to In Progress or Review.'
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
      await saveTaskQueueSettings(next)
      setSettings(next)
      setConcurrencyDraft(String(next.concurrency))
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
          Control global task concurrency while keeping each repository worktree conflict-free.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h2 id="queue-mode-label" className="text-sm font-medium">
            Execution
          </h2>
          <p id="queue-mode-help" className="text-muted-foreground text-xs">
            Automatic mode fills available slots from the queue. Manual mode uses board moves as the
            start action.
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
            Maximum tasks running across all worktrees. Tasks for the same worktree run one at a
            time. The default is 2.
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

      <div className="flex flex-col gap-1 border-t pt-5">
        <h2 className="text-sm font-medium">Manual transitions</h2>
        <p className="text-muted-foreground max-w-prose text-xs leading-5">
          In Manual mode, moving a To Do task to In Progress starts its Copilot session; moving an
          In Progress task to Review starts its code review. These starts still respect the
          concurrency limit and wait for the selected worktree to be free.
        </p>
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
  const { theme, colorTheme, setTheme, setColorTheme } = useTheme()

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
          <h2 className="text-sm font-medium">Color theme</h2>
          <p id="color-theme-help" className="text-muted-foreground text-xs">
            Choose the palette used across DevTrees.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Color theme"
          aria-describedby="color-theme-help"
          className="grid grid-cols-2 gap-2"
        >
          {COLOR_THEME_OPTIONS.map(({ value, label, description }) => {
            const isActive = colorTheme === value
            return (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                variant={isActive ? 'secondary' : 'outline'}
                onClick={() => setColorTheme(value)}
                className={cn(
                  'h-auto min-h-28 flex-col items-stretch gap-2 px-3 py-3 text-left shadow-none',
                  isActive && 'border border-primary/50 ring-primary/20 ring-2',
                  !isActive && 'text-muted-foreground'
                )}
              >
                <ColorThemeSwatch colorTheme={value} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">{label}</span>
                  <span className="text-muted-foreground text-[11px] font-normal">
                    {description}
                  </span>
                </span>
              </Button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Mode</h2>
          <p id="theme-mode-help" className="text-muted-foreground text-xs">
            Use a light or dark palette, or follow your Windows setting.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Theme mode"
          aria-describedby="theme-mode-help"
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
                  'h-24 flex-col gap-2 px-3 shadow-none',
                  isActive && 'border border-primary/50 ring-primary/20 ring-2',
                  !isActive && 'text-muted-foreground'
                )}
              >
                <ModeSwatch theme={value} colorTheme={colorTheme} />
                <span className="flex items-center gap-1.5">
                  <Icon className="size-3.5" />
                  <span className="text-xs font-medium">{label}</span>
                </span>
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
  const [permissionProfile, setPermissionProfile] = React.useState<CopilotPermissionProfile | null>(
    null
  )
  const [busy, setBusy] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [loadRevision, setLoadRevision] = React.useState(0)

  React.useEffect(() => {
    let active = true
    void Promise.all([
      window.api.settings.sessionLaunchMode(),
      window.api.settings.copilotPermissionProfile()
    ])
      .then(([mode, profile]) => {
        if (active) {
          setMode(mode)
          setPermissionProfile(profile)
        }
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

  const savePermissionProfile = async (next: CopilotPermissionProfile): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.setCopilotPermissionProfile(next)
      setPermissionProfile(next)
    } catch (error) {
      setError(`Could not save the permission profile: ${String(error)}`)
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
            use the permission profile below plus project approvals already saved by Copilot CLI.
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

      <div className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h2 id="permission-profile-label" className="text-sm font-medium">
            In-app permission profile
          </h2>
          <p
            id="permission-profile-help"
            className="text-muted-foreground max-w-xl text-xs leading-5"
          >
            Applies when a session starts and stays attached to that conversation when resumed.
            Copilot still owns project-scoped remembered approvals in its local permission store.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="permission-profile-label"
          aria-describedby="permission-profile-help"
          aria-busy={busy}
          className="grid grid-cols-2 gap-2"
        >
          {PERMISSION_PROFILE_OPTIONS.map((option) => (
            <label key={option.value} className="min-w-0">
              <input
                type="radio"
                name="copilot-permission-profile"
                value={option.value}
                checked={permissionProfile === option.value}
                disabled={busy || permissionProfile === null}
                onChange={() => void savePermissionProfile(option.value)}
                className="peer sr-only"
              />
              <span className="text-muted-foreground hover:bg-accent hover:text-accent-foreground peer-checked:bg-secondary peer-checked:text-secondary-foreground peer-focus-visible:ring-ring/50 flex min-h-20 cursor-pointer flex-col justify-center gap-1 rounded-md border px-3 py-3 text-left transition-colors peer-focus-visible:ring-3 peer-disabled:pointer-events-none peer-disabled:cursor-default peer-disabled:opacity-50">
                <span className="text-sm font-medium">
                  {copilotPermissionProfileLabel(option.value)}
                </span>
                <span className="text-xs leading-5">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        {permissionProfile === 'allow-all' && (
          <p className="text-muted-foreground max-w-xl text-xs leading-5">
            New in-app sessions will not show approval prompts. Use this only for repositories and
            tools you trust.
          </p>
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
          <div hidden={activeSection !== 'prompts'}>
            <SavedPromptsSettings />
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
