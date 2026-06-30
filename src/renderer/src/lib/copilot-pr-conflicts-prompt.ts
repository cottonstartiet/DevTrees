export interface BuildPrConflictsPromptArgs {
  folderPath: string
  branch: string | null
  targetBranch: string
  prId: number
  prTitle: string
}

export function buildPrConflictsPrompt({
  folderPath,
  branch,
  targetBranch,
  prId,
  prTitle
}: BuildPrConflictsPromptArgs): string {
  const contextLines = [
    `- Working directory: ${folderPath}`,
    branch ? `- Pull request branch (current): ${branch}` : '',
    `- Target branch: ${targetBranch}`,
    `- Pull request: #${prId}${prTitle ? ` — ${prTitle}` : ''}`
  ].filter((line) => line.length > 0)

  return [
    'You are helping me make an Azure DevOps pull request mergeable by resolving the merge',
    'conflicts between my PR branch and its target branch. The conflicts are NOT yet present in',
    'the working tree — you must create them by merging the target branch in, then resolve them.',
    '',
    'Context:',
    ...contextLines,
    '',
    'IMPORTANT — integration strategy is MERGE (not rebase). Do NOT force-push and do NOT rewrite history.',
    '',
    'Workflow you MUST follow, in order:',
    '1. Run `git status` first. If there are uncommitted changes, STOP and ask me how to proceed —',
    '   do NOT stash or discard anything on your own.',
    `2. Run \`git fetch origin\`. Then run \`git merge origin/${targetBranch}\` to merge the target`,
    '   branch into the current PR branch. This is expected to stop with conflicts.',
    '3. For each conflicted file, read it and locate every `<<<<<<<` / `=======` / `>>>>>>>` region.',
    '   During this merge:',
    '     - "ours" (<<<<<<< HEAD) = YOUR pull request branch.',
    `     - "theirs" (>>>>>>>) = the target branch (${targetBranch}) being merged in.`,
    '   For files marked as deleted on one side, decide whether to keep (`git add <path>`) or remove',
    '   (`git rm <path>`) the file.',
    '4. For each conflict region, propose a concrete resolution. Prefer keeping behavior from both',
    '   sides when both made meaningful changes; do not silently drop one side. Produce a clear,',
    '   numbered report grouped by file, with the file/approx line range, a 1-2 sentence summary of',
    '   what each side changed, and your proposed final code (a short snippet).',
    '5. STOP. Ask me to confirm which resolutions to apply. Let me skip or modify individual items.',
    '   Do NOT edit any files before I confirm.',
    '6. After I confirm: edit each file to remove all conflict markers and apply the agreed',
    '   resolutions, then `git add <path>` (or `git rm <path>`) for every file you resolved.',
    '7. Complete the merge with `git commit` (keep the default merge commit message, or a clear one).',
    `8. Push with a normal \`git push\`. Do NOT use --force or --force-with-lease.`,
    '9. Print a final summary listing which files were resolved/skipped, and confirm the push',
    `   succeeded so PR #${prId} can re-evaluate its merge status.`,
    '',
    'Hard rules:',
    '- Do NOT edit any files before I explicitly confirm in step 5.',
    '- Do NOT run `git merge --abort`, `git reset --hard`, `git rebase`, or any history-rewriting command.',
    '- Do NOT force-push.',
    '- Do NOT discard or stash uncommitted work. Stop and ask first.',
    '- If `git merge` reports "Already up to date" (no conflicts), say so and stop — there is nothing to resolve.'
  ].join('\n')
}
