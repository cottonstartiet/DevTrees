import * as React from 'react'

import type { Repository } from '@shared/repository'
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

const VALID_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/
const MAX_BRANCH_NAME_LENGTH = 200

function worktreeLabel(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

function defaultSuffixFromWorktree(path: string): string {
  const label = worktreeLabel(path).trim()
  // Replace any chars not allowed in the generated suffix with '-', collapse repeats,
  // strip leading/trailing dashes, and cap length so the default already passes validation.
  const sanitized = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized.slice(0, MAX_BRANCH_NAME_LENGTH)
}

function validateBranchName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Branch name is required.'
  if (trimmed.length > MAX_BRANCH_NAME_LENGTH)
    return `Branch name must be ${MAX_BRANCH_NAME_LENGTH} characters or fewer.`
  if (!VALID_BRANCH_NAME.test(trimmed))
    return 'Use only letters, digits, dot, underscore, hyphen, and slash.'
  if (trimmed.includes('..')) return 'Branch name cannot contain two consecutive dots.'
  if (trimmed.startsWith('/') || trimmed.endsWith('/'))
    return 'Branch name cannot start or end with a slash.'
  return null
}

interface CreateBranchDialogProps {
  repository: Repository | null
  worktree: Worktree | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (fullBranchName: string) => Promise<boolean> | void
}

interface BranchFormProps {
  repository: Repository
  worktree: Worktree
  onSubmit: (fullBranchName: string) => void
  onCancel: () => void
}

function BranchForm({
  repository,
  worktree,
  onSubmit,
  onCancel
}: BranchFormProps): React.JSX.Element {
  const [branchName, setBranchName] = React.useState('')
  const [touched, setTouched] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [aliasSnapshot, setAliasSnapshot] = React.useState<{
    repositoryPath: string
    alias: string | null
    error: string | null
  }>(() => ({ repositoryPath: repository.path, alias: null, error: null }))

  const isAliasCurrent = aliasSnapshot.repositoryPath === repository.path
  const alias = isAliasCurrent ? aliasSnapshot.alias : null
  const aliasError = isAliasCurrent ? aliasSnapshot.error : null
  const aliasReady = alias !== null

  React.useEffect(() => {
    let cancelled = false
    getUserAlias(repository.path)
      .then((value) => {
        if (cancelled) return
        const alias = value || null
        setAliasSnapshot({
          repositoryPath: repository.path,
          alias,
          error: alias ? null : 'Could not determine your alias.'
        })
        if (alias) {
          setBranchName(`users/${alias}/${defaultSuffixFromWorktree(worktree.path)}`)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setAliasSnapshot({
          repositoryPath: repository.path,
          alias: null,
          error: err instanceof Error ? err.message : 'Could not determine your alias.'
        })
      })
    return () => {
      cancelled = true
    }
  }, [repository.path, worktree.path])

  React.useEffect(() => {
    if (!aliasReady) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [aliasReady])

  const error = validateBranchName(branchName)
  const showError = touched && error !== null

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    setTouched(true)
    if (!aliasReady || error) return
    onSubmit(branchName.trim())
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="branch-name" className="text-sm font-medium">
          Branch name
        </label>
        <input
          ref={inputRef}
          id="branch-name"
          value={branchName}
          disabled={!aliasReady}
          aria-invalid={showError || undefined}
          onChange={(e) => {
            setBranchName(e.target.value)
            if (!touched) setTouched(true)
          }}
          onFocus={(e) => {
            e.currentTarget.select()
          }}
          placeholder="users/alias/feature-x"
          className="border-input dark:bg-input/30 placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 font-mono text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] aria-invalid:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
        />
        {showError ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : aliasError ? (
          <p className="text-destructive text-xs">{aliasError}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Letters, digits, dot, underscore, hyphen, and slash.
          </p>
        )}
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
  repository,
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

        {repository && worktree ? (
          <BranchForm
            key={`${worktree.path}-${open ? 'o' : 'c'}`}
            repository={repository}
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
