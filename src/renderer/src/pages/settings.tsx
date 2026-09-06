import * as React from 'react'
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  RefreshCwIcon,
  Sun as SunIcon,
  XCircleIcon
} from 'lucide-react'
import { toast } from 'sonner'

import appIcon from '../assets/icon.png'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTheme, type Theme } from '@/contexts/theme-context'
import { cn } from '@/lib/utils'
import { getAppInfo } from '@/lib/system'
import type { AppInfo } from '@shared/system'
import type { HostSettings, HostStatus, ToolAvailability, UpdateStatus } from '@shared/settings'

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon }
]

function AvailabilityRow({
  label,
  tool
}: {
  label: string
  tool: ToolAvailability | undefined
}): React.JSX.Element {
  if (!tool) return <Skeleton className="h-8 w-full" />
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {tool.available ? (
          <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircleIcon className="text-destructive size-4 shrink-0" />
        )}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <span className="text-muted-foreground truncate text-right font-mono text-xs">
        {tool.available ? tool.version || 'Available' : tool.error || 'Not found on PATH'}
      </span>
    </div>
  )
}

function AppearanceSettings(): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Appearance</h2>
        <p className="text-muted-foreground text-xs">Stored in this browser.</p>
      </div>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="bg-muted grid grid-cols-3 gap-1 rounded-lg p-1"
      >
        {THEME_OPTIONS.map(({ value, label, Icon }) => {
          const active = theme === value
          return (
            <Button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTheme(value)}
              className={cn(
                'h-auto flex-col gap-1 py-2',
                active ? 'shadow-xs' : 'text-muted-foreground'
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

export function SettingsPage(): React.JSX.Element {
  const [info, setInfo] = React.useState<AppInfo | null>(null)
  const [settings, setSettings] = React.useState<HostSettings | null>(null)
  const [host, setHost] = React.useState<HostStatus | null>(null)
  const [update, setUpdate] = React.useState<UpdateStatus | null>(null)
  const [checking, setChecking] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    const [nextInfo, nextSettings, nextHost, nextUpdate] = await Promise.all([
      getAppInfo(),
      window.api.settings.get(),
      window.api.settings.hostStatus(),
      window.api.updater.status()
    ])
    setInfo(nextInfo)
    setSettings(nextSettings)
    setHost(nextHost)
    setUpdate(nextUpdate)
  }, [])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((error) => toast.error(String(error)))
    }, 0)
    const unsubscribe = window.api.updater.onUpdate(setUpdate)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [refresh])

  const toggleAutostart = async (): Promise<void> => {
    if (!settings) return
    try {
      setSettings(await window.api.settings.update({ launchAtSignIn: !settings.launchAtSignIn }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update launch at sign-in.')
    }
  }

  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      const status = await window.api.updater.check()
      setUpdate(status)
      if (status.state === 'current') toast.success('DevTrees is up to date.')
      if (status.state === 'error') toast.error(status.error ?? 'Update check failed.')
    } finally {
      setChecking(false)
    }
  }

  const installUpdate = async (): Promise<void> => {
    const toastId = toast.loading(`Installing DevTrees ${update?.version ?? 'update'}…`)
    try {
      const status = await window.api.updater.install()
      setUpdate(status)
      if (status.state === 'error') {
        toast.error(status.error ?? 'Update installation failed.', { id: toastId })
      } else {
        toast.success('Update installer started. DevTrees will restart.', { id: toastId })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Update installation failed.', {
        id: toastId
      })
    }
  }

  return (
    <div className="flex flex-1 justify-center overflow-y-auto p-6">
      <div className="w-full max-w-2xl space-y-6">
        <header className="flex items-center gap-4 border-b pb-5">
          <img
            src={appIcon}
            alt=""
            draggable={false}
            className="size-14 select-none rounded-xl ring-1 ring-black/10"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight">{info?.name ?? 'DevTrees'}</h1>
            <p className="text-muted-foreground text-sm">
              Windows tray host · {info ? `v${info.version}` : 'Loading version…'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.api.settings.openBrowser('/')}
          >
            <ExternalLinkIcon className="size-3.5" />
            Reopen UI
          </Button>
        </header>

        <AppearanceSettings />

        <section className="space-y-3 border-t pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Background host</h2>
              <p className="text-muted-foreground max-w-lg text-xs">
                Monitoring continues in the tray when every browser tab is closed.
              </p>
            </div>
            <Button
              size="sm"
              variant={settings?.launchAtSignIn ? 'default' : 'outline'}
              disabled={!settings}
              onClick={() => void toggleAutostart()}
              aria-pressed={settings?.launchAtSignIn ?? false}
            >
              Start at sign-in: {settings?.launchAtSignIn ? 'On' : 'Off'}
            </Button>
          </div>
          <dl className="divide-y rounded-lg border px-3">
            <div className="flex items-center justify-between gap-4 py-2">
              <dt className="text-sm font-medium">Local server</dt>
              <dd className="text-muted-foreground truncate font-mono text-xs">
                {host?.localUrl ?? 'Unavailable'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-2">
              <dt className="text-sm font-medium">Connected browser tabs</dt>
              <dd className="text-muted-foreground text-xs">{host?.browserClients ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="space-y-2 border-t pt-5">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Terminal prerequisites</h2>
            <p className="text-muted-foreground text-xs">
              Copilot stays interactive in Windows Terminal and must already be installed and
              authenticated.
            </p>
          </div>
          <div className="divide-y rounded-lg border px-3">
            <AvailabilityRow label="Windows Terminal" tool={host?.windowsTerminal} />
            <AvailabilityRow label="GitHub Copilot CLI" tool={host?.copilotCli} />
          </div>
        </section>

        <section className="flex items-center justify-between gap-4 border-t pt-5">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Updates</h2>
            <p className="text-muted-foreground text-xs">
              {update?.state === 'available' && update.version
                ? `Version ${update.version} is ready to install.`
                : update?.state === 'error'
                  ? update.error
                  : 'Signed updates are checked by the tray host.'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() =>
              void (update?.state === 'available' ? installUpdate() : checkForUpdates())
            }
          >
            {update?.state === 'available' ? (
              <ExternalLinkIcon className="size-3.5" />
            ) : (
              <RefreshCwIcon className={cn('size-3.5', checking && 'animate-spin')} />
            )}
            {update?.state === 'available' ? 'Install update' : 'Check now'}
          </Button>
        </section>
      </div>
    </div>
  )
}
