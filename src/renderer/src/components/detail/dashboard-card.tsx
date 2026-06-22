import * as React from 'react'

import { cn } from '@/lib/utils'

export interface DashboardCardProps {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  contentClassName?: string
  children?: React.ReactNode
}

export function DashboardCard({
  title,
  description,
  actions,
  className,
  contentClassName,
  children
}: DashboardCardProps): React.JSX.Element {
  return (
    <section
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-3 rounded-lg border p-4 shadow-sm',
        className
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="truncate text-sm font-semibold tracking-tight">{title}</h3>
          {description ? (
            <div className="text-muted-foreground text-xs leading-snug">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      {children ? (
        <div className={cn('flex min-w-0 flex-col gap-2', contentClassName)}>{children}</div>
      ) : null}
    </section>
  )
}

export interface PlaceholderCardProps {
  title: string
  hint?: string
  className?: string
}

export function PlaceholderCard({
  title,
  hint,
  className
}: PlaceholderCardProps): React.JSX.Element {
  return (
    <DashboardCard title={title} className={className}>
      <p className="text-muted-foreground text-xs italic">{hint ?? 'Coming soon.'}</p>
    </DashboardCard>
  )
}
