import { ipcMain } from 'electron'

import type {
  AdoMyOpenPrsRequest,
  AdoMyOpenPrsResult,
  AdoPrDetailsRequest,
  AdoPrDetailsResult,
  AdoPrThreadsRequest,
  AdoPrThreadsResult
} from '../shared/ado'
import { AdoIpcChannels } from '../shared/ado'
import { getAdoMyOpenPrs, getAdoPrDetails, getAdoPrThreads } from './repo-status'

export function registerAdoIpc(): void {
  ipcMain.handle(
    AdoIpcChannels.PrDetails,
    async (_event, req: AdoPrDetailsRequest): Promise<AdoPrDetailsResult> => {
      try {
        return await getAdoPrDetails(req)
      } catch (err) {
        console.error('[ado] pr-details failed:', err)
        return {
          ok: false,
          code: 'git-failed',
          message: err instanceof Error ? err.message : 'pr-details failed'
        }
      }
    }
  )

  ipcMain.handle(
    AdoIpcChannels.PrThreads,
    async (_event, req: AdoPrThreadsRequest): Promise<AdoPrThreadsResult> => {
      try {
        return await getAdoPrThreads(req)
      } catch (err) {
        console.error('[ado] pr-threads failed:', err)
        return {
          ok: false,
          code: 'git-failed',
          message: err instanceof Error ? err.message : 'pr-threads failed'
        }
      }
    }
  )

  ipcMain.handle(
    AdoIpcChannels.MyOpenPrs,
    async (_event, req: AdoMyOpenPrsRequest): Promise<AdoMyOpenPrsResult> => {
      try {
        return await getAdoMyOpenPrs(req)
      } catch (err) {
        console.error('[ado] my-open-prs failed:', err)
        return {
          ok: false,
          code: 'git-failed',
          message: err instanceof Error ? err.message : 'my-open-prs failed'
        }
      }
    }
  )
}
