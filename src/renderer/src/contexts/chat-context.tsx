/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'

import type { ChatContext, ChatConversation, ChatMessage } from '@shared/chat'

type ChatContextValue = {
  conversations: ChatConversation[]
  activeConversation: ChatConversation | null
  messages: ChatMessage[]
  loading: boolean
  sending: boolean
  selectConversation: (id: string) => void
  createConversation: (context?: ChatContext) => Promise<ChatConversation | null>
  deleteConversation: (id: string) => Promise<void>
  updateContext: (context?: ChatContext) => Promise<void>
  send: (prompt: string) => Promise<void>
  abort: () => Promise<void>
}

const Context = React.createContext<ChatContextValue | null>(null)

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index < 0) return [...messages, message]
  const next = messages.slice()
  next[index] = message
  return next
}

export function ChatProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [conversations, setConversations] = React.useState<ChatConversation[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [messagesById, setMessagesById] = React.useState<Record<string, ChatMessage[]>>({})
  const [loading, setLoading] = React.useState(true)
  const [sendingIds, setSendingIds] = React.useState<ReadonlySet<string>>(() => new Set())
  const conversationsRef = React.useRef<ChatConversation[]>([])
  const conversationsVersionRef = React.useRef(0)
  const conversationsRequestRef = React.useRef(0)
  const messageVersionsRef = React.useRef<Record<string, number>>({})

  const reloadConversations = React.useCallback(async (): Promise<ChatConversation[]> => {
    const version = conversationsVersionRef.current
    const request = ++conversationsRequestRef.current
    const list = await window.api.chat.listConversations()
    if (
      version === conversationsVersionRef.current &&
      request === conversationsRequestRef.current
    ) {
      conversationsRef.current = list
      setConversations(list)
    }
    return list
  }, [])

  React.useEffect(() => {
    let active = true
    const version = conversationsVersionRef.current
    const request = ++conversationsRequestRef.current
    window.api.chat
      .listConversations()
      .then((list) => {
        if (
          !active ||
          version !== conversationsVersionRef.current ||
          request !== conversationsRequestRef.current
        ) {
          return
        }
        conversationsRef.current = list
        setConversations(list)
        setActiveId((current) => current ?? list[0]?.id ?? null)
      })
      .catch((error) => {
        if (active) toast.error(errorMessage(error, 'Could not load chats.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  React.useEffect(() => {
    if (!activeId || messagesById[activeId]) return
    let active = true
    const version = messageVersionsRef.current[activeId] ?? 0
    window.api.chat
      .listMessages(activeId)
      .then((messages) => {
        if (active && version === (messageVersionsRef.current[activeId] ?? 0)) {
          setMessagesById((current) => ({ ...current, [activeId]: messages }))
        }
      })
      .catch((error) => {
        if (active) toast.error(errorMessage(error, 'Could not load messages.'))
      })
    return () => {
      active = false
    }
  }, [activeId, messagesById])

  React.useEffect(() => {
    const offDelta = window.api.chat.onDelta((event) => {
      setMessagesById((current) => {
        const messages = current[event.conversationId] ?? []
        const exact = messages.find((item) => item.id === event.messageId)
        const optimistic = messages.find(
          (item) => item.role === 'assistant' && item.status === 'streaming'
        )
        const target = exact ?? optimistic
        const message: ChatMessage = {
          id: event.messageId,
          conversationId: event.conversationId,
          role: 'assistant',
          content: `${target?.content ?? ''}${event.delta}`,
          status: 'streaming',
          createdAt: target?.createdAt ?? Date.now()
        }
        const withoutOptimistic =
          optimistic && optimistic.id !== event.messageId
            ? messages.filter((item) => item.id !== optimistic.id)
            : messages
        return {
          ...current,
          [event.conversationId]: upsertMessage(withoutOptimistic, message)
        }
      })
    })
    const offComplete = window.api.chat.onComplete((event) => {
      setMessagesById((current) => ({
        ...current,
        [event.conversationId]: upsertMessage(
          (current[event.conversationId] ?? []).filter(
            (item) => item.role !== 'assistant' || item.status !== 'streaming'
          ),
          event.message
        )
      }))
    })
    const offError = window.api.chat.onError((event) => {
      setMessagesById((current) => ({
        ...current,
        [event.conversationId]: (current[event.conversationId] ?? []).map((item) =>
          item.role === 'assistant' && item.status === 'streaming'
            ? { ...item, id: event.messageId, status: 'error', error: event.error }
            : item
        )
      }))
    })
    return () => {
      offDelta()
      offComplete()
      offError()
    }
  }, [])

  const createConversation = React.useCallback(
    async (context?: ChatContext): Promise<ChatConversation | null> => {
      try {
        const conversation = await window.api.chat.createConversation(context)
        conversationsVersionRef.current += 1
        const next = [
          conversation,
          ...conversationsRef.current.filter((item) => item.id !== conversation.id)
        ]
        conversationsRef.current = next
        setConversations(next)
        setMessagesById((current) => ({ ...current, [conversation.id]: [] }))
        setActiveId(conversation.id)
        void reloadConversations().catch((error) => {
          toast.error(errorMessage(error, 'Could not refresh chats.'))
        })
        return conversation
      } catch (error) {
        toast.error(errorMessage(error, 'Could not create chat.'))
        return null
      }
    },
    [reloadConversations]
  )

  const deleteConversation = React.useCallback(async (id: string): Promise<void> => {
    try {
      await window.api.chat.deleteConversation(id)
      conversationsVersionRef.current += 1
      delete messageVersionsRef.current[id]
      const next = conversationsRef.current.filter((item) => item.id !== id)
      conversationsRef.current = next
      setConversations(next)
      setMessagesById((current) => {
        const copy = { ...current }
        delete copy[id]
        return copy
      })
      setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current))
    } catch (error) {
      toast.error(errorMessage(error, 'Could not delete chat.'))
    }
  }, [])

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeId) ?? null
  const sending = activeId ? sendingIds.has(activeId) : false

  const updateContext = React.useCallback(
    async (context?: ChatContext): Promise<void> => {
      if (!activeId) return
      try {
        const updated = await window.api.chat.updateContext(activeId, context)
        conversationsVersionRef.current += 1
        const next = conversationsRef.current.map((conversation) =>
          conversation.id === updated.id ? updated : conversation
        )
        conversationsRef.current = next
        setConversations(next)
      } catch (error) {
        toast.error(errorMessage(error, 'Could not update chat context.'))
      }
    },
    [activeId]
  )

  const send = React.useCallback(
    async (prompt: string): Promise<void> => {
      let conversationId = activeId
      if (!conversationId) {
        const created = await createConversation()
        conversationId = created?.id ?? null
      }
      if (!conversationId) return
      messageVersionsRef.current[conversationId] =
        (messageVersionsRef.current[conversationId] ?? 0) + 1
      const userId = `local-user-${Date.now()}`
      const assistantId = `local-assistant-${Date.now()}`
      const createdAt = Date.now()
      setMessagesById((current) => ({
        ...current,
        [conversationId]: [
          ...(current[conversationId] ?? []),
          {
            id: userId,
            conversationId,
            role: 'user',
            content: prompt.trim(),
            status: 'completed',
            createdAt
          },
          {
            id: assistantId,
            conversationId,
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: createdAt + 1
          }
        ]
      }))
      setSendingIds((current) => new Set(current).add(conversationId))
      try {
        await window.api.chat.send(conversationId, prompt)
        const [persisted] = await Promise.all([
          window.api.chat.listMessages(conversationId),
          reloadConversations()
        ])
        setMessagesById((current) => ({ ...current, [conversationId]: persisted }))
      } catch (error) {
        const message = errorMessage(error, 'Copilot could not respond.')
        setMessagesById((current) => ({
          ...current,
          [conversationId]: (current[conversationId] ?? []).map((item) =>
            item.id === assistantId ? { ...item, status: 'error', error: message } : item
          )
        }))
        try {
          await reloadConversations()
        } catch {
          // Keep the local title until a later refresh if persistence cannot be reloaded.
        }
      } finally {
        setSendingIds((current) => {
          const next = new Set(current)
          next.delete(conversationId)
          return next
        })
      }
    },
    [activeId, createConversation, reloadConversations]
  )

  const abort = React.useCallback(async (): Promise<void> => {
    if (!activeId) return
    try {
      await window.api.chat.abort(activeId)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not stop the response.'))
    }
  }, [activeId])

  const value = React.useMemo<ChatContextValue>(
    () => ({
      conversations,
      activeConversation,
      messages: activeId ? (messagesById[activeId] ?? []) : [],
      loading,
      sending,
      selectConversation: setActiveId,
      createConversation,
      deleteConversation,
      updateContext,
      send,
      abort
    }),
    [
      conversations,
      activeConversation,
      activeId,
      messagesById,
      loading,
      sending,
      createConversation,
      deleteConversation,
      updateContext,
      send,
      abort
    ]
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useChat(): ChatContextValue {
  const value = React.useContext(Context)
  if (!value) throw new Error('useChat must be used within ChatProvider.')
  return value
}
