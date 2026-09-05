import * as React from 'react'

import { renderMarkdown } from '@/lib/markdown'
import { openExternal } from '@/lib/system'
import { cn } from '@/lib/utils'

/**
 * Rendered markdown for PR descriptions and review comments.
 *
 * The HTML comes from the shared sanitized Markdown renderer, and link clicks are intercepted so
 * content can never navigate the app away from the workspace.
 */
export function MarkdownBody({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const html = React.useMemo(() => renderMarkdown(text), [text])

  return (
    <div
      className={cn('markdown-body', className)}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a')
        const href = anchor?.getAttribute('href')
        if (!href) return
        event.preventDefault()
        if (/^https?:\/\//i.test(href)) void openExternal(href)
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
