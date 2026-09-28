import type { ColorTheme, Theme } from '@/contexts/theme-context'

export const THEME_SYNC_EVENT = 'swe-factory://theme-changed'

export interface ThemeSyncPayload {
  source: string
  theme?: Theme
  colorTheme?: ColorTheme
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

function isColorTheme(value: unknown): value is ColorTheme {
  return value === 'chalk' || value === 'enterprise'
}

export function isThemeSyncPayload(value: unknown): value is ThemeSyncPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<ThemeSyncPayload>
  return (
    typeof payload.source === 'string' &&
    payload.source.length > 0 &&
    (payload.theme === undefined || isTheme(payload.theme)) &&
    (payload.colorTheme === undefined || isColorTheme(payload.colorTheme)) &&
    (payload.theme !== undefined || payload.colorTheme !== undefined)
  )
}

function hasTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in globalThis
}

export function createThemeSyncSource(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export function publishThemeSync(payload: ThemeSyncPayload): void {
  if (!hasTauriRuntime()) return
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit(THEME_SYNC_EVENT, payload))
    .catch((error: unknown) => {
      console.warn('Unable to synchronize theme across windows.', error)
    })
}

export function subscribeThemeSync(
  source: string,
  onTheme: (payload: ThemeSyncPayload) => void
): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined

  if (hasTauriRuntime()) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(THEME_SYNC_EVENT, (event) => {
          if (
            !disposed &&
            isThemeSyncPayload(event.payload) &&
            event.payload.source !== source
          ) {
            onTheme(event.payload)
          }
        })
      )
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) => {
        console.warn('Unable to listen for theme changes from other windows.', error)
      })
  }

  return () => {
    disposed = true
    unlisten?.()
  }
}
