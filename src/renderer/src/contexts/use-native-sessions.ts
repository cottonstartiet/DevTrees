import * as React from 'react'
import {
  acceptNativeSnapshot,
  nativeKey,
  type NativeAnswer,
  type NativeDraft,
  type NativeSnapshot
} from '@shared/native-session'
import {
  isTerminalSessionFinished,
  type TerminalSession,
  type TerminalTarget
} from '@shared/terminal-session'

function target(session: TerminalSession): TerminalTarget {
  if (!session.generation || session.transport !== 'sdk')
    throw new Error('This is not a connected native session.')
  return { id: session.id, generation: session.generation }
}

export function nativeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One owner for snapshots, submissions and drafts, shared by Session and Dashboard. */
export function useNativeSessions(
  sessions: Record<string, TerminalSession | undefined>,
  ingest: (session: TerminalSession, notify: boolean) => void,
  onInteraction: (session: TerminalSession, requestId: string, message: string) => void
) {
  const [nativeById, setNativeById] = React.useState<Record<string, NativeSnapshot | undefined>>({})
  const [nativeDrafts, setNativeDrafts] = React.useState<Record<string, NativeDraft | undefined>>(
    {}
  )
  const [nativeErrors, setNativeErrors] = React.useState<Record<string, string | undefined>>({})
  const [nativeBusy, setNativeBusy] = React.useState<Record<string, boolean | undefined>>({})
  const snapshots = React.useRef(nativeById)
  const known = React.useRef(sessions)
  const submitting = React.useRef(new Set<string>())
  const ignored = React.useRef(new Set<string>())
  React.useEffect(() => {
    known.current = sessions
  }, [sessions])

  const apply = React.useCallback(
    (snapshot: NativeSnapshot): void => {
      const id = snapshot.session.id
      if (
        ignored.current.has(id) ||
        !acceptNativeSnapshot(snapshot, snapshots.current[id], known.current[id])
      )
        return
      const previous = snapshots.current[id]
      snapshots.current = { ...snapshots.current, [id]: snapshot }
      setNativeById(snapshots.current)
      ingest(snapshot.session, true)
      for (const request of snapshot.interactions) {
        if (
          !previous ||
          previous.session.generation !== snapshot.session.generation ||
          !previous.interactions.some((old) => old.id === request.id)
        ) {
          onInteraction(snapshot.session, request.id, request.message)
        }
      }
    },
    [ingest, onInteraction]
  )

  const refreshNative = React.useCallback(
    async (session: TerminalSession): Promise<void> => {
      const key = nativeKey(session, 'connection')
      try {
        const snapshot = await window.api.nativeSessions.snapshot(target(session))
        apply(snapshot)
        setNativeErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
      } catch (error) {
        setNativeErrors((current) => ({ ...current, [key]: nativeError(error) }))
        throw error
      }
    },
    [apply]
  )

  React.useEffect(() => {
    let active = true
    let stop = (): void => {}
    void window.api.nativeSessions
      .onUpdate((snapshot) => {
        if (active) apply(snapshot)
      })
      .then(async (unsubscribe) => {
        if (!active) {
          unsubscribe()
          return
        }
        stop = unsubscribe
        const list = await window.api.terminalSessions.list()
        for (const session of list) {
          if (active && session.transport === 'sdk' && !isTerminalSessionFinished(session.status)) {
            await refreshNative(session)
          }
        }
      })
      .catch((error) => {
        console.error('[native sessions] subscription failed:', error)
        if (active)
          setNativeErrors((current) => ({
            ...current,
            connection: `Native controls could not connect: ${nativeError(error)}. Restart DevTrees to reconnect.`
          }))
      })
    return () => {
      active = false
      stop()
    }
  }, [apply, refreshNative])

  React.useEffect(() => {
    let refreshing = false
    let active = true
    const reconcile = async (): Promise<void> => {
      if (refreshing) return
      refreshing = true
      try {
        for (const session of Object.values(known.current)) {
          if (!active) break
          if (!session || session.transport !== 'sdk' || isTerminalSessionFinished(session.status))
            continue
          try {
            await refreshNative(session)
          } catch (error) {
            if (active)
              setNativeErrors((current) => ({
                ...current,
                [nativeKey(session, 'connection')]: nativeError(error)
              }))
          }
        }
      } finally {
        refreshing = false
      }
    }
    const timer = setInterval(() => {
      void reconcile()
    }, 5000)
    const focus = (): void => {
      void reconcile()
    }
    window.addEventListener('focus', focus)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [refreshNative])

  const setNativeDraft = React.useCallback((key: string, draft: NativeDraft): void => {
    setNativeDrafts((current) => ({ ...current, [key]: draft }))
  }, [])

  const runNative = React.useCallback(
    async (
      session: TerminalSession,
      key: string,
      operation: () => Promise<void>,
      clearDraft = false
    ): Promise<boolean> => {
      if (submitting.current.has(key)) return false
      submitting.current.add(key)
      setNativeBusy((current) => ({ ...current, [key]: true }))
      setNativeErrors((current) => ({ ...current, [key]: undefined }))
      try {
        await operation()
        if (clearDraft)
          setNativeDrafts((current) => {
            const next = { ...current }
            delete next[key]
            return next
          })
        return true
      } catch (error) {
        setNativeErrors((current) => ({ ...current, [key]: nativeError(error) }))
        // Refresh state, never retry a potentially delivered approval or prompt.
        try {
          await refreshNative(session)
        } catch (refreshError) {
          setNativeErrors((current) => ({
            ...current,
            [nativeKey(session, 'connection')]: nativeError(refreshError)
          }))
        }
        return false
      } finally {
        submitting.current.delete(key)
        setNativeBusy((current) => ({ ...current, [key]: false }))
      }
    },
    [refreshNative]
  )

  const respondNative = React.useCallback(
    (
      session: TerminalSession,
      interactionId: string,
      answer: NativeAnswer,
      prepare?: () => Promise<void>
    ): Promise<boolean> =>
      runNative(
        session,
        nativeKey(session, interactionId),
        async () => {
          await prepare?.()
          apply(await window.api.nativeSessions.respond(target(session), interactionId, answer))
        },
        true
      ),
    [apply, runNative]
  )

  const promptNative = React.useCallback(
    (session: TerminalSession, prompt: string, clearDraft = true): Promise<boolean> =>
      runNative(
        session,
        nativeKey(session),
        () => window.api.nativeSessions.prompt(target(session), prompt),
        clearDraft
      ),
    [runNative]
  )

  const stopNative = React.useCallback(
    (session: TerminalSession): Promise<boolean> =>
      runNative(session, nativeKey(session, 'lifecycle'), () =>
        window.api.nativeSessions.cancel(target(session))
      ),
    [runNative]
  )

  const endNative = React.useCallback(
    (session: TerminalSession): Promise<boolean> =>
      runNative(session, nativeKey(session, 'lifecycle'), () =>
        window.api.nativeSessions.end(target(session))
      ),
    [runNative]
  )

  const forgetNative = React.useCallback((id: string): void => {
    ignored.current.add(id)
    const next = { ...snapshots.current }
    delete next[id]
    snapshots.current = next
    setNativeById(next)
    setNativeDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => {
          const identity: unknown = JSON.parse(key)
          return !Array.isArray(identity) || identity[0] !== id
        })
      )
    )
  }, [])

  const registerNative = React.useCallback((id: string): void => {
    ignored.current.delete(id)
  }, [])

  return {
    nativeById,
    nativeDrafts,
    nativeErrors,
    nativeBusy,
    setNativeDraft,
    refreshNative,
    respondNative,
    promptNative,
    stopNative,
    endNative,
    forgetNative,
    registerNative
  }
}

export type NativeSessionsContextValue = ReturnType<typeof useNativeSessions>
