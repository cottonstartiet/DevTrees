import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Last path segment of a Windows or POSIX path (the folder/worktree name). */
export function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return idx < 0 ? p : p.slice(idx + 1)
}

/**
 * Display label for a Copilot session: prefer the worktree (folder) name, then the branch, then
 * fall back to the full folder path.
 */
export function sessionLabel(opts: {
  folderPath: string
  branch: string | null
  isWorktree: boolean
}): string {
  const worktreeName = opts.isWorktree ? baseName(opts.folderPath) : ''
  return worktreeName || opts.branch || opts.folderPath
}
