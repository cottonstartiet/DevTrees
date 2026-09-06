import { useEffect } from 'react'
import { toast } from 'sonner'

/**
 * Auto-update against the GitHub Releases published by the build workflow,
 * replacing the old `electron-updater` flow. On launch we ask Tauri's updater
 * whether a newer signed release exists; if so we surface a non-blocking toast
 * offering an immediate "restart & update". The install only runs when the user
 * accepts, so we never interrupt an in-progress session — mirroring
 * electron-updater's "notify, install on the user's terms" behaviour.
 *
 * On Windows `downloadAndInstall()` runs the NSIS installer and terminates the
 * running process, so any code after it is not guaranteed to execute; the
 * installer (passive mode) applies the update and relaunches DevTrees. We still
 * call `relaunch()` as a best-effort fallback in case control returns.
 *
 * The updater only works in a packaged build with a configured endpoint, so any
 * failure (running under plain `vite` in a browser, no releases yet, offline,
 * private repo without a token) is swallowed for the check itself: updates are
 * best-effort and must never crash or block the app. Failures during an
 * explicit user-triggered install are logged and surfaced.
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (cancelled || !update) return

        toast(`Update ${update.version} is available.`, {
          duration: Infinity,
          action: {
            label: 'Restart & update',
            onClick: () => {
              void (async () => {
                const toastId = toast.loading(
                  `Installing update ${update.version}. DevTrees will restart…`
                )
                try {
                  await update.downloadAndInstall()
                  const { relaunch } = await import('@tauri-apps/plugin-process')
                  await relaunch()
                } catch (err) {
                  console.error('[updater] install failed', err)
                  toast.error(`Update ${update.version} failed to install.`, { id: toastId })
                }
              })()
            }
          }
        })
      } catch (err) {
        // Best-effort: no Tauri runtime (browser dev), no release yet, or a
        // network/manifest/signature failure. Keep running the current version,
        // but log so production update failures remain diagnosable.
        console.warn('[updater] update check skipped:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])
}
