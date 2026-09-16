import {
  isPermissionGranted,
  requestPermission
} from '@tauri-apps/plugin-notification'
import { invoke } from '@tauri-apps/api/core'

export type DesktopNotificationDestination = 'dashboard'

let permission: Promise<boolean> | null = null

function hasForegroundFocus(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

async function canNotify(): Promise<boolean> {
  if (await isPermissionGranted()) return true
  return (await requestPermission()) === 'granted'
}

function notificationBody(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim()
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact
}

export function notifyUserActionWhenBackground(
  title: string,
  message: string,
  destination: DesktopNotificationDestination
): void {
  if (hasForegroundFocus()) return

  permission ??= canNotify().catch((error) => {
    permission = null
    throw error
  })

  void permission
    .then((granted) => {
      if (!granted) return
      return invoke('desktop_notification_show', {
        request: { title, body: notificationBody(message), destination }
      })
    })
    .catch((error) => {
      console.error('[desktop notifications] could not send notification:', error)
    })
}
