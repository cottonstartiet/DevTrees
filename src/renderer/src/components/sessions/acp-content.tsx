import { MarkdownBody } from '@/components/pr-review/markdown-body'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function AcpContent({ value }: { value: unknown }) {
  const content = object(value)
  if (content.type === 'text' && typeof content.text === 'string') {
    return <MarkdownBody text={content.text} className="text-sm" />
  }
  if (content.type === 'content') return <AcpContent value={content.content} />
  if (
    content.type === 'image' &&
    typeof content.data === 'string' &&
    typeof content.mimeType === 'string' &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(content.mimeType)
  ) {
    return (
      <img
        className="max-h-72 max-w-full object-contain"
        alt="Image supplied by Copilot"
        src={`data:${content.mimeType};base64,${content.data}`}
      />
    )
  }
  if (content.type === 'diff') {
    return (
      <div className="space-y-2">
        <p className="break-all font-mono text-xs">{String(content.path ?? 'File change')}</p>
        {typeof content.oldText === 'string' && (
          <details>
            <summary className="cursor-pointer text-xs">Before</summary>
            <pre className="bg-muted max-h-64 overflow-auto p-2 text-xs">{content.oldText}</pre>
          </details>
        )}
        {typeof content.newText === 'string' && (
          <pre className="bg-muted max-h-64 overflow-auto p-2 text-xs">{content.newText}</pre>
        )}
      </div>
    )
  }
  if (content.type === 'resource') {
    const resource = object(content.resource)
    return (
      <div className="space-y-2">
        <p className="break-all font-mono text-xs">{String(resource.uri ?? 'Resource')}</p>
        {typeof resource.text === 'string' && (
          <pre className="bg-muted max-h-64 overflow-auto p-2 text-xs">{resource.text}</pre>
        )}
      </div>
    )
  }
  if (content.type === 'resource_link') {
    return (
      <p className="break-all font-mono text-xs">
        {String(content.name ?? 'Resource')}: {String(content.uri ?? '')}
      </p>
    )
  }
  return (
    <pre className="bg-muted max-h-64 overflow-auto rounded p-2 text-xs whitespace-pre-wrap break-words">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function AcpEntry({ category, data }: { category: string; data: unknown }) {
  const value = object(data)
  if (category === 'tool') {
    return (
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-medium">
          {String(value.title ?? 'Tool')}{' '}
          <span className="text-muted-foreground text-xs">{String(value.status ?? 'pending')}</span>
        </summary>
        {value.rawInput != null && (
          <pre className="bg-muted max-h-48 overflow-auto rounded p-2 text-xs">
            {JSON.stringify(value.rawInput, null, 2)}
          </pre>
        )}
        {value.rawOutput != null && (
          <pre className="bg-muted max-h-64 overflow-auto rounded p-2 text-xs">
            {JSON.stringify(value.rawOutput, null, 2)}
          </pre>
        )}
        {Array.isArray(value.content) &&
          value.content.map((item, index) => <AcpContent key={index} value={item} />)}
      </details>
    )
  }
  if (category === 'plan' && Array.isArray(value.entries)) {
    return (
      <ol className="space-y-1 text-sm">
        {value.entries.map((entry, index) => {
          const item = object(entry)
          return (
            <li key={index}>
              <span className="text-muted-foreground text-xs">
                {String(item.status ?? 'pending')}
              </span>{' '}
              {String(item.content ?? '')}
            </li>
          )
        })}
      </ol>
    )
  }
  if (category === 'agent_thought_chunk') {
    return (
      <details>
        <summary className="cursor-pointer text-xs">Reasoning</summary>
        <AcpContent value={data} />
      </details>
    )
  }
  return <AcpContent value={data} />
}
