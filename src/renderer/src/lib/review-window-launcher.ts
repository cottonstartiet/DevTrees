import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { WindowOptions } from '@tauri-apps/api/window'

import {
  initialReviewWindowTitle,
  reviewWindowLabel,
  serializeReviewWindowRequest,
  type OpenLocalReviewRequest,
  type OpenPrReviewRequest,
  type OpenReviewRequest
} from '@/lib/review-window'

const REVIEW_WINDOW_PATH = '/review.html'
const INITIAL_WIDTH = 1_400
const INITIAL_HEIGHT = 900
const MIN_WIDTH = 900
const MIN_HEIGHT = 600
const CASCADE_OFFSET = 28
const MAX_CASCADE_SLOT = 7

export interface ReviewWindowScreenBounds {
  left: number
  top: number
  width: number
  height: number
}

type ScreenWithOffsets = Screen & {
  readonly availLeft?: number
  readonly availTop?: number
}

export type ReviewWindowOptions = WindowOptions & {
  url: string
}

export type ReviewWindowLaunchResult =
  | { ok: true; label: string; action: 'created' | 'focused' }
  | { ok: false; label: string; error: string }

export type ReviewWindowLauncher = (
  request: OpenReviewRequest
) => Promise<ReviewWindowLaunchResult>

export interface ReviewWindowFacade {
  openReview(request: OpenReviewRequest): void
  openPrReview(request: OpenPrReviewRequest): void
  openLocalReview(request: OpenLocalReviewRequest): void
}

export interface ReviewWindowHandle {
  unminimize(): Promise<void>
  show(): Promise<void>
  setFocus(): Promise<void>
}

export interface ReviewWindowRuntime {
  getByLabel(label: string): Promise<ReviewWindowHandle | null>
  create(label: string, options: ReviewWindowOptions): Promise<ReviewWindowHandle>
  screenBounds(): ReviewWindowScreenBounds
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function browserScreenBounds(screen: ScreenWithOffsets): ReviewWindowScreenBounds {
  return {
    left: finiteOr(screen.availLeft, 0),
    top: finiteOr(screen.availTop, 0),
    width: Math.max(1, finiteOr(screen.availWidth, INITIAL_WIDTH)),
    height: Math.max(1, finiteOr(screen.availHeight, INITIAL_HEIGHT))
  }
}

export function reviewWindowOptions(
  request: OpenReviewRequest,
  bounds: ReviewWindowScreenBounds,
  cascadeSlot: number
): ReviewWindowOptions {
  const availableWidth = Math.max(1, bounds.width)
  const availableHeight = Math.max(1, bounds.height)
  const visibleWidth = Math.min(INITIAL_WIDTH, availableWidth)
  const visibleHeight = Math.min(INITIAL_HEIGHT, availableHeight)
  const centeredX = bounds.left + Math.max(0, Math.floor((availableWidth - visibleWidth) / 2))
  const centeredY = bounds.top + Math.max(0, Math.floor((availableHeight - visibleHeight) / 2))
  const roomRight = Math.max(0, bounds.left + availableWidth - (centeredX + visibleWidth))
  const roomBottom = Math.max(0, bounds.top + availableHeight - (centeredY + visibleHeight))
  const availableSlots = Math.min(
    MAX_CASCADE_SLOT,
    Math.floor(roomRight / CASCADE_OFFSET),
    Math.floor(roomBottom / CASCADE_OFFSET)
  )
  const normalizedSlot =
    availableSlots > 0 ? Math.abs(Math.trunc(cascadeSlot)) % (availableSlots + 1) : 0

  return {
    url: `${REVIEW_WINDOW_PATH}${serializeReviewWindowRequest(request)}`,
    title: initialReviewWindowTitle(request),
    x: centeredX + normalizedSlot * CASCADE_OFFSET,
    y: centeredY + normalizedSlot * CASCADE_OFFSET,
    width: INITIAL_WIDTH,
    height: INITIAL_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    resizable: true,
    visible: true,
    focus: true,
    skipTaskbar: false,
    preventOverflow: true
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Could not open the review window.'
}

export function createReviewWindowFacade(
  launch: ReviewWindowLauncher,
  reportFailure: (error: string) => void
): ReviewWindowFacade {
  const openReview = (request: OpenReviewRequest): void => {
    void (async () => {
      try {
        const result = await launch(request)
        if (!result.ok) reportFailure(result.error)
      } catch (error) {
        reportFailure(errorMessage(error))
      }
    })()
  }

  return {
    openReview,
    openPrReview: (request) => openReview({ kind: 'pr', ...request }),
    openLocalReview: (request) => openReview({ kind: 'local', ...request })
  }
}

async function focusReviewWindow(window: ReviewWindowHandle): Promise<void> {
  await window.unminimize()
  await window.show()
  await window.setFocus()
}

function createTauriWindow(
  label: string,
  options: ReviewWindowOptions
): Promise<ReviewWindowHandle> {
  return new Promise((resolve, reject) => {
    const window = new WebviewWindow(label, options)
    void window.once('tauri://created', () => resolve(window))
    void window.once<unknown>('tauri://error', (event) => reject(event.payload))
  })
}

const tauriRuntime: ReviewWindowRuntime = {
  getByLabel: (label) => WebviewWindow.getByLabel(label),
  create: createTauriWindow,
  screenBounds: () => browserScreenBounds(globalThis.screen)
}

export function createReviewWindowLauncher(
  runtime: ReviewWindowRuntime
): ReviewWindowLauncher {
  const inFlight = new Map<string, Promise<ReviewWindowLaunchResult>>()
  let cascadeSlot = 0

  return (request) => {
    const label = reviewWindowLabel(request)
    const pending = inFlight.get(label)
    if (pending) return pending

    const launch = (async (): Promise<ReviewWindowLaunchResult> => {
      try {
        const existing = await runtime.getByLabel(label)
        if (existing) {
          await focusReviewWindow(existing)
          return { ok: true, label, action: 'focused' }
        }

        const options = reviewWindowOptions(request, runtime.screenBounds(), cascadeSlot++)
        try {
          await runtime.create(label, options)
          return { ok: true, label, action: 'created' }
        } catch (createError) {
          const racedWindow = await runtime.getByLabel(label)
          if (!racedWindow) throw createError
          await focusReviewWindow(racedWindow)
          return { ok: true, label, action: 'focused' }
        }
      } catch (error) {
        return { ok: false, label, error: errorMessage(error) }
      }
    })()

    inFlight.set(label, launch)
    void launch.finally(() => {
      if (inFlight.get(label) === launch) inFlight.delete(label)
    })
    return launch
  }
}

export const openReviewWindow = createReviewWindowLauncher(tauriRuntime)
