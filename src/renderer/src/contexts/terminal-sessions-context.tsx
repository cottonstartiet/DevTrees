/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'

import {
  isTerminalSessionFinished,
  type TerminalSessionConnectionState,
  type TerminalSession,
  type TerminalSessionStatus,
  type TerminalTimelineEntry,
  type WatchTerminalSessionRequest
} from '@shared/terminal-session'

export interface TerminalSessionsContextValue {
  connectionState: TerminalSessionConnectionState
  /** Newest first. Includes finished sessions until the user dismisses them. */
  sessions: TerminalSession[]
  byId: Record<string, TerminalSession | undefined>
  /** Timeline entries per session, ordered by `seq`. Populated by `loadHistory`. */
  entriesById: Record<string, TerminalTimelineEntry[] | undefined>
  /**
   * Replay a session's event log into its timeline. Safe to call repeatedly; live
   * updates that arrive meanwhile are merged by `seq` rather than duplicated.
   */
  loadHistory: (id: string) => Promise<void>
  /** Session shown in the Sessions detail view, if any. */
  selectedId: string | null
  select: (id: string | null) => void
  /** Start mirroring an externally launched Copilot CLI session. */
  watch: (req: WatchTerminalSessionRequest) => Promise<TerminalSession | null>
  /** Stop mirroring and remove a session from the list. */
  forget: (id: string) => Promise<void>
}

const TerminalSessionsContext = React.createContext<TerminalSessionsContextValue | null>(null)

/**
 * Statuses worth interrupting the user for. Copilot is running in a window the app does
 * not own, so these toasts are the only way the user learns they need to switch to it.
 */
function notification(
  session: TerminalSession,
  previous: TerminalSessionStatus | undefined
): { kind: 'attention' | 'done' | 'error'; title: string; description: string } | null {
  if (previous === session.status) return null

  if (session.status === 'waiting-input') {
    return {
      kind: 'attention',
      title: `${session.label} needs you in the terminal`,
      description: session.pendingPrompt ?? 'Copilot is waiting for your response.'
    }
  }
  if (session.status === 'error') {
    return { kind: 'error', title: `${session.label} failed`, description: session.lastActivity }
  }
  // `idle` means the turn ended: Copilot has finished what it was asked to do.
  if (session.status === 'idle' && previous === 'working') {
    return {
      kind: 'done',
      title: `${session.label} finished a turn`,
      description: session.lastActivity || 'Copilot is waiting for your next instruction.'
    }
  }
  if (session.status === 'done' && previous && previous !== 'starting') {
    return {
      kind: 'done',
      title: `${session.label} ended`,
      description: 'The Copilot terminal was closed.'
    }
  }
  return null
}

export function TerminalSessionsProvider({
  children,
  onNavigateToSessions
}: {
  children: React.ReactNode
  /** Lets a toast jump the user to the Sessions view. */
  onNavigateToSessions?: () => void
}): React.JSX.Element {
  const [byId, setById] = React.useState<Record<string, TerminalSession | undefined>>({})
  const [entriesById, setEntriesById] = React.useState<
    Record<string, TerminalTimelineEntry[] | undefined>
  >({})
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [connectionState, setConnectionState] =
    React.useState<TerminalSessionConnectionState>('connecting')

  // Previous status per session, kept in a ref so toasts fire exactly once per
  // transition even under StrictMode's double-invoked state updaters.
  const statusRef = React.useRef<Record<string, TerminalSessionStatus>>({})
  const forgottenRef = React.useRef(new Set<string>())
  const connectionRef = React.useRef<TerminalSessionConnectionState>('connecting')
  const navigateRef = React.useRef(onNavigateToSessions)
  React.useEffect(() => {
    navigateRef.current = onNavigateToSessions
  }, [onNavigateToSessions])

  const ingest = React.useCallback((session: TerminalSession, notify: boolean): void => {
    const previous = statusRef.current[session.id]
    statusRef.current[session.id] = session.status

    if (notify) {
      const message = notification(session, previous)
      if (message) {
        const options = {
          description: message.description,
          action: navigateRef.current
            ? { label: 'Open Sessions', onClick: () => navigateRef.current?.() }
            : undefined
        }
        if (message.kind === 'attention') toast.warning(message.title, options)
        else if (message.kind === 'error') toast.error(message.title, options)
        else toast.success(message.title, options)
      }
    }

    setById((current) => ({ ...current, [session.id]: session }))
  }, [])

  const mergeEntries = React.useCallback((id: string, incoming: TerminalTimelineEntry[]): void => {
    if (incoming.length === 0) return
    setEntriesById((current) => {
      const merged = new Map<number, TerminalTimelineEntry>()
      for (const entry of current[id] ?? []) merged.set(entry.seq, entry)
      // A completed tool call re-emits its start entry's `seq`, so this replaces the
      // in-flight row instead of appending a second one.
      for (const entry of incoming) merged.set(entry.seq, entry)
      const next = [...merged.values()].sort((a, b) => a.seq - b.seq)
      return { ...current, [id]: next }
    })
  }, [])

  const loadHistory = React.useCallback(
    async (id: string): Promise<void> => {
      try {
        mergeEntries(id, await window.api.terminalSessions.history(id))
      } catch {
        // No log yet (or an unreadable one) simply means an empty timeline.
      }
    },
    [mergeEntries]
  )

  const restoreSnapshot = React.useCallback(async (): Promise<void> => {
    const requestedAt = Date.now()
    const snapshot = await window.api.terminalSessions.snapshot()
    const snapshotById = Object.fromEntries(
      snapshot.sessions
        .filter((session) => !forgottenRef.current.has(session.id))
        .map((session) => [session.id, session])
    )
    setById((current) => {
      const next: Record<string, TerminalSession | undefined> = {}
      for (const [id, session] of Object.entries(snapshotById)) {
        const live = current[id]
        next[id] = live && live.updatedAt > session.updatedAt ? live : session
      }
      // Preserve sessions created or updated by live events while the snapshot request
      // was in flight; all older absent rows are removed authoritatively.
      for (const [id, session] of Object.entries(current)) {
        if (
          session &&
          !next[id] &&
          !forgottenRef.current.has(id) &&
          session.updatedAt >= requestedAt
        ) {
          next[id] = session
        }
      }
      statusRef.current = Object.fromEntries(
        Object.values(next)
          .filter((session): session is TerminalSession => Boolean(session))
          .map((session) => [session.id, session.status])
      )
      return next
    })
    for (const [id, entries] of Object.entries(snapshot.entriesById)) {
      mergeEntries(id, entries)
    }
    if (selectedId) {
      mergeEntries(selectedId, await window.api.terminalSessions.history(selectedId))
    }
    window.api.terminalSessions.markSnapshotRestored()
  }, [mergeEntries, selectedId])

  React.useEffect(() => {
    let cancelled = false

    const unsubscribe = window.api.terminalSessions.onUpdate((update) => {
      if (cancelled || forgottenRef.current.has(update.session.id)) return
      ingest(update.session, true)
      mergeEntries(update.session.id, update.entries)
    })
    const unsubscribeState = window.api.terminalSessions.onConnectionState((state) => {
      if (cancelled) return
      const previous = connectionRef.current
      connectionRef.current = state
      setConnectionState(state)
      if (state === 'live' && previous !== 'restored-from-snapshot') {
        void restoreSnapshot().catch(() => {
          if (!cancelled) setConnectionState('host-unavailable')
        })
      }
    })
    const unsubscribeResync = window.api.terminalSessions.onResyncRequired(() => {
      void restoreSnapshot()
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeState()
      unsubscribeResync()
    }
  }, [ingest, mergeEntries, restoreSnapshot])

  const watch = React.useCallback(
    async (req: WatchTerminalSessionRequest): Promise<TerminalSession | null> => {
      const result = await window.api.terminalSessions.watch(req)
      if (!result.ok) {
        toast.error(result.error)
        return null
      }
      forgottenRef.current.delete(result.session.id)
      ingest(result.session, false)
      return result.session
    },
    [ingest]
  )

  const forget = React.useCallback(async (id: string): Promise<void> => {
    forgottenRef.current.add(id)
    try {
      await window.api.terminalSessions.forget(id)
    } catch (error) {
      forgottenRef.current.delete(id)
      throw error
    }
    delete statusRef.current[id]
    setById((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setEntriesById((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setSelectedId((current) => (current === id ? null : current))
  }, [])

  const sessions = React.useMemo(
    () =>
      Object.values(byId)
        .filter((session): session is TerminalSession => Boolean(session))
        .sort((a, b) => b.createdAt - a.createdAt),
    [byId]
  )

  const value = React.useMemo<TerminalSessionsContextValue>(
    () => ({
      connectionState,
      sessions,
      byId,
      entriesById,
      loadHistory,
      selectedId,
      select: setSelectedId,
      watch,
      forget
    }),
    [connectionState, sessions, byId, entriesById, loadHistory, selectedId, watch, forget]
  )

  return (
    <TerminalSessionsContext.Provider value={value}>{children}</TerminalSessionsContext.Provider>
  )
}

export function useTerminalSessions(): TerminalSessionsContextValue {
  const ctx = React.useContext(TerminalSessionsContext)
  if (!ctx) {
    throw new Error('useTerminalSessions must be used within a TerminalSessionsProvider')
  }
  return ctx
}

export { isTerminalSessionFinished }
