import { getCurrentWindow } from '@tauri-apps/api/window'
import { AlertCircle as AlertCircleIcon } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'

import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/contexts/theme-context'
import {
  initialReviewWindowTitle,
  parseReviewWindowRequest,
  type OpenReviewRequest
} from '@/lib/review-window'
import { LocalReviewPage } from '@/pages/local-review'
import { PrReviewPage } from '@/pages/pr-review'

function InvalidReviewRequest(): React.JSX.Element {
  return (
    <main className="grid h-full place-items-center p-6">
      <section
        role="alert"
        className="bg-card text-card-foreground flex max-w-md items-start gap-3 rounded-lg border p-4 shadow-xs"
      >
        <AlertCircleIcon className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">Unable to open review</h1>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            The review window request is missing or invalid. Close this window and open the review
            again from SWE Factory.
          </p>
        </div>
      </section>
    </main>
  )
}

function ReviewSurface({ request }: { request: OpenReviewRequest }): React.JSX.Element {
  const closeWindow = React.useCallback((): void => {
    void (async () => {
      try {
        await getCurrentWindow().close()
      } catch (error) {
        toast.error('Unable to close the review window.', {
          description: error instanceof Error ? error.message : String(error)
        })
      }
    })()
  }, [])

  const updateWindowTitle = React.useCallback(
    (title: string): void => {
      const nativeTitle =
        request.kind === 'pr'
          ? initialReviewWindowTitle({ ...request, title })
          : title
      void getCurrentWindow()
        .setTitle(nativeTitle)
        .catch((error: unknown) => {
          toast.error('Unable to update the review window title.', {
            description: error instanceof Error ? error.message : String(error)
          })
        })
    },
    [request]
  )

  if (request.kind === 'pr') {
    return (
      <PrReviewPage
        target={{
          folderPath: request.folderPath,
          remoteKind: request.remoteKind,
          pullRequestId: request.pullRequestId
        }}
        initialTitle={request.title}
        onClose={closeWindow}
        onTitleChange={updateWindowTitle}
      />
    )
  }

  return (
    <LocalReviewPage
      target={{ folderPath: request.folderPath, branchLabel: request.branchLabel }}
      onClose={closeWindow}
      onTitleChange={updateWindowTitle}
    />
  )
}

export function ReviewApp({ search }: { search: string }): React.JSX.Element {
  const request = parseReviewWindowRequest(search)

  return (
    <ThemeProvider>
      {request ? <ReviewSurface request={request} /> : <InvalidReviewRequest />}
      <Toaster richColors closeButton position="bottom-right" />
    </ThemeProvider>
  )
}
