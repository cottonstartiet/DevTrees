import { useEffect } from 'react'
import { toast } from 'sonner'

import { useGithubAuth } from '@/contexts/github-auth-context'

/**
 * Auto-update against the private GitHub Enterprise release repo. Because the
 * repo is private, downloads must be authenticated: the check + install run in
 * the Rust backend (`update_check` / `update_install`), which attaches the
 * signed-in user's token to both the manifest fetch and the installer download.
 * See `specs/ghe-update.md`.
 *
 * On launch we ask the backend whether a newer signed release exists. If the
 * user is signed in and an update is available, we surface a non-blocking toast
 * offering "Restart & update"; the install only runs when the user accepts, so
 * an in-progress session is never interrupted. On Windows the NSIS installer
 * (passive mode) applies the update and the backend relaunches DevTrees.
 *
 * If the user is not signed in, we show a non-blocking prompt to sign in to
 * receive updates rather than silently skipping the check. All check failures
 * are swallowed/logged so updates remain best-effort and never block or crash
 * the app.
 */
export function useAutoUpdate(): void {
  const { signedIn, signIn } = useGithubAuth()

  useEffect(() => {
    // Wait until the initial sign-in status is known.
    if (signedIn === null) return
    let cancelled = false

    void (async () => {
      try {
        const update = await window.api.updater.check()
        if (cancelled) return

        if (!update.signedIn) {
          toast('Sign in to GitHub to receive DevTrees updates.', {
            duration: Infinity,
            id: 'update-signin-prompt',
            action: { label: 'Sign in', onClick: () => void signIn() }
          })
          return
        }

        if (!update.available || !update.version) return
        const version = update.version

        toast(`Update ${version} is available.`, {
          duration: Infinity,
          id: 'update-available',
          action: {
            label: 'Restart & update',
            onClick: () => {
              void (async () => {
                const toastId = toast.loading(
                  `Installing update ${version}. DevTrees will restart…`
                )
                try {
                  await window.api.updater.install(version)
                } catch (err) {
                  console.error('[updater] install failed', err)
                  toast.error(`Update ${version} failed to install.`, { id: toastId })
                }
              })()
            }
          }
        })
      } catch (err) {
        // Best-effort: no release yet, offline, or a manifest/signature/auth
        // failure. Keep running the current version, but log so production
        // update failures stay diagnosable.
        console.warn('[updater] update check skipped:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [signedIn, signIn])
}
