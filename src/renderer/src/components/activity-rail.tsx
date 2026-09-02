import * as React from 'react'
import {
  FolderGit2Icon,
  GaugeIcon,
  HistoryIcon,
  MessageSquareTextIcon,
  SettingsIcon,
  SquareTerminalIcon
} from 'lucide-react'

import type { AppView } from '@/components/app-sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const TOP_ITEMS: ReadonlyArray<{
  view: AppView
  label: string
  Icon: typeof GaugeIcon
}> = [
  { view: 'dashboard', label: 'Dashboard', Icon: GaugeIcon },
  { view: 'chat', label: 'Chat', Icon: MessageSquareTextIcon },
  { view: 'repositories', label: 'Repositories', Icon: FolderGit2Icon },
  { view: 'sessions', label: 'Sessions', Icon: SquareTerminalIcon },
  { view: 'history', label: 'History', Icon: HistoryIcon }
]

function RailButton({
  view,
  label,
  Icon,
  activeView,
  onSelect
}: {
  view: AppView
  label: string
  Icon: typeof GaugeIcon
  activeView: AppView
  onSelect: (view: AppView) => void
}): React.JSX.Element {
  const active = view === activeView
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelect(view)}
          className={cn(
            'relative flex size-10 items-center justify-center rounded-md text-sidebar-foreground/65 transition-colors',
            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
            active && 'bg-sidebar-accent text-sidebar-accent-foreground'
          )}
        >
          {active ? (
            <span className="bg-sidebar-foreground absolute left-0 h-5 w-0.5 rounded-r" />
          ) : null}
          <Icon className="size-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function ActivityRail({
  activeView,
  onSelect
}: {
  activeView: AppView
  onSelect: (view: AppView) => void
}): React.JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar z-20 flex h-[calc(100svh-1.25rem)] w-12 shrink-0 flex-col items-center border-r border-sidebar-border py-2"
    >
      <div className="flex flex-col gap-1">
        {TOP_ITEMS.map((item) => (
          <RailButton key={item.view} {...item} activeView={activeView} onSelect={onSelect} />
        ))}
      </div>
      <div className="mt-auto">
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
