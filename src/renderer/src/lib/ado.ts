import type {
  AdoMyOpenPrsRequest,
  AdoMyOpenPrsResult,
  AdoPrDetailsRequest,
  AdoPrDetailsResult,
  AdoPrThreadsRequest,
  AdoPrThreadsResult
} from '@shared/ado'

export function getAdoPrDetails(req: AdoPrDetailsRequest): Promise<AdoPrDetailsResult> {
  return window.api.ado.prDetails(req)
}

export function getAdoPrThreads(req: AdoPrThreadsRequest): Promise<AdoPrThreadsResult> {
  return window.api.ado.prThreads(req)
}

export function getAdoMyOpenPrs(req: AdoMyOpenPrsRequest): Promise<AdoMyOpenPrsResult> {
  return window.api.ado.myOpenPrs(req)
}
