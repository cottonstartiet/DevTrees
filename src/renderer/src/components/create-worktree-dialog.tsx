import * as React from 'react'

import type { Repository } from '@shared/repository'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const VALID_NAME = /^[A-Za-z0-9._-]+$/
const MAX_NAME_LENGTH = 64

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')
}

function joinPath(parts: string[], style: 'win' | 'posix'): string {
  const sep = style === 'win' ? '\\' : '/'
  return parts.join(sep)
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (idx < 0) return p
  return p.slice(0, idx)
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return idx < 0 ? p : p.slice(idx + 1)
}

function computeHint(repositoryPath: string, name: string): string {
  const style = isWindowsPath(repositoryPath) ? 'win' : 'posix'
  const parent = dirname(repositoryPath)
  const wsName = basename(repositoryPath)
  const display = name.trim() || '<name>'
  return joinPath([parent, `${wsName}.worktrees`, display], style)
}

function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required.'
  if (trimmed.length > MAX_NAME_LENGTH) return `Name must be ≤ ${MAX_NAME_LENGTH} characters.`
  if (!VALID_NAME.test(trimmed))
    return 'Only letters, digits, dot, underscore, and hyphen are allowed.'
  return null
}

interface CreateWorktreeDialogProps {
  repository: Repository | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<boolean> | void
}

interface WorktreeFormProps {
  repository: Repository
  onSubmit: (name: string) => void
  onCancel: () => void
}

function WorktreeForm({ repository, onSubmit, onCancel }: WorktreeFormProps): React.JSX.Element {
  const [name, setName] = React.useState('')
  const [touched, setTouched] = React.useState(false)

  const error = validateName(name)
  const showError = touched && error !== null
  const hint = computeHint(repository.path, name)

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    setTouched(true)
    if (error) return
    onSubmit(name.trim())
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="worktree-name" className="text-sm font-medium">
          Name
        </label>
        <Input
          id="worktree-name"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (!touched) setTouched(true)
          }}
          placeholder="feature-x"
          aria-invalid={showError || undefined}
        />
        {showError ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Only letters, digits, dot, underscore, and hyphen.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Will be created at</span>
        <code className="bg-muted text-muted-foreground rounded px-2 py-1.5 font-mono text-xs break-all">
          {hint || '—'}
        </code>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={error !== null}>
          Create worktree
        </Button>
      </DialogFooter>
    </form>
  )
}

export function CreateWorktreeDialog({
  repository,
  open,
  onOpenChange,
  onSubmit
}: CreateWorktreeDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create worktree</DialogTitle>
          <DialogDescription>
            {repository
              ? `Adds a new git worktree to "${repository.name}". Runs in the background.`
              : 'Adds a new git worktree.'}
          </DialogDescription>
        </DialogHeader>

        {repository ? (
          <WorktreeForm
            key={`${repository.id}-${open ? 'o' : 'c'}`}
            repository={repository}
            onSubmit={(name) => {
              void onSubmit(name)
              onOpenChange(false)
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
