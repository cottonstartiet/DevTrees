import * as React from 'react'
import { GitBranchPlus as GitBranchPlusIcon } from 'lucide-react'

import { DashboardCard } from '@/components/detail/dashboard-card'
import { Button } from '@/components/ui/button'

export interface DetachedNudgePanelProps {
  onCreateBranch?: () => void
}

export function DetachedNudgePanel({ onCreateBranch }: DetachedNudgePanelProps): React.JSX.Element {
  return (
    <DashboardCard
      title="You're on a detached HEAD"
      description="Create a branch to start work you can commit, push, and turn into a pull request."
      className="border-amber-500/40 bg-amber-500/5"
    >
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onCreateBranch} disabled={!onCreateBranch} className="gap-1.5">
          <GitBranchPlusIcon className="size-3.5" />
          Create branch
        </Button>
        <p className="text-muted-foreground text-[11px]">
          Branches are named <span className="font-mono">users/&lt;alias&gt;/&lt;name&gt;</span>.
        </p>
      </div>
    </DashboardCard>
  )
}
