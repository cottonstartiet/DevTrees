/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

import type { CopilotSession, CreateSessionRequest, CreateSessionResult } from '@shared/sessions'
import type { DecodedSessionSnapshot, SessionData } from '@/lib/api'
import {
  capTerminalTail,
  lastVisibleTerminalLine,
  terminalAttentionKind,
  terminalIsWaitingForInput
} from '@/lib/terminal-output'

type DataListener = (event: { seq: number; data: Uint8Array }) => void

export type SessionActivity = {
  lastLine: string
  waitingForInput: boolean
  attentionKind: 'command' | 'confirmation' | null
  updatedAt: number
}

export type CreateSessionOptions = {
  activate?: boolean
}

export interface SessionsContextValue {
  sessions: CopilotSession[]
  activityBySessionId: Readonly<Record<string, SessionActivity>>
  runningCount: number
  activeSessionId: string | null
  selectSession: (id: string) => void
  /** Cycle the active session by `delta` (+1 next, -1 previous), wrapping around. */
  cycleSession: (delta: number) => void
  createSession: (
    req: CreateSessionRequest,
    options?: CreateSessionOptions
  ) => Promise<CreateSessionResult>
  killSession: (id: string) => void
  /**
   * Close a session immediately (stops it if still running). Prefer this over `killSession` for
   * user-initiated closes (Ctrl+W, X buttons).
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
  const [activityBySessionId, setActivityBySessionId] = React.useState<
    Record<string, SessionActivity>
  >({})
  const outputTailRef = React.useRef<Record<string, string>>({})
  const decoderRef = React.useRef<Record<string, TextDecoder>>({})
  const pendingExitRef = React.useRef<
    Record<string, { id: string; exitCode: number; exitedAt: number }>
  >({})

  // Per-session live-output listeners. The Rust backend is the authoritative buffer (replayed via
  // snapshot on mount); the provider only routes live events to the currently mounted terminal.
  const listenersRef = React.useRef<Map<string, Set<DataListener>>>(new Map())

  const updateActivity = React.useCallback((id: string, tail: string): void => {
    outputTailRef.current[id] = tail
    setActivityBySessionId((current) => ({
      ...current,
      [id]: {
        lastLine: lastVisibleTerminalLine(tail),
        waitingForInput: terminalIsWaitingForInput(tail),
        attentionKind: terminalAttentionKind(tail),
        updatedAt: Date.now()
      }
    }))
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void window.api.sessions.list().then((list) => {
      if (!cancelled) setSessions(list)
    })

    const offData = window.api.sessions.onData((event: SessionData) => {
      const decoder =
        decoderRef.current[event.id] ??
        (decoderRef.current[event.id] = new TextDecoder('utf-8', { fatal: false }))
      const tail = capTerminalTail(
        (outputTailRef.current[event.id] ?? '') + decoder.decode(event.data, { stream: true })
      )
      updateActivity(event.id, tail)
      const set = listenersRef.current.get(event.id)
      if (!set) return
      for (const listener of set) listener({ seq: event.seq, data: event.data })
    })

    const offExit = window.api.sessions.onExit((event) => {
      pendingExitRef.current[event.id] = { ...event, exitedAt: Date.now() }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === event.id
            ? { ...s, status: 'exited', exitedAt: Date.now(), exitCode: event.exitCode }
            : s
        )
      )
      setActivityBySessionId((current) => {
        const existing = current[event.id]
        if (!existing) return current
        return {
          ...current,
          [event.id]: { ...existing, waitingForInput: false, updatedAt: Date.now() }
        }
      })
    })

    return () => {
      cancelled = true
      offData()
      offExit()
    }
  }, [updateActivity])

  React.useEffect(() => {
    let cancelled = false
    for (const session of sessions) {
      if (outputTailRef.current[session.id] !== undefined) continue
      void window.api.sessions.snapshot(session.id).then((snap) => {
        if (cancelled || !snap || outputTailRef.current[session.id] !== undefined) return
        const tail = capTerminalTail(new TextDecoder('utf-8', { fatal: false }).decode(snap.buffer))
        updateActivity(session.id, tail)
      })
    }
    return () => {
      cancelled = true
    }
  }, [sessions, updateActivity])

  const selectSession = React.useCallback((id: string): void => {
    setActiveSessionId(id)
  }, [])

  // Derive the effective active tab rather than syncing it via setState: if the explicit selection
  // no longer exists (session closed) or none is set, fall back to the most recent session.
  const effectiveActiveId = React.useMemo<string | null>(() => {
    if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) return activeSessionId
    return sessions.length ? sessions[sessions.length - 1].id : null
  }, [sessions, activeSessionId])

  const cycleSession = React.useCallback((delta: number): void => {
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
  }, [])

  const createSession = React.useCallback(
    async (
      req: CreateSessionRequest,
      options?: CreateSessionOptions
    ): Promise<CreateSessionResult> => {
      const result = await window.api.sessions.create(req)
      if (result.ok) {
        const pendingExit = pendingExitRef.current[result.session.id]
        const session = pendingExit
          ? {
              ...result.session,
              status: 'exited' as const,
              exitedAt: pendingExit.exitedAt,
              exitCode: pendingExit.exitCode
            }
          : result.session
        setSessions((prev) => [...prev.filter((s) => s.id !== session.id), session])
        if (options?.activate !== false) {
          setActiveSessionId(session.id)
          onNavigateToSessions?.()
        }
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
      killSession(id)
    },
    [killSession]
  )

  const sendInput = React.useCallback((id: string, data: string): void => {
    void window.api.sessions.sendInput(id, data)
    setActivityBySessionId((current) => {
      const existing = current[id]
      if (!existing) return current
      return {
        ...current,
        [id]: { ...existing, waitingForInput: false, updatedAt: Date.now() }
      }
    })
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
      activityBySessionId,
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
    activityBySessionId,
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

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

export function useSessions(): SessionsContextValue {
  const ctx = React.useContext(SessionsContext)
  if (!ctx) {
    throw new Error('useSessions must be used within a SessionsProvider')
  }
  return ctx
}
