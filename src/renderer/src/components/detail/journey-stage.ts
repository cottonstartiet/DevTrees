import type { ExistingPullRequest, JourneySignal } from '@shared/repo'

export type JourneyStageId =
  | 'worktree'
  | 'branch'
  | 'implement'
  | 'commit'
  | 'push'
  | 'create-pr'
  | 'review'
  | 'merged'

export type JourneyStageState = 'done' | 'current' | 'upcoming'

export interface JourneyStageView {
  id: JourneyStageId
  label: string
  state: JourneyStageState
}

/** The single primary next-action the rail surfaces. */
export type JourneyActionKind =
  | 'create-branch'
  | 'start-implement'
  | 'commit'
  | 'push'
  | 'create-pr'
  | 'open-pr'
  | 'resolve-conflicts'
  | 'checking'
  | 'none'

export interface JourneyPrimaryAction {
  kind: JourneyActionKind
  label: string
  /** The stage this action belongs to — drives which stage renders as `current`. */
  stageId: JourneyStageId
  disabled: boolean
  loading: boolean
}

export interface JourneyView {
  stages: JourneyStageView[]
  primary: JourneyPrimaryAction
  /** True when on the default branch — the rail shows a reduced hint instead of a CTA. */
  reduced: boolean
  reducedHint: string | null
  /** True when a rebase/merge is in progress or there are conflicted files. */
  conflict: boolean
  aheadOfDefault: number | null
  behindOfDefault: number | null
}

export interface JourneyDeriveInput {
  signal: JourneySignal | null
  /** Working-copy dirty state from the working-copy controller (authoritative). */
  hasUncommitted: boolean
  conflictedCount: number
  existingPullRequest: ExistingPullRequest | null
  isPullRequestStatusResolved: boolean
  isCommitting: boolean
  isPushing: boolean
  isCreatingPullRequest: boolean
  /** Whether each action's handler is wired/available in the current context. */
  canCreateBranch: boolean
  canCreatePr: boolean
  canOpenPr: boolean
}

const STAGE_ORDER: JourneyStageId[] = [
  'worktree',
  'branch',
  'implement',
  'commit',
  'push',
  'create-pr',
  'review',
  'merged'
]

const STAGE_LABELS: Record<JourneyStageId, string> = {
  worktree: 'Worktree',
  branch: 'Branch',
  implement: 'Implement',
  commit: 'Commit',
  push: 'Push',
  'create-pr': 'Create PR',
  review: 'In Review',
  merged: 'Merged'
}

function n(value: number | null | undefined): number {
  return value ?? 0
}

function isPrCompleted(pr: ExistingPullRequest | null): boolean {
  return pr?.status?.toLowerCase() === 'completed'
}

/**
 * Derives the journey rail view from the current signals. Lifecycle position
 * (which stages are done) is computed independently from the single primary
 * next-action, so a PR that exists while the tree is dirty again still surfaces
 * "Commit"/"Push" as the action while showing "Create PR" as already done.
 */
export function deriveJourney(input: JourneyDeriveInput): JourneyView {
  const { signal, existingPullRequest: pr } = input
  const branch = signal?.branch ?? null
  const isDetached = signal?.isDetached ?? false
  const isDefaultBranch = signal?.isDefaultBranch ?? false
  const hasRemoteBranch = signal?.hasRemoteBranch ?? false
  const aheadOfDefault = signal?.aheadOfDefault ?? null
  const behindOfDefault = signal?.behindOfDefault ?? null
  const aheadOfUpstream = signal?.aheadOfUpstream ?? null
  const mergeOperation = signal?.mergeOperation ?? 'none'
  const hasUncommitted = input.hasUncommitted
  const conflict = mergeOperation !== 'none' || input.conflictedCount > 0
  const prExists = pr != null
  const prCompleted = isPrCompleted(pr)

  const onFeatureBranch = !isDetached && !!branch && !isDefaultBranch
  const committed = n(aheadOfDefault) > 0
  const pushed = hasRemoteBranch && n(aheadOfUpstream) === 0 && committed

  // Independent per-stage completion.
  const done: Record<JourneyStageId, boolean> = {
    worktree: true,
    branch: onFeatureBranch || prExists,
    implement: committed || hasUncommitted || prExists,
    commit: committed || pushed || prExists,
    push: pushed || prExists,
    'create-pr': prExists,
    review: prCompleted,
    merged: prCompleted
  }

  const primary = derivePrimaryAction(input, {
    isDetached,
    isDefaultBranch,
    branch,
    hasUncommitted,
    conflict,
    hasRemoteBranch,
    aheadOfDefault,
    aheadOfUpstream,
    committed,
    pushed,
    prExists,
    prCompleted
  })

  const stages: JourneyStageView[] = STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    state: id === primary.stageId ? 'current' : done[id] ? 'done' : 'upcoming'
  }))

  const reduced = isDefaultBranch && !isDetached
  const reducedHint = reduced
    ? `On ${branch ?? 'the default branch'} — create a worktree or branch to start a change.`
    : null

  return {
    stages,
    primary,
    reduced,
    reducedHint,
    conflict,
    aheadOfDefault,
    behindOfDefault
  }
}

interface DerivedFacts {
  isDetached: boolean
  isDefaultBranch: boolean
  branch: string | null
  hasUncommitted: boolean
  conflict: boolean
  hasRemoteBranch: boolean
  aheadOfDefault: number | null
  aheadOfUpstream: number | null
  committed: boolean
  pushed: boolean
  prExists: boolean
  prCompleted: boolean
}

function derivePrimaryAction(
  input: JourneyDeriveInput,
  facts: DerivedFacts
): JourneyPrimaryAction {
  const {
    isDetached,
    isDefaultBranch,
    hasUncommitted,
    conflict,
    hasRemoteBranch,
    aheadOfDefault,
    aheadOfUpstream,
    committed,
    pushed,
    prExists,
    prCompleted
  } = facts

  // 1. Conflict / in-progress rebase or merge preempts everything.
  if (conflict) {
    return {
      kind: 'resolve-conflicts',
      label: 'Resolve conflicts',
      stageId: prExists ? 'review' : 'commit',
      disabled: false,
      loading: false
    }
  }

  // 2. Detached HEAD — protect the work by turning it into a branch.
  if (isDetached) {
    const hasWork = n(aheadOfDefault) > 0 || hasUncommitted
    return {
      kind: 'create-branch',
      label: hasWork ? 'Save as branch' : 'Create branch',
      stageId: 'branch',
      disabled: !input.canCreateBranch,
      loading: false
    }
  }

  // 3. On the default branch — no lifecycle action (reduced hint shown instead).
  if (isDefaultBranch) {
    return { kind: 'none', label: '', stageId: 'branch', disabled: true, loading: false }
  }

  // 4. Uncommitted changes — commit them (regardless of any existing PR).
  if (hasUncommitted) {
    return {
      kind: 'commit',
      label: 'Commit',
      stageId: 'commit',
      disabled: input.isCommitting,
      loading: input.isCommitting
    }
  }

  // 5. Clean tree with local commits not on origin — push (first push or new commits).
  const needsPush =
    n(aheadOfUpstream) > 0 || (!hasRemoteBranch && n(aheadOfDefault) > 0)
  if (needsPush) {
    return {
      kind: 'push',
      label: 'Push',
      stageId: 'push',
      disabled: input.isPushing,
      loading: input.isPushing
    }
  }

  // 6. Clean & pushed but PR status still resolving — avoid flicker between create/open.
  if (!input.isPullRequestStatusResolved && (pushed || prExists)) {
    return {
      kind: 'checking',
      label: 'Checking PR…',
      stageId: 'create-pr',
      disabled: true,
      loading: true
    }
  }

  // 7. A PR exists — it's in review (or completed).
  if (prExists) {
    if (prCompleted) {
      return { kind: 'none', label: 'Merged', stageId: 'merged', disabled: true, loading: false }
    }
    return {
      kind: 'open-pr',
      label: 'Open PR',
      stageId: 'review',
      disabled: !input.canOpenPr,
      loading: false
    }
  }

  // 8. Clean, pushed, commits ahead of default, no PR — create the PR.
  if (pushed && committed) {
    return {
      kind: 'create-pr',
      label: 'Create PR',
      stageId: 'create-pr',
      disabled: input.isCreatingPullRequest || !input.canCreatePr,
      loading: input.isCreatingPullRequest
    }
  }

  // 9. Fresh branch, nothing to commit or push yet — start implementing.
  return {
    kind: 'start-implement',
    label: 'Start implementing',
    stageId: 'implement',
    disabled: false,
    loading: false
  }
}
