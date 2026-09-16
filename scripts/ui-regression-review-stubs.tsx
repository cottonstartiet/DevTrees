import * as React from 'react'

export function MarkdownPreview({ text }: { text: string }): React.JSX.Element {
  return <div className="markdown-preview">{text}</div>
}

export function MermaidViewer(): null {
  return null
}
