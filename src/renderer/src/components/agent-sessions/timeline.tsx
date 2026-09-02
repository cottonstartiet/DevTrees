import * as React from 'react'
import { Loader2Icon } from 'lucide-react'

import { MarkdownBody } from '@/components/pr-review/markdown-body'
import { ToolCard, type ToolTimelineItem } from '@/components/agent-sessions/tool-card'
import type { AgentSession, AgentSessionEvent, JsonValue } from '@shared/agent-session'

type MessageItem = {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  streaming: boolean
}

type TimelineItem = MessageItem | { kind: 'tool'; tool: ToolTimelineItem }

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function stringField(value: JsonValue, field: string): string | undefined {
  const candidate = objectValue(value)?.[field]
  return typeof candidate === 'string' ? candidate : undefined
}

function booleanField(value: JsonValue, field: string): boolean | undefined {
  const candidate = objectValue(value)?.[field]
  return typeof candidate === 'boolean' ? candidate : undefined
}

function timelineItems(events: AgentSessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const tools = new Map<string, ToolTimelineItem>()
  const streamingMessages = new Map<string, MessageItem>()

  for (const event of events) {
    if (event.agentId && event.type.startsWith('assistant.')) continue
    if (event.type === 'user.message') {
      const content = stringField(event.data, 'content')
      if (content) {
        items.push({
          kind: 'message',
          id: event.id,
          role: 'user',
          content,
          timestamp: event.timestamp,
          streaming: false
        })
      }
      continue
    }
    if (event.type === 'assistant.message_delta') {
      const messageId = stringField(event.data, 'messageId') ?? event.id
      const delta = stringField(event.data, 'deltaContent') ?? ''
      let item = streamingMessages.get(messageId)
      if (!item) {
        item = {
          kind: 'message',
          id: messageId,
          role: 'assistant',
          content: '',
          timestamp: event.timestamp,
          streaming: true
        }
        streamingMessages.set(messageId, item)
        items.push(item)
      }
      item.content += delta
      continue
    }
    if (event.type === 'assistant.message') {
      const messageId = stringField(event.data, 'messageId') ?? event.id
      const content = stringField(event.data, 'content') ?? ''
      const streaming = streamingMessages.get(messageId)
      if (streaming) {
        streaming.content = content || streaming.content
        streaming.streaming = false
      } else if (content) {
        items.push({
          kind: 'message',
          id: messageId,
          role: 'assistant',
          content,
          timestamp: event.timestamp,
          streaming: false
        })
      }
      continue
    }
    if (event.type === 'tool.execution_start') {
      const toolCallId = stringField(event.data, 'toolCallId') ?? event.id
      const data = objectValue(event.data)
      const tool: ToolTimelineItem = {
        id: toolCallId,
        name: stringField(event.data, 'toolName') ?? 'tool',
        arguments: data?.arguments,
        completed: false,
        failed: false
      }
      tools.set(toolCallId, tool)
      items.push({ kind: 'tool', tool })
      continue
    }
    if (
      event.type === 'tool.execution_progress' ||
      event.type === 'tool.execution_partial_result'
    ) {
      const tool = tools.get(stringField(event.data, 'toolCallId') ?? '')
      if (tool) {
        tool.progress =
          stringField(event.data, 'progressMessage') ??
          stringField(event.data, 'partialOutput') ??
          tool.progress
      }
      continue
    }
    if (event.type === 'tool.execution_complete') {
      const tool = tools.get(stringField(event.data, 'toolCallId') ?? '')
      if (tool) {
        const data = objectValue(event.data)
        tool.completed = true
        tool.failed =
          booleanField(event.data, 'success') === false ||
          stringField(event.data, 'status') === 'error'
        tool.result = data?.result ?? data?.output ?? data?.error
      }
    }
  }
  return items
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.valueOf())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AgentTimeline({
  session,
  events
}: {
  session: AgentSession
  events: AgentSessionEvent[]
}): React.JSX.Element {
  const items = React.useMemo(() => timelineItems(events), [events])

  if (items.length === 0) {
    return (
      <div className="text-muted-foreground flex min-h-48 items-center justify-center text-xs">
        {session.lifecycle === 'initializing' || session.lifecycle === 'active' ? (
          <span className="flex items-center gap-2">
            <Loader2Icon className="size-3.5 animate-spin" />
            Starting Copilot…
          </span>
        ) : (
          'No session activity yet.'
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-6 py-5">
      {items.map((item) =>
        item.kind === 'tool' ? (
          <ToolCard key={item.tool.id} tool={item.tool} />
        ) : (
          <article
            key={item.id}
            className={
              item.role === 'user'
                ? 'bg-muted/35 rounded-md border px-3 py-3'
                : 'border-b px-1 py-3 last:border-b-0'
            }
          >
            <header className="mb-2 flex items-center gap-2">
              <span className="text-xs font-semibold">
                {item.role === 'user' ? 'You' : 'Copilot'}
              </span>
              <time className="text-muted-foreground text-[10px]">
                {formatTime(item.timestamp)}
              </time>
              {item.streaming ? (
                <Loader2Icon className="text-muted-foreground size-3 animate-spin" />
              ) : null}
            </header>
            {item.role === 'assistant' ? (
              <MarkdownBody text={item.content} />
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{item.content}</p>
            )}
          </article>
        )
      )}
    </div>
  )
}
