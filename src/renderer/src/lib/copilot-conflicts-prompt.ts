import type { MergeOperation } from '@shared/repo'

export interface ConflictedFile {
  path: string
  indexStatus: string
  worktreeStatus: string
}

export interface BuildConflictsPromptArgs {
  folderPath: string
  branch: string | null
  defaultBranch: string | null
  conflictedFiles: ConflictedFile[]
  mergeState: MergeOperation
  rebaseHeadName?: string
  rebaseOnto?: string
  mergeHeads?: string[]
}

const STATUS_LABELS: Record<string, string> = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  AU: 'added by us',
  UA: 'added by them',
  UD: 'deleted by them',
  DU: 'deleted by us'
}

function describeStatus(file: ConflictedFile): string {
  const code = `${file.indexStatus}${file.worktreeStatus}`
  return STATUS_LABELS[code] ?? `unmerged (${code})`
}

export function buildConflictsPrompt({
  folderPath,
  branch,
  defaultBranch,
  conflictedFiles,
  mergeState,
  rebaseHeadName,
  rebaseOnto,
  mergeHeads
}: BuildConflictsPromptArgs): string {
  const contextLines = [
    `- Working directory: ${folderPath}`,
    branch ? `- Current branch: ${branch}` : '',
    defaultBranch ? `- Default branch: ${defaultBranch}` : ''
  ].filter((line) => line.length > 0)

  let operationBlock: string[]
  let oursTheirsReminder: string
  let followUpHint: string
  switch (mergeState) {
    case 'rebase':
      operationBlock = [
        'Operation in flight: REBASE',
        rebaseHeadName ? `- Branch being rebased: ${rebaseHeadName}` : '',
        rebaseOnto ? `- Rebasing onto: ${rebaseOnto}` : ''
      ].filter((line) => line.length > 0)
      oursTheirsReminder =
        'IMPORTANT — during a rebase the "ours / theirs" naming is REVERSED relative to merge:\n' +
        '  - "ours" (<<<<<<< HEAD) = the commits already applied from the branch you are rebasing ONTO (e.g. the default branch).\n' +
        '  - "theirs" (>>>>>>>) = the commit from YOUR branch that is being replayed.\n' +
        '  Do not confuse this with a merge — the labels swap.'
      followUpHint =
        'After staging all resolved files, tell the user to run:\n  git rebase --continue\n' +
        '(or `git rebase --abort` if they want to back out).'
      break
    case 'merge':
      operationBlock = [
        'Operation in flight: MERGE',
        mergeHeads && mergeHeads.length > 0
          ? `- Merging in: ${mergeHeads.join(', ')}`
          : ''
      ].filter((line) => line.length > 0)
      oursTheirsReminder =
        'During a merge:\n' +
        '  - "ours" (<<<<<<< HEAD) = YOUR current branch.\n' +
        '  - "theirs" (>>>>>>>) = the branch being merged in.'
      followUpHint =
        'After staging all resolved files, tell the user to run:\n  git merge --continue\n' +
        '(or `git merge --abort` if they want to back out).'
      break
    case 'none':
    default:
      operationBlock = [
        'Operation in flight: NONE',
        'There are conflicted files in the working tree but no rebase or merge is currently in progress.',
        'Investigate before editing — the user may be mid-cherry-pick, mid-revert, or have leftover unmerged paths from a previous operation. Run `git status` and stop to ask the user how they want to proceed if anything looks off.'
      ]
      oursTheirsReminder =
        'No active merge/rebase, so the meaning of <<<<<<< / >>>>>>> depends on whatever operation produced the conflict. Ask the user if it is not obvious.'
      followUpHint =
        'After staging all resolved files, ask the user what they want to do next (commit, continue an operation, etc.). Do NOT assume.'
      break
  }

  const fileTable = conflictedFiles
    .map((f) => `  - ${f.path}  [${f.indexStatus}${f.worktreeStatus} — ${describeStatus(f)}]`)
    .join('\n')

  return [
    'You are helping me resolve merge conflicts in a git working tree.',
    '',
    'Context:',
    ...contextLines,
    '',
    ...operationBlock,
    '',
    oursTheirsReminder,
    '',
    `Conflicted files (${conflictedFiles.length}):`,
    fileTable,
    '',
    'Workflow you MUST follow, in order:',
    '1. For each conflicted file above, read it and locate every `<<<<<<<` / `=======` / `>>>>>>>` region. For files marked as deleted on one side (codes UD, DU, AU, UA, DD), decide whether the right resolution is to KEEP the file (`git add <path>`) or REMOVE it (`git rm <path>`).',
    '2. For each conflict region, propose a concrete resolution. Prefer keeping behavior from both sides when both made meaningful changes; do not silently drop one side.',
    '3. Produce a clear, numbered report grouped by file. For every conflict include:',
    '   - File and approximate line range',
    '   - 1-2 sentence summary of what each side changed',
    '   - Your proposed final code (a short snippet)',
    '4. STOP. Ask me to confirm which resolutions to apply. Let me skip or modify individual items. Do NOT edit any files before I confirm.',
    '5. After I confirm, edit each file to remove all `<<<<<<<` / `=======` / `>>>>>>>` markers and apply the agreed resolutions. Then run `git add <path>` for each file you resolved (or `git rm <path>` for files we decided to remove).',
    '6. Print a final summary listing which files were resolved and which were skipped. Then print this exact follow-up hint:',
    `   ${followUpHint.split('\n').join('\n   ')}`,
    '',
    'Hard rules:',
    '- Do NOT edit any files before I explicitly confirm in step 5.',
    '- Do NOT run `git rebase --continue`, `git merge --continue`, `git rebase --abort`, `git merge --abort`, `git commit`, `git push`, or any history-rewriting command.',
    '- Do NOT discard or stash uncommitted work. Stop and ask first.',
    '- If a file has no conflict markers (e.g. someone resolved it externally) say so and skip it; do not invent edits.'
  ].join('\n')
}
