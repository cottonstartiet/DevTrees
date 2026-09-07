import type { TerminalSession, TerminalTimelineEntry } from './terminal-session'

export type PermissionScope = { action: string; label: string; description: string }

export type NativeInteraction = { id: string; createdAt: number } & (
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
}

export type NativeDraft = Record<string, string | boolean | string[]>

export function endedNativeHistory(entries: TerminalTimelineEntry[]): TerminalTimelineEntry[] {
  return entries.map((entry) => {
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

export function acceptNativeSnapshot(
  incoming: NativeSnapshot,
  previous?: NativeSnapshot,
  known?: TerminalSession
): boolean {
  if (incoming.session.transport !== 'sdk' || !incoming.session.generation) return false
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
