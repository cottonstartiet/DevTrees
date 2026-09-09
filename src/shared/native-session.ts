import type {
  TerminalSession,
  TerminalSessionStatus,
  TerminalTimelineEntry
} from './terminal-session'

export type PermissionScope = { action: string; label: string; description: string }

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export type NativeInteraction = { id: string; createdAt: number } & (
  | {
      kind: 'acpPermission'
      message: string
      options: AcpPermissionOption[]
      detail: string
    }
  | {
      kind: 'permission'
      message: string
      permissionKind: string
      target: string | null
      intention: string | null
      diff: string | null
      detail: string
      managed: boolean
      scopes: PermissionScope[]
    }
  | {
      kind: 'elicitation'
      message: string
      schema: unknown
      url: string | null
      unsupported: string | null
    }
  | { kind: 'question'; message: string; choices: string[]; allowFreeform: boolean }
  | { kind: 'plan'; message: string; plan: string | null; actions: string[] }
  | { kind: 'autoMode'; message: string }
)

export type NativeAnswer =
  | { kind: 'permission'; action: string }
  | {
      kind: 'elicitation'
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }
  | { kind: 'question'; answer: string; wasFreeform: boolean }
  | { kind: 'plan'; approved: boolean; selectedAction?: string; feedback?: string }
  | { kind: 'autoMode'; approved: boolean }
  | { kind: 'cancel' }

export type NativeSnapshot = {
  session: TerminalSession
  interactions: NativeInteraction[]
  entries: TerminalTimelineEntry[]
  historyTruncated: boolean
  error: string | null
  commands?: AcpCommand[]
  commandsReady?: boolean
  capabilities?: {
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: { list?: Record<string, unknown>; close?: Record<string, unknown> }
    loadSession?: boolean
  }
  queue?: QueuedPrompt[]
  queuePaused?: boolean
  phase?: string
  replacesId?: string | null
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } } | null
  availableModes: { id: string; name: string }[]
  currentModeId?: string | null
  planTransitionAvailable: boolean
}

export function nativeSessionNeedsUserAction(
  session: TerminalSession,
  snapshot?: NativeSnapshot
): boolean {
  if (session.status === 'done' || session.status === 'error') return false
  if (session.status === 'waiting-input') return true
  return Boolean(
    session.transport !== 'external' &&
    snapshot &&
    snapshot.session.id === session.id &&
    snapshot.session.generation === session.generation &&
    (snapshot.interactions.length > 0 || snapshot.planTransitionAvailable)
  )
}

export function nativeSessionPresentationStatus(
  session: TerminalSession,
  snapshot?: NativeSnapshot
): TerminalSessionStatus {
  return nativeSessionNeedsUserAction(session, snapshot) ? 'waiting-input' : session.status
}

export function nativeSessionCanReplyToPlan(
  session: TerminalSession,
  snapshot?: NativeSnapshot
): boolean {
  return Boolean(
    session.transport === 'acp' &&
    session.status !== 'done' &&
    session.status !== 'error' &&
    snapshot &&
    snapshot.session.id === session.id &&
    snapshot.session.generation === session.generation &&
    snapshot.planTransitionAvailable &&
    snapshot.interactions.length === 0
  )
}

export type PlanTransitionAction = 'interactive' | 'autopilot' | 'autopilot_fleet' | 'exit_only'

export type AcpCommand = { name: string; description: string; input?: { hint: string } }

export function acpPermissionOptionScope(kind: string): string {
  switch (kind) {
    case 'allow_once':
      return 'Allows only this operation.'
    case 'allow_always':
      return 'Copilot remembers this choice for matching requests.'
    case 'reject_once':
      return 'Rejects only this operation.'
    case 'reject_always':
      return 'Copilot remembers this rejection for matching requests.'
    default:
      return 'Copilot controls the scope of this choice.'
  }
}

export function acpPermissionOptionIsRemembered(kind: string): boolean {
  return kind === 'allow_always' || kind === 'reject_always'
}

export function acpCommandQuery(message: string): string | null {
  if (!message.startsWith('/')) return null
  const query = message.slice(1)
  return /\s/.test(query) ? null : query.toLowerCase()
}

export function matchingAcpCommands(message: string, commands: AcpCommand[]): AcpCommand[] {
  const query = acpCommandQuery(message)
  if (query === null) return []
  return commands.filter((command) =>
    `${command.name} ${command.description}`.toLowerCase().includes(query)
  )
}

export function acpCommandDraft(command: AcpCommand): string {
  return `/${command.name}${command.input?.hint ? ' ' : ''}`
}

export type PromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name: string }
export type QueuedPrompt = {
  id: string
  text: string
  attachmentCount: number
  status:
    | 'queued'
    | 'dispatching'
    | 'active'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'delivery-unknown'
  error: string | null
}

export type NativeDraft = Record<string, string | boolean | string[]>

function isPromptContent(value: unknown): value is PromptContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const block = value as Record<string, unknown>
  if (block.type === 'text') return typeof block.text === 'string'
  if (block.type === 'image')
    return typeof block.data === 'string' && typeof block.mimeType === 'string'
  if (block.type === 'resource_link')
    return typeof block.uri === 'string' && typeof block.name === 'string'
  if (block.type !== 'resource' || !block.resource || typeof block.resource !== 'object')
    return false
  const resource = block.resource as Record<string, unknown>
  return (
    typeof resource.uri === 'string' &&
    typeof resource.text === 'string' &&
    (resource.mimeType === undefined || typeof resource.mimeType === 'string')
  )
}

export function parsePromptAttachments(value: string): {
  content: PromptContent[]
  error?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { content: [], error: 'The attachment draft is not valid JSON.' }
  }
  if (!Array.isArray(parsed) || !parsed.every(isPromptContent)) {
    return { content: [], error: 'The attachment draft contains unsupported content.' }
  }
  return { content: parsed }
}

export function endedNativeHistory(entries: TerminalTimelineEntry[]): TerminalTimelineEntry[] {
  return entries.map((entry) => {
    if (
      entry.kind === 'acp' &&
      entry.category === 'tool' &&
      entry.data &&
      typeof entry.data === 'object'
    ) {
      const data = entry.data as Record<string, unknown>
      if (!data.status || data.status === 'pending' || data.status === 'in_progress') {
        return { ...entry, data: { ...data, status: 'incomplete' } }
      }
    }
    if (entry.kind === 'toolCall' && entry.success == null) {
      return {
        ...entry,
        success: false,
        result: entry.result ?? 'The previous runtime ended without a tool completion result.'
      }
    }
    if (entry.kind === 'permission' && entry.resolution == null) {
      return { ...entry, resolution: 'This request is no longer active; the runtime ended.' }
    }
    return entry
  })
}

export function nativeKey(
  session: Pick<TerminalSession, 'id' | 'generation'>,
  request = 'composer'
): string {
  return JSON.stringify([session.id, session.generation, request])
}

export function rekeyNativeState<T>(
  values: Record<string, T>,
  previous: string,
  session: Pick<TerminalSession, 'id' | 'generation'>
): Record<string, T> {
  let next = values
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith('[')) continue
    const identity: unknown = JSON.parse(key)
    if (!Array.isArray(identity) || identity[0] !== previous || identity[1] !== session.generation)
      continue
    if (next === values) next = { ...values }
    const target = nativeKey(session, String(identity[2]))
    if (!(target in next)) next[target] = value
    delete next[key]
  }
  return next
}

export function acceptNativeSnapshot(
  incoming: NativeSnapshot,
  previous?: NativeSnapshot,
  known?: TerminalSession
): boolean {
  if (incoming.session.transport === 'external' || !incoming.session.generation) return false
  if (known && incoming.session.revision < known.revision) return false
  if (
    known &&
    incoming.session.revision === known.revision &&
    incoming.session.generation !== known.generation
  )
    return false
  if (!previous) return true
  return (
    incoming.session.revision > previous.session.revision ||
    (incoming.session.revision === previous.session.revision &&
      incoming.session.generation === previous.session.generation)
  )
}

export type NativeField = {
  name: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title: string
  description?: string
  required: boolean
  choices?: { value: string; label: string }[]
  initial?: string | boolean | string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unsupported form schema.')
  return value as Record<string, unknown>
}

function choices(value: Record<string, unknown>): NativeField['choices'] {
  if (Array.isArray(value.enum)) {
    const names = Array.isArray(value.enumNames) ? value.enumNames : []
    return value.enum.map((entry, index) => {
      if (typeof entry !== 'string') throw new Error('Unsupported choice type.')
      return { value: entry, label: typeof names[index] === 'string' ? names[index] : entry }
    })
  }
  const options = value.oneOf ?? value.anyOf
  if (!Array.isArray(options)) return undefined
  return options.map((entry: unknown) => {
    const option = object(entry)
    if (typeof option.const !== 'string') throw new Error('Unsupported choice type.')
    return {
      value: option.const,
      label: typeof option.title === 'string' ? option.title : option.const
    }
  })
}

export function nativeFields(schema: unknown): NativeField[] {
  const root = object(schema)
  const required = Array.isArray(root.required) ? root.required : []
  return Object.entries(object(root.properties)).map(([name, value]) => {
    const field = object(value)
    const type = field.type
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'integer' &&
      type !== 'boolean' &&
      type !== 'array'
    ) {
      throw new Error(`Unsupported field: ${name}.`)
    }
    const initial = field.default
    return {
      name,
      type,
      title: typeof field.title === 'string' ? field.title : name,
      description: typeof field.description === 'string' ? field.description : undefined,
      required: required.includes(name),
      choices: choices(type === 'array' ? object(field.items) : field),
      initial:
        typeof initial === 'string' || typeof initial === 'boolean'
          ? initial
          : typeof initial === 'number'
            ? String(initial)
            : Array.isArray(initial) && initial.every((item: unknown) => typeof item === 'string')
              ? initial
              : undefined,
      minimum: typeof field.minimum === 'number' ? field.minimum : undefined,
      maximum: typeof field.maximum === 'number' ? field.maximum : undefined,
      minLength: typeof field.minLength === 'number' ? field.minLength : undefined,
      maxLength: typeof field.maxLength === 'number' ? field.maxLength : undefined,
      minItems: typeof field.minItems === 'number' ? field.minItems : undefined,
      maxItems: typeof field.maxItems === 'number' ? field.maxItems : undefined
    }
  })
}

export function initialNativeDraft(fields: NativeField[]): NativeDraft {
  return Object.fromEntries(
    fields
      .filter((field) => field.initial !== undefined)
      .map((field) => [field.name, field.initial!])
  )
}

export function nativeFormContent(
  fields: NativeField[],
  draft: NativeDraft
): Record<string, unknown> {
  const content: Record<string, unknown> = Object.create(null)
  for (const field of fields) {
    const value = Object.hasOwn(draft, field.name) ? draft[field.name] : undefined
    if (
      value === undefined ||
      (value === '' && (field.type === 'number' || field.type === 'integer'))
    ) {
      if (field.required) throw new Error(`${field.title} is required.`)
      continue
    }
    if (field.type === 'integer' || field.type === 'number') {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isSafeInteger(number))) {
        throw new Error(
          `${field.title} must be ${field.type === 'integer' ? 'a whole number' : 'a number'}.`
        )
      }
      content[field.name] = number
    } else content[field.name] = value
  }
  return content
}
