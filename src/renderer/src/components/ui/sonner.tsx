import * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

export function Toaster({ style, toastOptions, ...props }: ToasterProps): React.JSX.Element {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          '--width': '22rem',
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          ...style
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: 'h-20! min-h-20! max-h-20! overflow-hidden!',
          content: 'min-w-0 flex-1 overflow-hidden',
          title: 'block truncate',
          description: 'line-clamp-2 [overflow-wrap:anywhere]',
          ...toastOptions?.classNames
        }
      }}
      {...props}
    />
  )
}
