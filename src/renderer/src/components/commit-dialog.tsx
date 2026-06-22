import * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type CommitDialogMode = 'staged' | 'all'

interface CommitDialogProps {
  folderPath: string | null
  mode: CommitDialogMode
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (message: string, mode: CommitDialogMode) => void
}

interface CommitFormProps {
  mode: CommitDialogMode
  onSubmit: (message: string, mode: CommitDialogMode) => void
  onClose: () => void
}

function CommitForm({ mode, onSubmit, onClose }: CommitFormProps): React.JSX.Element {
  const [message, setMessage] = React.useState('')

  const trimmed = message.trim()
  const canSubmit = trimmed.length > 0

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (!canSubmit) return
    // Fire-and-forget: the commit runs in the background and reports completion
    // via an in-app notification. Close the dialog immediately.
    onSubmit(trimmed, mode)
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="commit-message" className="text-sm font-medium">
          Commit message
        </label>
        <textarea
          id="commit-message"
          autoFocus
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe your change"
          className={cn(
            'border-input dark:bg-input/30 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-y rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
        <p className="text-muted-foreground text-xs">
          First line is the subject by Git convention.
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {mode === 'all' ? 'Commit all changes' : 'Commit staged changes'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function CommitDialog({
  folderPath,
  mode,
  open,
  onOpenChange,
  onSubmit
}: CommitDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'all' ? 'Commit all changes' : 'Commit staged changes'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'all'
              ? 'Stages every change in the working tree (including untracked files) and commits.'
              : 'Commits the changes currently in the index.'}
          </DialogDescription>
        </DialogHeader>
        {folderPath && open ? (
          <CommitForm
            key={`${folderPath}-${mode}`}
            mode={mode}
            onSubmit={onSubmit}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
