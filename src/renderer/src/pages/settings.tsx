import * as React from 'react'
import {
  Gamepad2 as GamepadIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  Sun as SunIcon
} from 'lucide-react'

import appIcon from '../assets/icon.png'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTheme, type Theme } from '@/contexts/theme-context'
import { cn } from '@/lib/utils'
import { getAppInfo } from '@/lib/system'
import type { AppInfo } from '@shared/system'

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'xbox', label: 'Xbox', Icon: GamepadIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon }
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
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
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
          Manage your git worktrees and workspaces for fast, parallel development.
        </p>
      </section>

      <AppearanceSettings />
    </div>
  )
}
