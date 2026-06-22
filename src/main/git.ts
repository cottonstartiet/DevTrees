import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type GitResult = {
  stdout: string
  stderr: string
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    })
    return { stdout, stderr }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
    const stderr = e.stderr ?? ''
    const stdout = e.stdout ?? ''
    const message = stderr.trim() || stdout.trim() || e.message || 'git failed'
    throw new GitError(message, stderr, typeof e.code === 'number' ? e.code : null)
  }
}
