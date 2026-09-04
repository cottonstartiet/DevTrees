import { useCallback } from 'react'

import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { launchCopilotCli, launchCopilotResume } from '@/lib/system'

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
 * Returns a `launch` function that opens Copilot in a new terminal window and registers a
 * monitor for it. Every Copilot launch site goes through this, so the app has a mirrored
 * session record for all of them.
 */
export function useCopilotLauncher(): (opts: CopilotLaunchOptions) => Promise<CopilotLaunchResult> {
  const { watch } = useTerminalSessions()

  return useCallback(
    async (opts: CopilotLaunchOptions): Promise<CopilotLaunchResult> => {
      const { folderPath, prompt, resumeSessionId, label, branch, repository, taskId } = opts
      const resolvedLabel = label || basename(folderPath) || 'Copilot'

      // Resuming reuses the existing session id, so the monitor simply re-attaches and its
      // tail continues where it left off rather than replaying the whole log.
      // Otherwise pin a fresh id before launching, so the app knows which CLI event log to
      // tail; without it an external terminal is completely opaque to us.
      const sessionId = resumeSessionId ?? crypto.randomUUID()

      const result = resumeSessionId
        ? await launchCopilotResume({ folderPath, sessionId: resumeSessionId })
        : await launchCopilotCli({ folderPath, prompt: prompt ?? '', sessionId })
      if (!result.ok) return { ok: false, error: result.error ?? 'Could not launch Copilot.' }

      await watch({
        id: sessionId,
        folderPath,
        label: resolvedLabel,
        taskId,
        repository,
        branch
      })
      return { ok: true, sessionId }
    },
    [watch]
  )
}
