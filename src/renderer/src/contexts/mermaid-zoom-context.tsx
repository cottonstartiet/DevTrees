/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

export type MermaidZoomRequest = {
  /** The already-rendered SVG markup; reused verbatim so opening the viewer costs no re-render. */
  svg: string
  label: string
}

type MermaidZoomContextValue = {
  request: MermaidZoomRequest | null
  isOpen: boolean
  open: (request: MermaidZoomRequest) => void
  close: () => void
}

const MermaidZoomContext = React.createContext<MermaidZoomContextValue | null>(null)

/**
 * Carries "expand this diagram" from a `MermaidDiagram` — buried inside the markdown preview — up
 * to the review workspace, which owns the viewer overlay.
 *
 * The provider deliberately does not render the overlay itself: the overlay must be positioned
 * inside the content column so it covers the document but not the file sidebar or the toolbar, and
 * only the page knows where that is.
 */
export function MermaidZoomProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [request, setRequest] = React.useState<MermaidZoomRequest | null>(null)

  const value = React.useMemo<MermaidZoomContextValue>(
    () => ({
      request,
      isOpen: request !== null,
      open: (next) => setRequest(next),
      close: () => setRequest(null)
    }),
    [request]
  )

  return <MermaidZoomContext.Provider value={value}>{children}</MermaidZoomContext.Provider>
}

/**
 * Access the diagram viewer.
 *
 * Returns a no-op value outside a provider so `MermaidDiagram` stays usable anywhere markdown is
 * rendered; the expand affordance simply hides itself.
 */
export function useMermaidZoom(): MermaidZoomContextValue {
  return (
    React.useContext(MermaidZoomContext) ?? {
      request: null,
      isOpen: false,
      open: () => {},
      close: () => {}
    }
  )
}

/** Whether an enclosing provider exists, so callers can hide the expand button when it does not. */
export function useHasMermaidZoom(): boolean {
  return React.useContext(MermaidZoomContext) !== null
}
