import type { ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function Section({
  title,
  description,
  children,
  actions,
  className = ''
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={`min-w-0 space-y-3 rounded-lg border bg-card p-4 ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <div className="max-w-[75ch] text-xs leading-relaxed text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}

export function Metric({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs leading-relaxed text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

export function Explanation({ text }: { text: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="How this is calculated"
          className="rounded px-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          How it works
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}
