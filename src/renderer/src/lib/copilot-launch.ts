import { useCallback } from 'react'

import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
export type CopilotLaunchOptions = {
  folderPath: string
  /** Initial prompt for a fresh session. Ignored when `resumeSessionId` is set. */
  prompt?: string
  /** Resume an existing Copilot session by id instead of starting a fresh one. */
  resumeSessionId?: string
  /** Human-readable label for the session in the sidebar. */
  label: string
  /** Git branch checked out in the worktree, when known. */
  branch?: string
  /** Repository / project name, when known. Shown as the sidebar's secondary line. */
  repository?: string
  /** Kanban task this launch belongs to, so a monitored terminal traces back to its task. */
  taskId?: string
}

/** `sessionId` is the Copilot CLI session id the app is now mirroring. */
export type CopilotLaunchResult = { ok: true; sessionId: string } | { ok: false; error: string }

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

/**
 * All launch sites use the backend's saved Settings choice, including resume.
 */
export function useCopilotLauncher(): (opts: CopilotLaunchOptions) => Promise<CopilotLaunchResult> {
  const { start } = useTerminalSessions()

  return useCallback(
    async (opts: CopilotLaunchOptions): Promise<CopilotLaunchResult> => {
      const { folderPath, prompt, resumeSessionId, label, branch, repository, taskId } = opts
      const resolvedLabel = label || basename(folderPath) || 'Copilot'

      const session = await start({
        folderPath,
        prompt: prompt ?? '',
        resumeSessionId,
        label: resolvedLabel,
        taskId,
        repository,
        branch
      })
      if (!session) return { ok: false, error: 'Could not start Copilot.' }
      return { ok: true, sessionId: session.id }
    },
    [start]
  )
}
