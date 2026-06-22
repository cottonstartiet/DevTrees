import * as React from 'react'

import type { Workspace } from '@shared/workspace'
import type { Worktree } from '@shared/worktree'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getUserAlias } from '@/lib/repo'
import { cn } from '@/lib/utils'

const VALID_SUFFIX = /^[A-Za-z0-9._-]+$/
const MAX_SUFFIX_LENGTH = 64

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

function defaultSuffixFromWorktree(path: string): string {
  const label = worktreeLabel(path).trim()
  // Replace any chars not allowed by VALID_SUFFIX with '-', collapse repeats,
  // strip leading/trailing dashes, and cap length so the default already passes validation.
  const sanitized = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized.slice(0, MAX_SUFFIX_LENGTH)
}

function validateSuffix(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required.'
  if (trimmed.length > MAX_SUFFIX_LENGTH)
    return `Name must be ≤ ${MAX_SUFFIX_LENGTH} characters.`
  if (!VALID_SUFFIX.test(trimmed))
    return 'Only letters, digits, dot, underscore, and hyphen are allowed.'
  return null
}

interface CreateBranchDialogProps {
  workspace: Workspace | null
  worktree: Worktree | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (fullBranchName: string) => Promise<boolean> | void
}

interface BranchFormProps {
  workspace: Workspace
  worktree: Worktree
  onSubmit: (fullBranchName: string) => void
  onCancel: () => void
}

function BranchForm({
  workspace,
  worktree,
  onSubmit,
  onCancel
}: BranchFormProps): React.JSX.Element {
  const [suffix, setSuffix] = React.useState(() => defaultSuffixFromWorktree(worktree.path))
  const [touched, setTouched] = React.useState(false)
  const [alias, setAlias] = React.useState<string | null>(null)
  const [aliasError, setAliasError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setAlias(null)
    setAliasError(null)
    getUserAlias(workspace.path)
      .then((value) => {
        if (cancelled) return
        if (value) {
          setAlias(value)
        } else {
          setAliasError('Could not determine your alias.')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setAliasError(err instanceof Error ? err.message : 'Could not determine your alias.')
      })
    return () => {
      cancelled = true
    }
  }, [workspace.path])

  const error = validateSuffix(suffix)
  const showError = touched && error !== null
  const aliasReady = alias !== null
  const fullName = aliasReady ? `users/${alias}/${suffix.trim()}` : ''
  const previewName = aliasReady
    ? `users/${alias}/${suffix.trim() || '<name>'}`
    : `users/…/${suffix.trim() || '<name>'}`

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    setTouched(true)
    if (!aliasReady || error) return
    onSubmit(fullName)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="branch-suffix" className="text-sm font-medium">
          Branch name
        </label>
        <div
          className={cn(
            'border-input dark:bg-input/30 flex h-9 w-full min-w-0 items-center rounded-md border bg-transparent text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm',
            'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
            showError &&
              'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 border-destructive ring-destructive/20 dark:ring-destructive/40 ring-[3px]'
          )}
          aria-invalid={showError || undefined}
        >
          <span className="text-muted-foreground pointer-events-none flex h-full items-center px-3 font-mono text-xs select-none">
            {aliasReady ? `users/${alias}/` : 'users/…/'}
          </span>
          <input
            id="branch-suffix"
            autoFocus
            value={suffix}
            disabled={!aliasReady}
            onChange={(e) => {
              setSuffix(e.target.value)
              if (!touched) setTouched(true)
            }}
            onFocus={(e) => {
              e.currentTarget.select()
            }}
            placeholder="feature-x"
            className="placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground h-full w-full min-w-0 flex-1 border-0 bg-transparent pr-3 py-1 text-base outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
          />
        </div>
        {showError ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : aliasError ? (
          <p className="text-destructive text-xs">{aliasError}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Only letters, digits, dot, underscore, and hyphen.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Will create branch</span>
        <code className="bg-muted text-muted-foreground rounded px-2 py-1.5 font-mono text-xs break-all">
          {previewName}
        </code>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!aliasReady || error !== null}>
          Create branch
        </Button>
      </DialogFooter>
    </form>
  )
}

export function CreateBranchDialog({
  workspace,
  worktree,
  open,
  onOpenChange,
  onSubmit
}: CreateBranchDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create branch</DialogTitle>
          <DialogDescription>
            {worktree
              ? `Creates a new git branch at the current commit of "${worktreeLabel(
                  worktree.path
                )}" and switches the worktree to it.`
              : 'Creates a new git branch in the current worktree.'}
          </DialogDescription>
        </DialogHeader>

        {workspace && worktree ? (
          <BranchForm
            key={`${worktree.path}-${open ? 'o' : 'c'}`}
            workspace={workspace}
            worktree={worktree}
            onSubmit={(fullName) => {
              void onSubmit(fullName)
              onOpenChange(false)
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
