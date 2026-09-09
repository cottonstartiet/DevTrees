export const AUTO_REVIEW_REFRESH_INTERVAL_MS = 10 * 60 * 1000

export type AutoReviewStatus = 'checking' | 'launching' | 'started' | 'already-triggered' | 'failed'

export type AutoReviewCandidate = {
  key: string
}

export type AutoReviewLaunchResult = { ok: true } | { ok: false; error: string }

export function autoReviewKey(
  repositoryPath: string,
  provider: string,
  pullRequestId: number
): string {
  return `${repositoryPath.toLowerCase()}::${provider}::${pullRequestId}`
}

export async function processAutoReviews<T extends AutoReviewCandidate>(
  candidates: T[],
  claim: (candidate: T) => Promise<boolean>,
  launch: (candidate: T) => Promise<AutoReviewLaunchResult>,
  onStatus: (candidate: T, status: AutoReviewStatus) => void
): Promise<Record<string, string>> {
  const errors: Record<string, string> = {}

  for (const candidate of candidates) {
    onStatus(candidate, 'checking')
    try {
      if (!(await claim(candidate))) {
        onStatus(candidate, 'already-triggered')
        continue
      }

      onStatus(candidate, 'launching')
      const result = await launch(candidate)
      if (result.ok) {
        onStatus(candidate, 'started')
      } else {
        onStatus(candidate, 'failed')
        errors[candidate.key] = result.error
      }
    } catch (error) {
      onStatus(candidate, 'failed')
      errors[candidate.key] =
        error instanceof Error ? error.message : 'Could not start automatic review'
    }
  }

  return errors
}
