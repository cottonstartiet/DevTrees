import { AlertTriangle as AlertTriangleIcon, Maximize2 as Maximize2Icon } from 'lucide-react'
import * as React from 'react'

import { useHasMermaidZoom, useMermaidZoom } from '@/contexts/mermaid-zoom-context'
import { useMermaid } from '@/hooks/use-mermaid'
import { cn } from '@/lib/utils'

const MODES = [
  { key: 'diagram', label: 'Diagram' },
  { key: 'source', label: 'Source' }
] as const

type Mode = (typeof MODES)[number]['key']

export interface MermaidDiagramProps {
  code: string
  /** Info string of the fence, e.g. `mermaid` or `mermaid title="x"`. */
  info?: string
  /** Where the diagram came from, shown in the expanded viewer's header. */
  label?: string
}

/**
 * A ```` ```mermaid ```` fence, rendered as a diagram with the source one click away.
 *
 * A reviewer commenting on a diagram is usually commenting on its definition, so the source stays
 * reachable — and both modes report the same raw line range, since the range comes from the fence
 * token rather than from what is on screen.
 *
 * Any failure (bad syntax, engine load failure) falls back to the source rather than leaving a
 * hole in the document.
 */
export function MermaidDiagram({ code, info, label }: MermaidDiagramProps): React.JSX.Element {
  const [mode, setMode] = React.useState<Mode>('diagram')
  const state = useMermaid(code)
  const { open } = useMermaidZoom()
  const canExpand = useHasMermaidZoom()
  const failed = state.status === 'error'
  const showSource = mode === 'source' || failed

  // The bare `mermaid` info word is noise; only trailing metadata (```mermaid title="x") says
  // anything about the diagram.
  const meta = info
    ?.trim()
    .replace(/^mermaid\b/i, '')
    .trim()
  const title = [label, meta].filter(Boolean).join(' · ') || 'Diagram'

  return (
    <div className="md-mermaid">
      <div className="md-mermaid-toolbar">
        {canExpand && state.status === 'ready' && !showSource ? (
          <button
            type="button"
            onClick={() => open({ svg: state.svg, label: title })}
            className="text-muted-foreground hover:text-foreground hover:bg-accent grid size-[18px] place-items-center rounded transition-colors"
            aria-label="Expand diagram"
            title="Expand diagram"
          >
            <Maximize2Icon className="size-3" />
          </button>
        ) : null}
        {MODES.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setMode(option.key)}
            aria-pressed={showSource ? option.key === 'source' : option.key === 'diagram'}
            disabled={failed && option.key === 'diagram'}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-40',
              (showSource ? option.key === 'source' : option.key === 'diagram')
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {failed ? (
        <p className="md-mermaid-error">
          <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
          <span>Diagram could not be rendered — showing source. {state.error}</span>
        </p>
      ) : null}

      {showSource ? (
        <pre className="md-mermaid-source">
          <code>{code}</code>
        </pre>
      ) : state.status === 'loading' ? (
        <div className="md-mermaid-skeleton" role="status" aria-label="Rendering diagram" />
      ) : (
        // Mermaid's own output, produced with `securityLevel: 'strict'` so untrusted labels are
        // HTML-encoded.
        <div
          className="md-mermaid-canvas"
          aria-label={title}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
    </div>
  )
}
