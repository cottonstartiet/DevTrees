import * as React from 'react'
import { Loader2 as Loader2Icon } from 'lucide-react'

import type { Worktree, WorktreeStatusResult } from '@shared/worktree'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

export interface DeleteWorktreeDialogProps {
  worktree: Worktree | null
  repositoryName: string | null
  status: WorktreeStatusResult | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function DeleteWorktreeDialog({
  worktree,
  repositoryName,
  status,
  open,
  onOpenChange,
  onConfirm
}: DeleteWorktreeDialogProps): React.JSX.Element {
  const label = worktree ? worktreeLabel(worktree.path) : ''

  const checking = status === null
  const isError = !!status && !status.ok
  const folderMissing = !!status && status.ok && status.folderMissing === true
  const hasChanges = !!status && status.ok && status.hasChanges
  const hasUnreachable = !!status && status.ok && status.hasUnreachableCommits
  const canDelete =
    !!status && status.ok && !status.hasChanges && !status.hasUnreachableCommits

  let bodyTitle: string
  let bodyText: React.ReactNode
  if (checking) {
    bodyTitle = 'Checking for local changes…'
    bodyText = (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2Icon className="size-4 animate-spin" />
        <span>Inspecting the worktree…</span>
      </div>
    )
  } else if (isError) {
    bodyTitle = "Couldn't check worktree status"
    bodyText = (
      <p className="text-destructive text-sm break-words">
        {(status && !status.ok && status.message) || 'Unknown error.'}
      </p>
    )
  } else if (hasChanges) {
    bodyTitle = 'Uncommitted changes'
    bodyText = (
      <p className="text-sm">
        This worktree has uncommitted changes. Commit (or stash) them in{' '}
        <span className="font-medium">{label}</span> before deleting, then try again.
      </p>
    )
  } else if (hasUnreachable) {
    bodyTitle = 'Unreachable commits'
    bodyText = (
      <p className="text-sm">
        This worktree&apos;s detached <code className="bg-muted rounded px-1 font-mono">HEAD</code>{' '}
        has commits that aren&apos;t reachable from any branch or tag. Create a branch for them
        (e.g. <code className="bg-muted rounded px-1 font-mono">git switch -c &lt;name&gt;</code>)
        before deleting, or the commits will be lost.
      </p>
    )
  } else if (folderMissing) {
    bodyTitle = 'Worktree folder is missing'
    bodyText = (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          The worktree folder no longer exists on disk. Deleting will just unregister this stale
          entry from{' '}
          <span className="font-medium">{repositoryName ?? 'the repository'}</span> (via{' '}
          <code className="bg-muted rounded px-1 font-mono">git worktree prune</code>).
        </p>
        {worktree ? (
          <code className="bg-muted text-muted-foreground rounded px-2 py-1.5 font-mono text-xs break-all">
            {worktree.path}
          </code>
        ) : null}
      </div>
    )
  } else {
    bodyTitle = `Delete worktree "${label}"?`
    bodyText = (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          The worktree folder will be removed from disk and unregistered from{' '}
          <span className="font-medium">{repositoryName ?? 'the repository'}</span>.
        </p>
        {worktree ? (
          <code className="bg-muted text-muted-foreground rounded px-2 py-1.5 font-mono text-xs break-all">
            {worktree.path}
          </code>
        ) : null}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bodyTitle}</DialogTitle>
          <DialogDescription>
            {canDelete
              ? folderMissing
                ? 'The folder is already gone — only the git registration remains.'
                : 'This action cannot be undone.'
              : checking
                ? 'Please wait…'
                : 'Resolve the issue above and try again.'}
          </DialogDescription>
        </DialogHeader>

        <div>{bodyText}</div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {canDelete ? 'Cancel' : 'Close'}
          </Button>
          {canDelete ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                onConfirm()
                onOpenChange(false)
              }}
            >
              {folderMissing ? 'Unregister stale entry' : 'Delete worktree'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
