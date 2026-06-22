import * as React from 'react'

import appIcon from '../assets/icon.png'
import { Skeleton } from '@/components/ui/skeleton'
import { getAppInfo } from '@/lib/system'
import type { AppInfo } from '@shared/system'

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
    <div className="flex flex-1 items-center justify-center">
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
    </div>
  )
}
