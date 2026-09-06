/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'

import {
  isTerminalSessionFinished,
  type TerminalSessionConnectionState,
  type RespondTerminalSessionRequest,
  type StartTerminalSessionRequest,
  type TerminalSession,
  type TerminalSessionInteraction,
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
  interactionById: Record<string, TerminalSessionInteraction | undefined>
  /** Local receipt time for each currently pending interaction. */
  interactionRequestedAtById: Record<string, number | undefined>
  /**
   * Replay a session's event log into its timeline. Safe to call repeatedly; live
   * updates that arrive meanwhile are merged by `seq` rather than duplicated.
   */
  loadHistory: (id: string) => Promise<void>
  /** Session shown in the Sessions detail view, if any. */
  selectedId: string | null
  select: (id: string | null) => void
  /** Legacy support for mirroring an externally launched Copilot CLI session. */
  watch: (req: WatchTerminalSessionRequest) => Promise<TerminalSession | null>
  start: (req: StartTerminalSessionRequest) => Promise<TerminalSession | null>
  prompt: (id: string, prompt: string) => Promise<void>
  respond: (req: RespondTerminalSessionRequest) => Promise<void>
  cancel: (id: string) => Promise<void>
  /** Reconcile response controls with the backend after a missed or stale renderer event. */
  refreshInteraction: (id: string) => Promise<TerminalSessionInteraction | null>
  /** Stop mirroring and remove a session from the list. */
  forget: (id: string) => Promise<void>
}

const TerminalSessionsContext = React.createContext<TerminalSessionsContextValue | null>(null)

/**
 * Statuses worth interrupting the user for while they are working elsewhere in the app.
 */
function notification(
  session: TerminalSession,
  previous: TerminalSessionStatus | undefined
): { kind: 'attention' | 'done' | 'error'; title: string; description: string } | null {
  if (previous === session.status) return null

  if (session.status === 'waiting-input') {
    return {
      kind: 'attention',
      title: `${session.label} needs your input`,
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
      description: 'The Copilot session ended.'
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
  const [interactionById, setInteractionById] = React.useState<
    Record<string, TerminalSessionInteraction | undefined>
  >({})
  const [interactionRequestedAtById, setInteractionRequestedAtById] = React.useState<
    Record<string, number | undefined>
  >({})
  const interactionRequestIdRef = React.useRef<Record<string, number | undefined>>({})
  const interactionByIdRef = React.useRef<Record<string, TerminalSessionInteraction | undefined>>(
    {}
  )
  const interactionRevisionRef = React.useRef<Record<string, number | undefined>>({})
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

  const applyInteraction = React.useCallback(
    (update: { sessionId: string; interaction: TerminalSessionInteraction | null }): void => {
      const previousRequestId = interactionRequestIdRef.current[update.sessionId]
      if (update.interaction) {
        interactionRequestIdRef.current[update.sessionId] = update.interaction.requestId
        interactionByIdRef.current[update.sessionId] = update.interaction
        if (previousRequestId !== update.interaction.requestId) {
          setInteractionRequestedAtById((current) => ({
            ...current,
            [update.sessionId]: Date.now()
          }))
        }
      } else {
        delete interactionRequestIdRef.current[update.sessionId]
        delete interactionByIdRef.current[update.sessionId]
        setInteractionRequestedAtById((current) => {
          const next = { ...current }
          delete next[update.sessionId]
          return next
        })
      }
      setInteractionById((current) => {
        const next = { ...current }
        if (update.interaction) next[update.sessionId] = update.interaction
        else delete next[update.sessionId]
        return next
      })
    },
    []
  )

  const refreshInteraction = React.useCallback(
    async (id: string): Promise<TerminalSessionInteraction | null> => {
      const revision = interactionRevisionRef.current[id] ?? 0
      const interaction = await window.api.terminalSessions.interaction(id)
      // A live event received during this request is newer than the snapshot.
      if ((interactionRevisionRef.current[id] ?? 0) === revision) {
        applyInteraction({ sessionId: id, interaction })
        return interaction
      }
      return interactionByIdRef.current[id] ?? null
    },
    [applyInteraction]
  )

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
    const unsubscribeInteraction = window.api.terminalSessions.onInteraction((update) => {
      if (cancelled || forgottenRef.current.has(update.sessionId)) return
      interactionRevisionRef.current[update.sessionId] =
        (interactionRevisionRef.current[update.sessionId] ?? 0) + 1
      applyInteraction(update)
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
      unsubscribeInteraction()
      unsubscribeState()
      unsubscribeResync()
    }
  }, [applyInteraction, ingest, mergeEntries, restoreSnapshot])

  React.useEffect(() => {
    const missingInteractionIds = Object.values(byId)
      .filter(
        (session): session is TerminalSession =>
          Boolean(session) &&
          session?.status === 'waiting-input' &&
          !interactionByIdRef.current[session.id]
      )
      .map((session) => session.id)
    if (missingInteractionIds.length === 0) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const reconcile = (attempt: number): void => {
      void Promise.all(
        missingInteractionIds.map(async (id) => {
          if (interactionByIdRef.current[id]) return
          try {
            await refreshInteraction(id)
          } catch {
            // The visible recovery control reports errors; background reconciliation stays quiet.
          }
        })
      ).then(() => {
        if (
          !cancelled &&
          attempt < 2 &&
          missingInteractionIds.some((id) => !interactionByIdRef.current[id])
        ) {
          timers.push(setTimeout(() => reconcile(attempt + 1), 750 * (attempt + 1)))
        }
      })
    }
    reconcile(0)

    return () => {
      cancelled = true
      for (const timer of timers) clearTimeout(timer)
    }
  }, [byId, refreshInteraction])

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

  const start = React.useCallback(
    async (req: StartTerminalSessionRequest): Promise<TerminalSession | null> => {
      const result = await window.api.terminalSessions.start(req)
      if (!result.ok) {
        toast.error(result.error)
        return null
      }
      ingest(result.session, false)
      return result.session
    },
    [ingest]
  )

  const prompt = React.useCallback(async (id: string, value: string): Promise<void> => {
    await window.api.terminalSessions.prompt(id, value)
  }, [])

  const respond = React.useCallback(async (req: RespondTerminalSessionRequest): Promise<void> => {
    await window.api.terminalSessions.respond(req)
  }, [])

  const cancel = React.useCallback(async (id: string): Promise<void> => {
    await window.api.terminalSessions.cancel(id)
  }, [])

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
    setInteractionById((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    delete interactionRequestIdRef.current[id]
    delete interactionByIdRef.current[id]
    delete interactionRevisionRef.current[id]
    setInteractionRequestedAtById((current) => {
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
      interactionById,
      interactionRequestedAtById,
      loadHistory,
      selectedId,
      select: setSelectedId,
      watch,
      start,
      prompt,
      respond,
      cancel,
      refreshInteraction,
      forget
    }),
    [
      connectionState,
      sessions,
      byId,
      entriesById,
      interactionById,
      interactionRequestedAtById,
      loadHistory,
      selectedId,
      watch,
      start,
      prompt,
      respond,
      cancel,
      refreshInteraction,
      forget
    ]
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
