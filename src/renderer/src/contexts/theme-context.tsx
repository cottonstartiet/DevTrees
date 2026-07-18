/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'devtrees-theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function getStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isTheme(stored)) return stored
  } catch {
    // localStorage may be unavailable (private mode / disabled). Fall back below.
  }
  return 'system'
}

function setStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Persisting is best-effort; ignore storage failures.
  }
}

export function getSystemTheme(): ResolvedTheme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
}

/**
 * Apply the persisted theme synchronously at module load, before React renders,
 * so the correct colors paint immediately (the renderer CSP forbids inline
 * scripts, so this runs as an imported module from main.tsx instead).
 */
export function initTheme(): void {
  applyTheme(resolveTheme(getStoredTheme()))
}

export interface ThemeContextValue {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

interface ThemeProviderProps {
  children: React.ReactNode
}

export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const [theme, setThemeState] = React.useState<Theme>(() => getStoredTheme())
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() =>
    resolveTheme(getStoredTheme())
  )

  const setTheme = React.useCallback((next: Theme): void => {
    setStoredTheme(next)
    const resolved = resolveTheme(next)
    applyTheme(resolved)
    setThemeState(next)
    setResolvedTheme(resolved)
  }, [])

  // Keep the applied class in sync with the current selection (idempotent under
  // StrictMode) and react to OS changes while in 'system' mode. resolvedTheme
  // state is updated by setTheme and the matchMedia callback, not here.
  React.useEffect(() => {
    applyTheme(resolveTheme(theme))

    if (theme !== 'system') return

    const media = window.matchMedia(DARK_QUERY)
    const onChange = (): void => {
      const next = media.matches ? 'dark' : 'light'
      applyTheme(next)
      setResolvedTheme(next)
    }
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [theme])

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return ctx
}
