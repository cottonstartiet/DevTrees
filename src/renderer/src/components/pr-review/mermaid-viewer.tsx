import {
  Maximize as MaximizeIcon,
  Minus as MinusIcon,
  Plus as PlusIcon,
  X as XIcon
} from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { useMermaidZoom, type MermaidZoomRequest } from '@/contexts/mermaid-zoom-context'
import {
  actualSizeView,
  fitView,
  naturalSizeOf,
  wheelZoomFactor,
  zoomAt,
  ZOOM_STEP,
  type Size,
  type View
} from '@/lib/mermaid-view'

/**
 * Full-pane pan/zoom viewer for a rendered mermaid diagram.
 *
 * Rendered inside the review workspace's content column rather than portalled to the document
 * root, so the file sidebar and the file toolbar stay visible and clickable — that positioning is
 * the whole reason this is not a `Dialog`.
 */
export function MermaidViewer(): React.JSX.Element | null {
  const { request } = useMermaidZoom()
  if (!request) return null
  // Keyed on the diagram so opening a second one starts fitted instead of inheriting the previous
  // diagram's pan and zoom.
  return <ViewerSurface key={request.svg} request={request} />
}

function ViewerSurface({ request }: { request: MermaidZoomRequest }): React.JSX.Element {
  const { close } = useMermaidZoom()
  const [viewport, setViewport] = React.useState<Size | null>(null)
  // `null` means "fit": the transform is then derived during render, so the viewer never has to
  // measure in an effect and write state back, which the react-hooks lint rules forbid.
  const [view, setView] = React.useState<View | null>(null)
  const [isPanning, setIsPanning] = React.useState(false)
  // Distance travelled during the current drag, so a stray click can be told from a pan.
  const dragDistance = React.useRef(0)

  const svg = request.svg
  const content = React.useMemo(() => naturalSizeOf(svg), [svg])
  const fit = React.useMemo(() => fitView(content, viewport), [content, viewport])
  const current = view ?? fit

  const viewportRef = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined
    // A ResizeObserver callback is not an effect body, so setting state here is allowed — and it
    // also handles the window being resized while the viewer is open.
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setViewport({ width: box.width, height: box.height })
    })
    observer.observe(node)
    node.focus()
    return () => observer.disconnect()
  }, [])

  /** Zoom about a point in viewport coordinates, holding whatever is under it fixed. */
  const zoomAtPoint = React.useCallback(
    (factor: number, pointX: number, pointY: number) => {
      setView((previous) => zoomAt(previous ?? fit, factor, pointX, pointY))
    },
    [fit]
  )

  const zoomCentre = React.useCallback(
    (factor: number) => {
      const width = viewport?.width ?? 0
      const height = viewport?.height ?? 0
      zoomAtPoint(factor, width / 2, height / 2)
    },
    [zoomAtPoint, viewport]
  )

  const panBy = React.useCallback(
    (dx: number, dy: number) => {
      setView((previous) => {
        const from = previous ?? fit
        return { ...from, x: from.x + dx, y: from.y + dy }
      })
    },
    [fit]
  )

  const resetToActualSize = React.useCallback(() => {
    setView(actualSizeView(content, viewport))
  }, [viewport, content])

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    zoomAtPoint(wheelZoomFactor(event.deltaY), event.clientX - box.left, event.clientY - box.top)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragDistance.current = 0
    setIsPanning(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!isPanning) return
    dragDistance.current += Math.abs(event.movementX) + Math.abs(event.movementY)
    panBy(event.movementX, event.movementY)
  }

  const endPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setIsPanning(false)
  }

  /**
   * Clicking empty space closes the viewer — but only on a genuine click. Without the distance
   * guard, releasing a pan that happened to end off the diagram would dismiss it.
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (dragDistance.current > 3) return
    if ((event.target as HTMLElement).closest('.md-mermaid-stage')) return
    close()
  }

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    zoomAtPoint(ZOOM_STEP * ZOOM_STEP, event.clientX - box.left, event.clientY - box.top)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const pan = 60
    switch (event.key) {
      case 'Escape':
        close()
        break
      case '+':
      case '=':
        zoomCentre(ZOOM_STEP)
        break
      case '-':
      case '_':
        zoomCentre(1 / ZOOM_STEP)
        break
      case '0':
        resetToActualSize()
        break
      case 'f':
      case 'F':
        setView(null)
        break
      case 'ArrowLeft':
        panBy(pan, 0)
        break
      case 'ArrowRight':
        panBy(-pan, 0)
        break
      case 'ArrowUp':
        panBy(0, pan)
        break
      case 'ArrowDown':
        panBy(0, -pan)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div
      className="md-mermaid-viewer bg-background/98 absolute inset-0 z-30 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={request.label}
      // The viewport handles its own keys and stops them here; this only catches `Esc` pressed
      // while focus sits on a toolbar button, where the viewport's handler would never fire.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
          {request.label}
        </span>

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => zoomCentre(1 / ZOOM_STEP)}
            aria-label="Zoom out"
          >
            <MinusIcon className="size-3.5" />
          </Button>
          <span className="text-muted-foreground w-12 text-center font-mono text-[11px] tabular-nums">
            {Math.round(current.scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => zoomCentre(ZOOM_STEP)}
            aria-label="Zoom in"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => setView(null)}
        >
          <MaximizeIcon className="size-3" />
          Fit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 font-mono text-[11px]"
          onClick={resetToActualSize}
        >
          100%
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={close}
          aria-label="Close diagram viewer"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <div
        ref={viewportRef}
        className="md-mermaid-viewport min-h-0 flex-1"
        data-panning={isPanning ? 'true' : 'false'}
        tabIndex={-1}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div
          className="md-mermaid-stage"
          style={{
            width: content?.width ?? '100%',
            height: content?.height ?? '100%',
            transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})`
          }}
          // Mermaid's own output, already produced with `securityLevel: 'strict'`.
          dangerouslySetInnerHTML={{ __html: request.svg }}
        />
      </div>

      <p className="text-muted-foreground shrink-0 border-t px-3 py-1 text-[10px]">
        Scroll to zoom · drag to pan · <kbd>F</kbd> fit · <kbd>0</kbd> actual size · <kbd>Esc</kbd>{' '}
        close
      </p>
    </div>
  )
}
