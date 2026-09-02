import { GaugeIcon } from 'lucide-react'

export function DashboardPage(): React.JSX.Element {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <GaugeIcon className="size-10 opacity-35" />
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">Dashboard</p>
        <p className="text-xs">Your developer cockpit overview will appear here.</p>
      </div>
    </div>
  )
}
