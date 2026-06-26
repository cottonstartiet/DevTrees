import { useCallback } from 'react'

import { useSessions } from '@/contexts/sessions-context'
import { useTerminalMode } from '@/contexts/terminal-mode-context'
import { launchCopilotCli, launchCopilotResume } from '@/lib/system'

export type CopilotLaunchOptions = {
  folderPath: string
  /** Initial prompt for a fresh session. Ignored when `resumeSessionId` is set. */
  prompt?: string
  /** Resume an existing Copilot session by id instead of starting a fresh one. */
  resumeSessionId?: string
  /** Human-readable label for the embedded session tab/tile. */
  label: string
  /** Git branch checked out in the worktree, when known. Drives the tab/sidebar display name. */
  branch?: string
  /** Repository / project name, when known. Shown as the sidebar's secondary line. */
  repository?: string
}

export type CopilotLaunchResult = { ok: true } | { ok: false; error: string }

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx < 0 ? path : path.slice(idx + 1)
}

/**
 * Returns a `launch` function that routes a Copilot launch to either the external Windows Terminal
 * or an embedded in-app session, based on the user's Terminal Mode setting. All Copilot launch
 * sites go through this so the setting is honored everywhere.
 */
export function useCopilotLauncher(): (opts: CopilotLaunchOptions) => Promise<CopilotLaunchResult> {
  const { terminalMode } = useTerminalMode()
  const { createSession } = useSessions()

  return useCallback(
    async (opts: CopilotLaunchOptions): Promise<CopilotLaunchResult> => {
      const { folderPath, prompt, resumeSessionId, label, branch, repository } = opts

      if (terminalMode === 'embedded') {
        const result = await createSession({
          folderPath,
          prompt,
          resumeSessionId,
          label: label || basename(folderPath) || 'Copilot',
          branch,
          repository
        })
        return result.ok ? { ok: true } : { ok: false, error: result.error }
      }

      if (resumeSessionId) {
        return launchCopilotResume({ folderPath, sessionId: resumeSessionId })
      }
      return launchCopilotCli({ folderPath, prompt: prompt ?? '' })
    },
    [terminalMode, createSession]
  )
}
