/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

import { type DashboardPrReviews, useDashboardPrReviews } from '@/hooks/use-dashboard-pr-reviews'
import type { Repository } from '@shared/repository'

const DashboardContext = React.createContext<DashboardPrReviews | null>(null)

export function DashboardProvider({
  repositories,
  children
}: {
  repositories: Repository[]
  children: React.ReactNode
}): React.JSX.Element {
  const value = useDashboardPrReviews(repositories)
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>
}

export function useDashboard(): DashboardPrReviews {
  const value = React.useContext(DashboardContext)
  if (!value) throw new Error('useDashboard must be used within DashboardProvider.')
  return value
}
