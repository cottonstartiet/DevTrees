/** Pan/zoom maths for the diagram viewer, kept pure so it can be reasoned about and tested. */

export const MIN_SCALE = 0.1
export const MAX_SCALE = 10
/** One notch of a wheel, or one press of `+` / `-`. */
export const ZOOM_STEP = 1.2

/** Padding kept between a fitted diagram and the viewport edges. */
const FIT_PADDING = 32

export type View = { scale: number; x: number; y: number }
export type Size = { width: number; height: number }

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * Natural diagram size, taken from the SVG's `viewBox`.
 *
 * Mermaid emits `width="100%"` with a `max-width` style, so the element's own attributes say
 * nothing useful about its size; the viewBox is the only stable measurement, and reading it from
 * the markup keeps sizing a pure render-time calculation rather than a DOM measurement in an
 * effect.
 *
 * Returns `null` for a missing or degenerate viewBox so callers fall back instead of dividing by
 * zero.
 */
export function naturalSizeOf(svg: string): Size | null {
  const match =
    /viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/i.exec(svg)
  if (!match) return null
  const width = Number(match[3])
  const height = Number(match[4])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** The transform that centres the diagram and scales it to just fit, never magnifying past 1×. */
export function fitView(content: Size | null, viewport: Size | null): View {
  if (!content || !viewport || viewport.width === 0 || viewport.height === 0) {
    return { scale: 1, x: 0, y: 0 }
  }
  const scale = clampScale(
    Math.min(
      1,
      (viewport.width - FIT_PADDING * 2) / content.width,
      (viewport.height - FIT_PADDING * 2) / content.height
    )
  )
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2
  }
}

/** The transform that shows the diagram at 1:1 and centres it. */
export function actualSizeView(content: Size | null, viewport: Size | null): View {
  const width = viewport?.width ?? 0
  const height = viewport?.height ?? 0
  return {
    scale: 1,
    x: (width - (content?.width ?? 0)) / 2,
    y: (height - (content?.height ?? 0)) / 2
  }
}

/**
 * Zoom about a point in viewport coordinates, holding whatever is under it fixed.
 *
 * With `transform-origin: 0 0` the offset must be corrected by the scale ratio; skipping that
 * correction is the classic "diagram runs away from the pointer" bug.
 */
export function zoomAt(from: View, factor: number, pointX: number, pointY: number): View {
  const scale = clampScale(from.scale * factor)
  const ratio = scale / from.scale
  return {
    scale,
    x: pointX - (pointX - from.x) * ratio,
    y: pointY - (pointY - from.y) * ratio
  }
}

/** Wheel delta → zoom factor. Exponential, so a notch is a constant proportional step. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.002)
}
