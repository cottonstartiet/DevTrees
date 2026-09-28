/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { toast } from 'sonner'

import { notifyUserActionWhenBackground } from '@/lib/desktop-notifications'
import {
  createReviewWindowFacade,
  openReviewWindow
} from '@/lib/review-window-launcher'
import type {
  OpenLocalReviewRequest,
  OpenPrReviewRequest,
  OpenReviewRequest
} from '@/lib/review-window'

export type {
  OpenLocalReviewRequest,
  OpenPrReviewRequest,
  OpenReviewRequest
} from '@/lib/review-window'

type PrReviewContextValue = {
  openReview: (request: OpenReviewRequest) => void
  openPrReview: (request: OpenPrReviewRequest) => void
  openLocalReview: (request: OpenLocalReviewRequest) => void
}

const PrReviewContext = React.createContext<PrReviewContextValue | null>(null)

const reviewWindowFacade: PrReviewContextValue = createReviewWindowFacade(
  openReviewWindow,
  (error) => {
    toast.error('Could not open the review window.', { description: error })
    notifyUserActionWhenBackground('Could not open the review window', error, 'dashboard')
  }
)

export function PrReviewProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <PrReviewContext.Provider value={reviewWindowFacade}>{children}</PrReviewContext.Provider>
}

export function usePrReviewWorkspace(): PrReviewContextValue {
  const context = React.useContext(PrReviewContext)
  if (!context) throw new Error('usePrReviewWorkspace must be used within a PrReviewProvider')
  return context
}
