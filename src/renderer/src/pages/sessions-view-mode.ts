export type SessionViewMode = 'tabs' | 'grid'

const VIEW_MODE_STORAGE_KEY = 'devtrees.sessions.viewMode'

export function isViewMode(value: unknown): value is SessionViewMode {
  return value === 'tabs' || value === 'grid'
}

export function loadViewMode(): SessionViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    if (isViewMode(stored)) return stored
  } catch {
    /* localStorage may be unavailable */
  }
  return 'tabs'
}

export function persistViewMode(mode: SessionViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    /* localStorage may be unavailable */
  }
}
