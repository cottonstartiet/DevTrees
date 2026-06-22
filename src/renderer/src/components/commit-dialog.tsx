import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTasks } from '@/contexts/tasks-context'
import { commit } from '@/lib/repo'
import { cn } from '@/lib/utils'

export type CommitDialogMode = 'staged' | 'all'

interface CommitDialogProps {
  folderPath: string | null
  mode: CommitDialogMode
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommitted?: () => void
}

interface CommitFormProps {
  folderPath: string
  mode: CommitDialogMode
  submitting: boolean
  onSubmittingChange: (submitting: boolean) => void
  onCommitted?: () => void
  onClose: () => void
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function CommitForm({
  folderPath,
  mode,
  submitting,
  onSubmittingChange,
  onCommitted,
  onClose
}: CommitFormProps): React.JSX.Element {
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const { startTask, succeedTask, failTask } = useTasks()

  const trimmed = message.trim()
  const canSubmit = trimmed.length > 0 && !submitting

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    if (!canSubmit) return
    onSubmittingChange(true)
    setError(null)
    const label = mode === 'all' ? 'Committing all changes' : 'Committing staged changes'
    const taskId = startTask(label)
    try {
      const result = await commit({
        folderPath,
        message: trimmed,
        stageAll: mode === 'all'
      })
      if (result.ok) {
        succeedTask(taskId)
        toast.success(`Committed ${shortSha(result.commitSha)}`)
        onCommitted?.()
        onClose()
        return
      }
      failTask(taskId, result.error)
      if (result.code === 'nothing-to-commit') {
        toast.message('Nothing to commit.')
        onClose()
        return
      }
      setError(result.error)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'commit failed'
      failTask(taskId, message)
      setError(message)
    } finally {
      onSubmittingChange(false)
    }
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
          onChange={(e) => {
            setMessage(e.target.value)
            if (error) setError(null)
          }}
          placeholder="Describe your change"
          className={cn(
            'border-input dark:bg-input/30 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-y rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50'
          )}
          disabled={submitting}
        />
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            First line is the subject by Git convention.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {submitting
            ? 'Committing…'
            : mode === 'all'
              ? 'Commit all changes'
              : 'Commit staged changes'}
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
  onCommitted
}: CommitDialogProps): React.JSX.Element {
  const [submitting, setSubmitting] = React.useState(false)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (submitting && !nextOpen) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (submitting) e.preventDefault()
        }}
      >
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
            folderPath={folderPath}
            mode={mode}
            submitting={submitting}
            onSubmittingChange={setSubmitting}
            onCommitted={onCommitted}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
