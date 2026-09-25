import * as React from 'react'
import { CopyIcon, LoaderCircleIcon, RadioTowerIcon, SquareIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { LocalWebStatus } from '@shared/local-web'

const STOPPED: LocalWebStatus = {
  running: false,
  url: null,
  qrSvg: null,
  address: null,
  port: null,
  error: null
}

export function LocalWebDialog({
  open,
  onOpenChange,
  onStatusChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStatusChange: (status: LocalWebStatus) => void
}): React.JSX.Element {
  const [status, setStatus] = React.useState<LocalWebStatus>(STOPPED)
  const [pending, setPending] = React.useState(false)

  const update = React.useCallback(
    (next: LocalWebStatus): void => {
      setStatus(next)
      onStatusChange(next)
    },
    [onStatusChange]
  )

  React.useEffect(() => {
    if (!open) return
    void window.api.localWeb
      .status()
      .then(update)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : 'Could not read web server status.')
      )
  }, [open, update])

  const start = async (): Promise<void> => {
    setPending(true)
    try {
      update(await window.api.localWeb.start())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the local web UI.')
    } finally {
      setPending(false)
    }
  }

  const stop = async (): Promise<void> => {
    setPending(true)
    try {
      update(await window.api.localWeb.stop())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not stop the local web UI.')
    } finally {
      setPending(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!status.url) return
    await navigator.clipboard.writeText(status.url)
    toast.success('Local web address copied.')
  }

  const qrData = status.qrSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(status.qrSvg)}`
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Local web UI</DialogTitle>
          <DialogDescription>
            Open Dashboard, Tasks, and Copilot sessions from another device on this network.
          </DialogDescription>
        </DialogHeader>

        {status.running && status.url ? (
          <div className="space-y-4">
            {qrData ? (
              <div className="flex justify-center rounded-lg border bg-white p-4">
                <img
                  src={qrData}
                  alt="QR code for the SWE Factory local web UI"
                  className="size-56"
                />
              </div>
            ) : null}
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="break-all font-mono text-xs">{status.url}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Keep SWE Factory running. Access ends when this server stops or SWE Factory exits.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => void copy()}
              >
                <CopyIcon />
                Copy address
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={pending}
                onClick={() => void stop()}
              >
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <SquareIcon />}
                Stop
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This uses unencrypted HTTP on your local network. Only share the QR code with devices
              you trust.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
              <RadioTowerIcon className="mt-0.5 size-4 shrink-0" />
              <p className="text-xs text-muted-foreground">
                SWE Factory will choose a private network address and available port. The pairing
                code is temporary and changes each time the server starts.
              </p>
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={pending}
              onClick={() => void start()}
            >
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <RadioTowerIcon />}
              Start local web UI
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
