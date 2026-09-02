export type ChatContext = {
  kind: 'repository' | 'worktree'
  id: string
  name: string
  path: string
}

export type ChatConversation = {
  id: string
  title: string
  sdkSessionId?: string
  context?: ChatContext
  createdAt: number
  updatedAt: number
}

export type ChatMessage = {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'completed' | 'error'
  error?: string
  createdAt: number
}

export type ChatDeltaEvent = {
  conversationId: string
  messageId: string
  delta: string
}

export type ChatCompleteEvent = {
  conversationId: string
  message: ChatMessage
}

export type ChatErrorEvent = {
  conversationId: string
  messageId: string
  error: string
}

export const ChatEvents = {
  Delta: 'chat:delta',
  Complete: 'chat:complete',
  Error: 'chat:error'
} as const
