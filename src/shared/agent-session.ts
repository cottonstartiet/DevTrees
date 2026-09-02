export type AgentSessionPurpose = 'pr_review' | 'interactive'

export type AgentSessionLifecycle =
  | 'initializing'
  | 'active'
  | 'idle'
  | 'waiting_for_user'
  | 'waiting_for_permission'
  | 'failed'
  | 'stopped'

export type AgentSessionActivity =
  | 'none'
  | 'intent'
  | 'reasoning'
  | 'streaming_message'
  | 'running_tool'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type AgentSession = {
  id: string
  sdkSessionId?: string
  purpose: AgentSessionPurpose
  label: string
  folderPath: string
  branch?: string
  repository?: string
  provider?: string
  prId?: string
  prTitle?: string
  lifecycle: AgentSessionLifecycle
  activity: AgentSessionActivity
  currentIntent?: string
  lastError?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
  lastSeq: number
}

export type AgentSessionEvent = {
  sessionId: string
  seq: number
  id: string
  type: string
  timestamp: string
  parentId?: string
  agentId?: string
  ephemeral: boolean
  data: JsonValue
}

export type AgentPermissionRequest = {
  id: string
  sessionId: string
  kind: 'permission'
  requestId: string
  toolName?: string
  description: string
  payload: JsonValue
  createdAt: number
}

export type AgentUserInputRequest = {
  id: string
  sessionId: string
  kind: 'user_input'
  requestId: string
  question: string
  choices?: string[]
  allowFreeform: boolean
  createdAt: number
}

export type AgentPendingInteraction = AgentPermissionRequest | AgentUserInputRequest

export type AgentSessionSnapshot = {
  session: AgentSession
  events: AgentSessionEvent[]
  pendingInteractions: AgentPendingInteraction[]
  lastSeq: number
}

export type CreateAgentSessionRequest = {
  purpose: AgentSessionPurpose
  folderPath: string
  prompt?: string
  resumeSdkSessionId?: string
  label: string
  branch?: string
  repository?: string
  provider?: string
  prId?: string
  prTitle?: string
}

export type CreateAgentSessionResult =
  | { ok: true; session: AgentSession }
  | { ok: false; error: string }

export type ResolveAgentPermissionRequest = {
  sessionId: string
  interactionId: string
  decision: 'approve_once' | 'reject'
  feedback?: string
}

export type AnswerAgentUserInputRequest = {
  sessionId: string
  interactionId: string
  answer: string
  wasFreeform: boolean
}

export type AgentSessionUpdate = {
  session: AgentSession
  event?: AgentSessionEvent
}

export const AgentSessionEvents = {
  Update: 'agent-sessions:update',
  Interaction: 'agent-sessions:interaction'
} as const
