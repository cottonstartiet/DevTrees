export type AdoErrorCode =
  | 'no-origin'
  | 'unsupported-remote'
  | 'no-default-branch'
  | 'az-not-installed'
  | 'az-extension-missing'
  | 'az-not-logged-in'
  | 'az-failed'
  | 'git-failed'

export type AdoReviewerVote = -10 | -5 | 0 | 5 | 10

export type AdoReviewer = {
  displayName: string
  uniqueName?: string
  vote: AdoReviewerVote
  isRequired: boolean
}

export type AdoPrDetails = {
  id: number
  title: string
  status: string
  isDraft: boolean
  sourceRef: string
  targetRef: string
  webUrl: string
  reviewers: AdoReviewer[]
  creationDate: string | null
}

export type AdoPrDetailsRequest = { folderPath: string; pullRequestId: number }

export type AdoPrDetailsResult =
  | { ok: true; details: AdoPrDetails }
  | { ok: false; code: AdoErrorCode; message?: string }

export type AdoPrThreadStatus =
  | 'unknown'
  | 'active'
  | 'pending'
  | 'fixed'
  | 'wontFix'
  | 'closed'
  | 'byDesign'

export type AdoPrCommentAuthor = {
  displayName: string
  uniqueName?: string
}

export type AdoPrComment = {
  id: number
  author: AdoPrCommentAuthor
  content: string
  publishedDate: string | null
}

export type AdoPrThread = {
  id: number
  status: AdoPrThreadStatus
  filePath: string | null
  lineNumber: number | null
  comments: AdoPrComment[]
  lastUpdated: string | null
  webUrl: string
}

export type AdoPrThreadsRequest = { folderPath: string; pullRequestId: number }

export type AdoPrThreadsResult =
  | { ok: true; threads: AdoPrThread[] }
  | { ok: false; code: AdoErrorCode; message?: string }

export type AdoMyOpenPr = {
  id: number
  title: string
  sourceRef: string
  targetRef: string
  webUrl: string
  createdAt: string | null
  status: string
  isDraft: boolean
}

export type AdoMyOpenPrsRequest = { folderPath: string }

export type AdoMyOpenPrsResult =
  | { ok: true; prs: AdoMyOpenPr[] }
  | { ok: false; code: AdoErrorCode; message?: string }

export const AdoIpcChannels = {
  PrDetails: 'ado:pr-details',
  PrThreads: 'ado:pr-threads',
  MyOpenPrs: 'ado:my-open-prs'
} as const
