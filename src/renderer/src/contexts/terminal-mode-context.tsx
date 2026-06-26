/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

export type TerminalMode = 'external' | 'embedded'

export const TERMINAL_MODE_STORAGE_KEY = 'devtrees-terminal-mode'

function isTerminalMode(value: unknown): value is TerminalMode {
  return value === 'external' || value === 'embedded'
}

export function getStoredTerminalMode(): TerminalMode {
  try {
    const stored = window.localStorage.getItem(TERMINAL_MODE_STORAGE_KEY)
    if (isTerminalMode(stored)) return stored
  } catch {
    // localStorage may be unavailable (private mode / disabled). Fall back below.
  }
  // Default to the external Windows Terminal, preserving the pre-embedded behavior.
  return 'external'
}

function setStoredTerminalMode(mode: TerminalMode): void {
  try {
    window.localStorage.setItem(TERMINAL_MODE_STORAGE_KEY, mode)
  } catch {
    // Persisting is best-effort; ignore storage failures.
  }
}

export interface TerminalModeContextValue {
  terminalMode: TerminalMode
  setTerminalMode: (mode: TerminalMode) => void
}

const TerminalModeContext = React.createContext<TerminalModeContextValue | null>(null)

export function TerminalModeProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [terminalMode, setModeState] = React.useState<TerminalMode>(() => getStoredTerminalMode())

  const setTerminalMode = React.useCallback((next: TerminalMode): void => {
    setStoredTerminalMode(next)
    setModeState(next)
  }, [])

  const value = React.useMemo<TerminalModeContextValue>(
    () => ({ terminalMode, setTerminalMode }),
    [terminalMode, setTerminalMode]
  )

  return <TerminalModeContext.Provider value={value}>{children}</TerminalModeContext.Provider>
}

export function useTerminalMode(): TerminalModeContextValue {
  const ctx = React.useContext(TerminalModeContext)
  if (!ctx) {
    throw new Error('useTerminalMode must be used within a TerminalModeProvider')
  }
  return ctx
}
