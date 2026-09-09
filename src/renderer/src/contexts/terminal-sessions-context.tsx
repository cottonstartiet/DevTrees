/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'
import { useNativeSessions, type NativeSessionsContextValue } from './use-native-sessions'
import { notifyUserActionWhenBackground } from '@/lib/desktop-notifications'

import {
  isTerminalSessionFinished,
  isExternalSessionEnded,
  missingExternalSessions,
  type StartTerminalSessionRequest,
  type TerminalSession,
  type TerminalSessionStatus,
  type TerminalTimelineEntry
} from '@shared/terminal-session'

export interface TerminalSessionsContextValue extends NativeSessionsContextValue {
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
  selectedInteractionId: string | null
  selectionRevision: number
  observationNow: number
  select: (id: string | null, interactionId?: string) => void
  start: (req: StartTerminalSessionRequest, foreground?: boolean) => Promise<TerminalSession | null>
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
  onNavigateToSessions,
  suppressNotifications = false
}: {
  children: React.ReactNode
  /** Lets a toast jump the user to the Sessions view. */
  onNavigateToSessions?: () => void
  /** Skip session toasts while the user is already viewing session status (Dashboard/Sessions). */
  suppressNotifications?: boolean
}): React.JSX.Element {
  const [byId, setById] = React.useState<Record<string, TerminalSession | undefined>>({})
  const [entriesById, setEntriesById] = React.useState<
    Record<string, TerminalTimelineEntry[] | undefined>
  >({})
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [selectedInteractionId, setSelectedInteractionId] = React.useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = React.useState(0)
  const [observationNow, setObservationNow] = React.useState(Date.now)
  const revisionsRef = React.useRef<Record<string, number>>({})
  const externalRevisionsRef = React.useRef<Record<string, number>>({})
  const forgottenRef = React.useRef(new Set<string>())
  const select = React.useCallback((id: string | null, interactionId?: string): void => {
    setSelectedId(id)
    setSelectedInteractionId(interactionId ?? null)
    setSelectionRevision((current) => current + 1)
  }, [])

  // Previous status per session, kept in a ref so toasts fire exactly once per
  // transition even under StrictMode's double-invoked state updaters.
  const statusRef = React.useRef<Record<string, TerminalSessionStatus>>({})
  const navigateRef = React.useRef(onNavigateToSessions)
  React.useEffect(() => {
    navigateRef.current = onNavigateToSessions
  }, [onNavigateToSessions])
  const suppressNotificationsRef = React.useRef(suppressNotifications)
  React.useEffect(() => {
    suppressNotificationsRef.current = suppressNotifications
  }, [suppressNotifications])

  const clearLocalDetails = React.useCallback((id: string): void => {
    setEntriesById((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }, [])

  const removeLocalSession = React.useCallback(
    (id: string): void => {
      delete externalRevisionsRef.current[id]
      clearLocalDetails(id)
      setById((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setSelectedId((current) => (current === id ? null : current))
    },
    [clearLocalDetails]
  )

  const ingest = React.useCallback(
    (session: TerminalSession, notify: boolean): void => {
      if (forgottenRef.current.has(session.id)) return
      if ((revisionsRef.current[session.id] ?? -1) > session.revision) return
      revisionsRef.current[session.id] = session.revision
      const previous = statusRef.current[session.id]
      statusRef.current[session.id] = session.status

      const message = notify ? notification(session, previous) : null
      if (message?.kind === 'attention' && session.transport === 'external') {
        notifyUserActionWhenBackground(message.title, message.description)
      }

      if (
        message &&
        !suppressNotificationsRef.current &&
        !(session.transport !== 'external' && session.status === 'waiting-input')
      ) {
        const options = {
          description: message.description,
          action:
            navigateRef.current && !isExternalSessionEnded(session)
              ? {
                  label: 'Open session',
                  onClick: () => {
                    select(session.id)
                    navigateRef.current?.()
                  }
                }
              : undefined
        }
        if (message.kind === 'attention') toast.warning(message.title, options)
        else if (message.kind === 'error') toast.error(message.title, options)
        else toast.success(message.title, options)
      }

      if (isExternalSessionEnded(session)) {
        removeLocalSession(session.id)
        return
      }
      if (session.transport === 'external') {
        if (externalRevisionsRef.current[session.id] === undefined) clearLocalDetails(session.id)
        externalRevisionsRef.current[session.id] = session.revision
      } else delete externalRevisionsRef.current[session.id]
      setById((current) => ({ ...current, [session.id]: session }))
    },
    [select, removeLocalSession, clearLocalDetails]
  )

  const notifyNativeInteraction = React.useCallback(
    (session: TerminalSession, requestId: string, message: string): void => {
      const title = `${session.label} needs your input`
      notifyUserActionWhenBackground(title, message)
      if (suppressNotificationsRef.current) return
      toast.warning(title, {
        description: message,
        action: navigateRef.current
          ? {
              label: 'Open request',
              onClick: () => {
                select(session.id, requestId)
                navigateRef.current?.()
              }
            }
          : undefined
      })
    },
    [select]
  )
  const rekeyNative = React.useCallback(
    (previous: string, actual: string): void => {
      if (forgottenRef.current.has(previous)) return
      forgottenRef.current.add(previous)
      clearLocalDetails(previous)
      setById((current) => {
        const next = { ...current }
        delete next[previous]
        return next
      })
      setSelectedId((current) => (current === previous ? actual : current))
    },
    [clearLocalDetails]
  )
  const native = useNativeSessions(byId, ingest, notifyNativeInteraction, rekeyNative)
  const { registerNative, forgetNative } = native

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
        const revision = revisionsRef.current[id]
        const entries = await window.api.terminalSessions.history(id)
        if (
          externalRevisionsRef.current[id] === undefined &&
          revisionsRef.current[id] === revision
        ) {
          mergeEntries(id, entries)
        }
      } catch (error) {
        console.error('[sessions] transcript load failed:', error)
        toast.error('Could not load the session history.')
      }
    },
    [mergeEntries]
  )

  React.useEffect(() => {
    let cancelled = false
    let unsubscribe = (): void => {}
    void window.api.terminalSessions
      .onUpdate((update) => {
        if (cancelled) return
        ingest(update.session, true)
        if (update.session.transport !== 'external') mergeEntries(update.session.id, update.entries)
      })
      .then(async (stopUpdates) => {
        if (cancelled) {
          stopUpdates()
          return
        }
        unsubscribe = stopUpdates

        const list = await window.api.terminalSessions.list()
        if (cancelled) return
        // Seed silently: statuses restored from the database are history, not news.
        for (const session of list) ingest(session, false)
      })
      .catch((error) => {
        console.error('[sessions] failed to initialize desktop session updates:', error)
        if (!cancelled) toast.error('Could not load Copilot sessions. Please restart DevTrees.')
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [ingest, mergeEntries])

  const start = React.useCallback(
    async (
      req: StartTerminalSessionRequest,
      foreground = true
    ): Promise<TerminalSession | null> => {
      if (req.resumeSessionId) {
        forgottenRef.current.delete(req.resumeSessionId)
        registerNative(req.resumeSessionId)
      }
      const result = await window.api.terminalSessions.start(req)
      if (!result.ok) {
        toast.error(result.error)
        return null
      }
      forgottenRef.current.delete(result.session.id)
      if (result.session.transport !== 'external') registerNative(result.session.id)
      else {
        forgetNative(result.session.id)
        clearLocalDetails(result.session.id)
      }
      ingest(result.session, false)
      if (foreground) {
        select(result.session.id)
        navigateRef.current?.()
      }
      return result.session
    },
    [ingest, select, registerNative, forgetNative, clearLocalDetails]
  )

  const forget = React.useCallback(
    async (id: string): Promise<void> => {
      await window.api.terminalSessions.forget(id)
      delete externalRevisionsRef.current[id]
      forgottenRef.current.add(id)
      forgetNative(id)
      delete statusRef.current[id]
      delete revisionsRef.current[id]
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
    },
    [forgetNative]
  )

  const sessions = React.useMemo(
    () =>
      Object.values(byId)
        .filter((session): session is TerminalSession => Boolean(session))
        .sort((a, b) => b.createdAt - a.createdAt),
    [byId]
  )

  React.useEffect(() => {
    let active = true
    let pending = false
    const reconcile = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const before = { ...externalRevisionsRef.current }
        const list = await window.api.terminalSessions.list()
        if (active) {
          for (const id of missingExternalSessions(before, externalRevisionsRef.current, list)) {
            revisionsRef.current[id] = Math.max(revisionsRef.current[id] ?? 0, before[id] + 1)
            removeLocalSession(id)
          }
          for (const session of list) ingest(session, true)
        }
      } catch (error) {
        console.error('[sessions] status reconciliation failed:', error)
      } finally {
        pending = false
      }
    }
    const timer = setInterval(() => {
      setObservationNow(Date.now())
      void reconcile()
    }, 5000)
    const onFocus = (): void => {
      void reconcile()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [ingest, removeLocalSession])

  const value = React.useMemo<TerminalSessionsContextValue>(
    () => ({
      ...native,
      sessions,
      byId,
      entriesById,
      loadHistory,
      selectedId,
      selectedInteractionId,
      selectionRevision,
      observationNow,
      select,
      start,
      forget
    }),
    [
      native,
      sessions,
      byId,
      entriesById,
      loadHistory,
      selectedId,
      selectedInteractionId,
      selectionRevision,
      observationNow,
      select,
      start,
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
