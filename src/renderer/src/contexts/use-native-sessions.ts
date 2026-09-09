import * as React from 'react'
import {
  acceptNativeSnapshot,
  nativeKey,
  rekeyNativeState,
  type NativeAnswer,
  type NativeDraft,
  type NativeSnapshot,
  type PlanTransitionAction,
  type PromptContent
} from '@shared/native-session'
import {
  isTerminalSessionFinished,
  type TerminalSession,
  type TerminalTarget
} from '@shared/terminal-session'

function target(session: TerminalSession): TerminalTarget {
  if (!session.generation || session.transport === 'external')
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
  onInteraction: (session: TerminalSession, requestId: string, message: string) => void,
  onRekey: (previous: string, actual: string) => void
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
  const promptSubmissions = React.useRef(new Map<string, { fingerprint: string; id: string }>())
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
      if (
        snapshot.replacesId &&
        snapshot.replacesId !== id &&
        !ignored.current.has(snapshot.replacesId)
      ) {
        const previousId = snapshot.replacesId
        setNativeDrafts((current) => rekeyNativeState(current, previousId, snapshot.session))
        setNativeErrors((current) => rekeyNativeState(current, previousId, snapshot.session))
        onRekey(snapshot.replacesId, id)
        ignored.current.add(snapshot.replacesId)
        delete snapshots.current[snapshot.replacesId]
      }
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
    [ingest, onInteraction, onRekey]
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
          if (
            active &&
            session.transport !== 'external' &&
            !isTerminalSessionFinished(session.status)
          ) {
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
        }
        if (active)
          setNativeErrors((current) =>
            current.connection ? { ...current, connection: undefined } : current
          )
      })
      .catch((error) => {
        console.error('[native sessions] subscription failed:', error)
        if (active)
          setNativeErrors((current) => ({
            ...current,
            connection: `Native controls could not connect: ${nativeError(error)} Restart DevTrees to reconnect.`
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
          if (
            !session ||
            session.transport === 'external' ||
            isTerminalSessionFinished(session.status)
          )
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

  const setNativeDraft = React.useCallback(
    (key: string, draft: NativeDraft | ((previous: NativeDraft) => NativeDraft)): void => {
      setNativeDrafts((current) => ({
        ...current,
        [key]: typeof draft === 'function' ? draft(current[key] ?? {}) : draft
      }))
    },
    []
  )

  const runNative = React.useCallback(
    async (
      session: TerminalSession,
      key: string,
      operation: () => Promise<void>,
      clearDraft = false
    ): Promise<boolean> => {
      if (submitting.current.has(key)) return false
      const submittedDraft = nativeDrafts[key]
      submitting.current.add(key)
      setNativeBusy((current) => ({ ...current, [key]: true }))
      setNativeErrors((current) => ({ ...current, [key]: undefined }))
      try {
        await operation()
        if (clearDraft)
          setNativeDrafts((current) => {
            if (current[key] !== submittedDraft) return current
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
    [refreshNative, nativeDrafts]
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

  const transitionPlan = React.useCallback(
    (session: TerminalSession, action: PlanTransitionAction): Promise<boolean> =>
      runNative(session, nativeKey(session, 'plan-transition'), async () => {
        apply(await window.api.nativeSessions.planTransition(target(session), action))
      }),
    [apply, runNative]
  )

  const promptNative = React.useCallback(
    (
      session: TerminalSession,
      prompt: string,
      clearDraft = true,
      attachments: PromptContent[] = [],
      literal = false
    ): Promise<boolean> => {
      const key = nativeKey(session)
      const content: PromptContent[] = [
        ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
        ...attachments
      ]
      const fingerprint = JSON.stringify([content, literal])
      let submission = promptSubmissions.current.get(key)
      if (submission?.fingerprint !== fingerprint) {
        submission = { fingerprint, id: crypto.randomUUID() }
        promptSubmissions.current.set(key, submission)
      }
      const id = submission.id
      return runNative(
        session,
        key,
        async () => {
          apply(await window.api.nativeSessions.enqueue(target(session), id, content, literal))
        },
        clearDraft
      ).then((success) => {
        if (success && promptSubmissions.current.get(key)?.id === id)
          promptSubmissions.current.delete(key)
        return success
      })
    },
    [apply, runNative]
  )

  const queueNative = React.useCallback(
    (session: TerminalSession, action: string, itemId?: string, text?: string): Promise<boolean> =>
      runNative(session, nativeKey(session, 'queue'), async () => {
        apply(await window.api.nativeSessions.queue(target(session), action, itemId, text))
      }),
    [apply, runNative]
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
    queueNative,
    nativeById,
    nativeDrafts,
    nativeErrors,
    nativeBusy,
    setNativeDraft,
    refreshNative,
    respondNative,
    transitionPlan,
    promptNative,
    stopNative,
    endNative,
    forgetNative,
    registerNative
  }
}

export type NativeSessionsContextValue = ReturnType<typeof useNativeSessions>
