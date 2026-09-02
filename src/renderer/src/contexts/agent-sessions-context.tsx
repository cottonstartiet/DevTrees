/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'

import type {
  AgentPendingInteraction,
  AgentSession,
  AgentSessionEvent,
  AgentSessionSnapshot,
  CreateAgentSessionRequest,
  CreateAgentSessionResult,
  ResolveAgentPermissionRequest
} from '@shared/agent-session'

type SessionRecord = AgentSessionSnapshot
const MAX_LIVE_EVENTS = 2_000

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function eventStringField(event: AgentSessionEvent, field: string): string | undefined {
  const data = event.data
  if (!data || Array.isArray(data) || typeof data !== 'object') return undefined
  const value = data[field]
  return typeof value === 'string' ? value : undefined
}

function appendEvent(
  events: AgentSessionEvent[],
  incoming: AgentSessionEvent
): AgentSessionEvent[] {
  let next = [...events, incoming]
  if (incoming.type === 'assistant.message') {
    const messageId = eventStringField(incoming, 'messageId')
    next = next.filter(
      (event) =>
        event.type !== 'assistant.message_delta' ||
        !messageId ||
        eventStringField(event, 'messageId') !== messageId
    )
  } else if (incoming.type === 'assistant.reasoning') {
    const reasoningId = eventStringField(incoming, 'reasoningId')
    next = next.filter(
      (event) =>
        event.type !== 'assistant.reasoning_delta' ||
        !reasoningId ||
        eventStringField(event, 'reasoningId') !== reasoningId
    )
  } else if (incoming.type === 'tool.execution_complete') {
    const toolCallId = eventStringField(incoming, 'toolCallId')
    next = next.filter(
      (event) =>
        !['tool.execution_partial_result', 'tool.execution_progress'].includes(event.type) ||
        !toolCallId ||
        eventStringField(event, 'toolCallId') !== toolCallId
    )
  }
  return next.length > MAX_LIVE_EVENTS ? next.slice(-MAX_LIVE_EVENTS) : next
}

export type CreateAgentSessionOptions = {
  activate?: boolean
}

export interface AgentSessionsContextValue {
  sessions: AgentSession[]
  reviewSessions: AgentSession[]
  activeSessionId: string | null
  eventsBySessionId: Readonly<Record<string, AgentSessionEvent[]>>
  pendingBySessionId: Readonly<Record<string, AgentPendingInteraction[]>>
  selectSession: (id: string) => void
  cycleSession: (delta: number) => void
  createSession: (
    request: CreateAgentSessionRequest,
    options?: CreateAgentSessionOptions
  ) => Promise<CreateAgentSessionResult>
  send: (id: string, prompt: string) => Promise<void>
  abort: (id: string) => Promise<void>
  close: (id: string) => Promise<void>
  resolvePermission: (request: ResolveAgentPermissionRequest) => Promise<void>
  answerUserInput: (
    sessionId: string,
    interactionId: string,
    answer: string,
    wasFreeform: boolean
  ) => Promise<void>
}

const AgentSessionsContext = React.createContext<AgentSessionsContextValue | null>(null)

function mergeSnapshot(
  current: SessionRecord | undefined,
  incoming: AgentSessionSnapshot
): SessionRecord {
  if (!current || current.lastSeq <= incoming.lastSeq) return incoming
  const incomingIds = new Set(incoming.events.map((event) => event.id))
  return {
    session: current.session,
    events: [
      ...incoming.events,
      ...current.events.filter(
        (event) => event.seq > incoming.lastSeq && !incomingIds.has(event.id)
      )
    ],
    pendingInteractions: current.pendingInteractions,
    lastSeq: current.lastSeq
  }
}

export function AgentSessionsProvider({
  children,
  onNavigateToSessions
}: {
  children: React.ReactNode
  onNavigateToSessions?: () => void
}): React.JSX.Element {
  const [records, setRecords] = React.useState<Record<string, SessionRecord>>({})
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    const offUpdate = window.api.agentSessions.onUpdate((update) => {
      setRecords((current) => {
        const existing = current[update.session.id]
        const event =
          update.event && (!existing || update.event.seq > existing.lastSeq)
            ? update.event
            : undefined
        const pendingInteractions =
          update.session.lifecycle === 'waiting_for_user' ||
          update.session.lifecycle === 'waiting_for_permission'
            ? (existing?.pendingInteractions ?? [])
            : []
        return {
          ...current,
          [update.session.id]: {
            session: update.session,
            events: event ? appendEvent(existing?.events ?? [], event) : (existing?.events ?? []),
            pendingInteractions,
            lastSeq: Math.max(existing?.lastSeq ?? 0, event?.seq ?? update.session.lastSeq)
          }
        }
      })
    })
    const offInteraction = window.api.agentSessions.onInteraction((interaction) => {
      setRecords((current) => {
        const existing = current[interaction.sessionId]
        if (!existing) return current
        return {
          ...current,
          [interaction.sessionId]: {
            ...existing,
            pendingInteractions: [
              ...existing.pendingInteractions.filter((value) => value.id !== interaction.id),
              interaction
            ]
          }
        }
      })
    })

    void window.api.agentSessions.list().then(async (sessions) => {
      const snapshots = await Promise.all(
        sessions.map((session) => window.api.agentSessions.snapshot(session.id))
      )
      if (cancelled) return
      setRecords((current) => {
        const next = { ...current }
        for (const snapshot of snapshots) {
          next[snapshot.session.id] = mergeSnapshot(next[snapshot.session.id], snapshot)
        }
        return next
      })
    })

    return () => {
      cancelled = true
      offUpdate()
      offInteraction()
    }
  }, [])

  const sessions = React.useMemo(
    () =>
      Object.values(records)
        .map((record) => record.session)
        .filter((session) => session.lifecycle !== 'stopped')
        .sort((left, right) => left.createdAt - right.createdAt),
    [records]
  )
  const reviewSessions = React.useMemo(
    () =>
      Object.values(records)
        .map((record) => record.session)
        .filter((session) => session.purpose === 'pr_review')
        .sort((left, right) => left.createdAt - right.createdAt),
    [records]
  )

  const effectiveActiveId = React.useMemo(() => {
    if (activeSessionId && sessions.some((session) => session.id === activeSessionId)) {
      return activeSessionId
    }
    return sessions.at(-1)?.id ?? null
  }, [activeSessionId, sessions])

  const selectSession = React.useCallback((id: string): void => {
    setActiveSessionId(id)
  }, [])

  const cycleSession = React.useCallback(
    (delta: number): void => {
      if (sessions.length <= 1) return
      const index = Math.max(
        0,
        sessions.findIndex((session) => session.id === effectiveActiveId)
      )
      setActiveSessionId(sessions[(index + delta + sessions.length) % sessions.length].id)
    },
    [effectiveActiveId, sessions]
  )

  const createSession = React.useCallback(
    async (
      request: CreateAgentSessionRequest,
      options?: CreateAgentSessionOptions
    ): Promise<CreateAgentSessionResult> => {
      const result = await window.api.agentSessions.create(request)
      if (result.ok) {
        setRecords((current) => ({
          ...current,
          [result.session.id]: current[result.session.id] ?? {
            session: result.session,
            events: [],
            pendingInteractions: [],
            lastSeq: result.session.lastSeq
          }
        }))
        if (options?.activate !== false) {
          setActiveSessionId(result.session.id)
          onNavigateToSessions?.()
        }
      }
      return result
    },
    [onNavigateToSessions]
  )

  const send = React.useCallback(async (id: string, prompt: string): Promise<void> => {
    await window.api.agentSessions.send(id, prompt)
  }, [])

  const abort = React.useCallback(async (id: string): Promise<void> => {
    await window.api.agentSessions.abort(id)
  }, [])

  const close = React.useCallback(async (id: string): Promise<void> => {
    try {
      await window.api.agentSessions.close(id)
      setRecords((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    } catch (error) {
      toast.error(errorMessage(error, 'Could not close the Copilot session.'))
    }
  }, [])

  const resolvePermission = React.useCallback(
    async (request: ResolveAgentPermissionRequest): Promise<void> => {
      await window.api.agentSessions.resolvePermission(request)
      setRecords((current) => {
        const existing = current[request.sessionId]
        if (!existing) return current
        return {
          ...current,
          [request.sessionId]: {
            ...existing,
            pendingInteractions: existing.pendingInteractions.filter(
              (value) => value.id !== request.interactionId
            )
          }
        }
      })
    },
    []
  )

  const answerUserInput = React.useCallback(
    async (
      sessionId: string,
      interactionId: string,
      answer: string,
      wasFreeform: boolean
    ): Promise<void> => {
      await window.api.agentSessions.answerUserInput({
        sessionId,
        interactionId,
        answer,
        wasFreeform
      })
      setRecords((current) => {
        const existing = current[sessionId]
        if (!existing) return current
        return {
          ...current,
          [sessionId]: {
            ...existing,
            pendingInteractions: existing.pendingInteractions.filter(
              (value) => value.id !== interactionId
            )
          }
        }
      })
    },
    []
  )

  const eventsBySessionId = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(records).map(([id, record]) => [id, record.events])
      ) as Record<string, AgentSessionEvent[]>,
    [records]
  )
  const pendingBySessionId = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(records).map(([id, record]) => [id, record.pendingInteractions])
      ) as Record<string, AgentPendingInteraction[]>,
    [records]
  )

  const value = React.useMemo<AgentSessionsContextValue>(
    () => ({
      sessions,
      reviewSessions,
      activeSessionId: effectiveActiveId,
      eventsBySessionId,
      pendingBySessionId,
      selectSession,
      cycleSession,
      createSession,
      send,
      abort,
      close,
      resolvePermission,
      answerUserInput
    }),
    [
      sessions,
      reviewSessions,
      effectiveActiveId,
      eventsBySessionId,
      pendingBySessionId,
      selectSession,
      cycleSession,
      createSession,
      send,
      abort,
      close,
      resolvePermission,
      answerUserInput
    ]
  )

  return <AgentSessionsContext.Provider value={value}>{children}</AgentSessionsContext.Provider>
}

export function useAgentSessions(): AgentSessionsContextValue {
  const context = React.useContext(AgentSessionsContext)
  if (!context) throw new Error('useAgentSessions must be used within AgentSessionsProvider')
  return context
}
