/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

import { LocalReviewPage } from '@/pages/local-review'
import { PrReviewPage } from '@/pages/pr-review'
import type { LocalReviewTarget } from '@/hooks/use-local-review'
import type { PrReviewTarget } from '@/hooks/use-pr-review'

export type OpenPrReviewRequest = PrReviewTarget & { title?: string }
export type OpenLocalReviewRequest = LocalReviewTarget
export type OpenReviewRequest =
  | ({ kind: 'pr' } & OpenPrReviewRequest)
  | ({ kind: 'local' } & OpenLocalReviewRequest)

type PrReviewContextValue = {
  openReview: (request: OpenReviewRequest) => void
  openPrReview: (request: OpenPrReviewRequest) => void
  openLocalReview: (request: OpenLocalReviewRequest) => void
  closePrReview: () => void
}

const PrReviewContext = React.createContext<PrReviewContextValue | null>(null)

/**
 * Owns the full-screen review workspace.
 *
 * The workspace is an overlay rather than an `AppView` so any surface — the Reviews tab, the PR
 * comments panel — can open it without threading props through the whole detail tree, and closing
 * it returns the user exactly where they were.
 */
export function PrReviewProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [request, setRequest] = React.useState<OpenReviewRequest | null>(null)

  const value = React.useMemo<PrReviewContextValue>(
    () => ({
      openReview: setRequest,
      openPrReview: (next) => setRequest({ kind: 'pr', ...next }),
      openLocalReview: (next) => setRequest({ kind: 'local', ...next }),
      closePrReview: () => setRequest(null)
    }),
    []
  )

  return (
    <PrReviewContext.Provider value={value}>
      {children}
      {request?.kind === 'pr' ? (
        <PrReviewPage
          key={`${request.folderPath}::${request.pullRequestId}`}
          target={{
            folderPath: request.folderPath,
            remoteKind: request.remoteKind,
            pullRequestId: request.pullRequestId
          }}
          initialTitle={request.title}
          onClose={() => setRequest(null)}
        />
      ) : request?.kind === 'local' ? (
        <LocalReviewPage
          key={request.folderPath}
          target={{
            folderPath: request.folderPath,
            branchLabel: request.branchLabel
          }}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </PrReviewContext.Provider>
  )
}

export function usePrReviewWorkspace(): PrReviewContextValue {
  const context = React.useContext(PrReviewContext)
  if (!context) throw new Error('usePrReviewWorkspace must be used within a PrReviewProvider')
  return context
}
