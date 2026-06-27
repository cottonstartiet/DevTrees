/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

import type { CopilotSession, CreateSessionRequest, CreateSessionResult } from '@shared/sessions'
import type { DecodedSessionSnapshot, SessionData } from '@/lib/api'
import { ConfirmDialog } from '@/components/confirm-dialog'

type DataListener = (event: { seq: number; data: Uint8Array }) => void

export interface SessionsContextValue {
  sessions: CopilotSession[]
  runningCount: number
  activeSessionId: string | null
  selectSession: (id: string) => void
  /** Cycle the active session by `delta` (+1 next, -1 previous), wrapping around. */
  cycleSession: (delta: number) => void
  createSession: (req: CreateSessionRequest) => Promise<CreateSessionResult>
  killSession: (id: string) => void
  /**
   * Close a session, prompting for confirmation first if it is still running. Exited sessions are
   * closed immediately. Prefer this over `killSession` for user-initiated closes (Ctrl+W, X buttons).
   */
  requestCloseSession: (id: string) => void
  sendInput: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  snapshot: (id: string) => Promise<DecodedSessionSnapshot | null>
  /** Subscribe a mounted terminal to live output for a session. Returns an unsubscribe fn. */
  subscribeData: (id: string, listener: DataListener) => () => void
}

const SessionsContext = React.createContext<SessionsContextValue | null>(null)

interface SessionsProviderProps {
  children: React.ReactNode
  onNavigateToSessions?: () => void
}

export function SessionsProvider({
  children,
  onNavigateToSessions
}: SessionsProviderProps): React.JSX.Element {
  const [sessions, setSessions] = React.useState<CopilotSession[]>([])
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null)
  const [pendingCloseId, setPendingCloseId] = React.useState<string | null>(null)

  // Per-session live-output listeners. The Rust backend is the authoritative buffer (replayed via
  // snapshot on mount); the provider only routes live events to the currently mounted terminal.
  const listenersRef = React.useRef<Map<string, Set<DataListener>>>(new Map())

  React.useEffect(() => {
    let cancelled = false
    void window.api.sessions.list().then((list) => {
      if (!cancelled) setSessions(list)
    })

    const offData = window.api.sessions.onData((event: SessionData) => {
      const set = listenersRef.current.get(event.id)
      if (!set) return
      for (const listener of set) listener({ seq: event.seq, data: event.data })
    })

    const offExit = window.api.sessions.onExit((event) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === event.id
            ? { ...s, status: 'exited', exitedAt: Date.now(), exitCode: event.exitCode }
            : s
        )
      )
    })

    return () => {
      cancelled = true
      offData()
      offExit()
    }
  }, [])

  const selectSession = React.useCallback((id: string): void => {
    setActiveSessionId(id)
  }, [])

  // Derive the effective active tab rather than syncing it via setState: if the explicit selection
  // no longer exists (session closed) or none is set, fall back to the most recent session.
  const effectiveActiveId = React.useMemo<string | null>(() => {
    if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) return activeSessionId
    return sessions.length ? sessions[sessions.length - 1].id : null
  }, [sessions, activeSessionId])

  const cycleSession = React.useCallback(
    (delta: number): void => {
      setSessions((prev) => {
        if (prev.length <= 1) return prev
        setActiveSessionId((currentActive) => {
          const current =
            currentActive && prev.some((s) => s.id === currentActive)
              ? currentActive
              : prev[prev.length - 1].id
          const idx = prev.findIndex((s) => s.id === current)
          const nextIdx = (idx + delta + prev.length) % prev.length
          return prev[nextIdx].id
        })
        return prev
      })
    },
    []
  )

  const createSession = React.useCallback(
    async (req: CreateSessionRequest): Promise<CreateSessionResult> => {
      const result = await window.api.sessions.create(req)
      if (result.ok) {
        setSessions((prev) => [...prev.filter((s) => s.id !== result.session.id), result.session])
        setActiveSessionId(result.session.id)
        onNavigateToSessions?.()
      }
      return result
    },
    [onNavigateToSessions]
  )

  const killSession = React.useCallback((id: string): void => {
    void window.api.sessions.kill(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const requestCloseSession = React.useCallback(
    (id: string): void => {
      const target = sessions.find((s) => s.id === id)
      if (target && target.status === 'running') {
        setPendingCloseId(id)
        return
      }
      killSession(id)
    },
    [sessions, killSession]
  )

  const sendInput = React.useCallback((id: string, data: string): void => {
    void window.api.sessions.sendInput(id, data)
  }, [])

  const resize = React.useCallback((id: string, cols: number, rows: number): void => {
    void window.api.sessions.resize(id, cols, rows)
  }, [])

  const snapshot = React.useCallback(
    (id: string): Promise<DecodedSessionSnapshot | null> => window.api.sessions.snapshot(id),
    []
  )

  const subscribeData = React.useCallback((id: string, listener: DataListener): (() => void) => {
    let set = listenersRef.current.get(id)
    if (!set) {
      set = new Set()
      listenersRef.current.set(id, set)
    }
    set.add(listener)
    return () => {
      const current = listenersRef.current.get(id)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) listenersRef.current.delete(id)
    }
  }, [])

  const value = React.useMemo<SessionsContextValue>(() => {
    const runningCount = sessions.filter((s) => s.status === 'running').length
    return {
      sessions,
      runningCount,
      activeSessionId: effectiveActiveId,
      selectSession,
      cycleSession,
      createSession,
      killSession,
      requestCloseSession,
      sendInput,
      resize,
      snapshot,
      subscribeData
    }
  }, [
    sessions,
    effectiveActiveId,
    selectSession,
    cycleSession,
    createSession,
    killSession,
    requestCloseSession,
    sendInput,
    resize,
    snapshot,
    subscribeData
  ])

  const pendingCloseSession =
    pendingCloseId !== null ? (sessions.find((s) => s.id === pendingCloseId) ?? null) : null

  return (
    <SessionsContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pendingCloseId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCloseId(null)
        }}
        title="Close session?"
        description="Copilot is still running in this session. Closing will stop it."
        body={pendingCloseSession ? pendingCloseSession.label : undefined}
        confirmLabel="Close"
        confirmVariant="destructive"
        onConfirm={() => {
          if (pendingCloseId !== null) killSession(pendingCloseId)
        }}
      />
    </SessionsContext.Provider>
  )
}

export function useSessions(): SessionsContextValue {
  const ctx = React.useContext(SessionsContext)
  if (!ctx) {
    throw new Error('useSessions must be used within a SessionsProvider')
  }
  return ctx
}
