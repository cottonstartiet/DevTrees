import { useEffect } from 'react'
import { toast } from 'sonner'
import type { UpdateStatus } from '@shared/settings'

/**
 * The tray host owns signed update checks so they continue without a browser tab.
 * This hook only mirrors host state and offers the explicit install action.
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    let lastOffered: string | undefined
    const offer = (status: UpdateStatus): void => {
      if (status.state !== 'available' || !status.version || status.version === lastOffered) return
      lastOffered = status.version
      toast(`Update ${status.version} is available.`, {
        duration: Infinity,
        action: {
          label: 'Install update',
          onClick: () => {
            const toastId = toast.loading(`Installing update ${status.version}…`)
            void window.api.updater
              .install()
              .then((next) => {
                if (next.state === 'error') {
                  toast.error(next.error ?? 'Update installation failed.', { id: toastId })
                } else {
                  toast.success('Update installer started. DevTrees will restart.', {
                    id: toastId
                  })
                }
              })
              .catch((error) => toast.error(String(error), { id: toastId }))
          }
        }
      })
    }
    const unsubscribe = window.api.updater.onUpdate(offer)
    void window.api.updater
      .status()
      .then(offer)
      .catch(() => undefined)
    return unsubscribe
  }, [])
}
