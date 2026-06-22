export interface BuildPrCommentsPromptArgs {
  folderPath: string
  pullRequestId: number
  prTitle?: string
  prWebUrl?: string
}

export function buildPrCommentsPrompt({
  folderPath,
  pullRequestId,
  prTitle,
  prWebUrl
}: BuildPrCommentsPromptArgs): string {
  const titleLine = prTitle ? `- PR title: ${prTitle}` : ''
  const urlLine = prWebUrl ? `- PR web URL: ${prWebUrl}` : ''
  const contextLines = [
    `- Working directory: ${folderPath}`,
    `- Pull request ID: ${pullRequestId}`,
    titleLine,
    urlLine
  ]
    .filter((line) => line.length > 0)
    .join('\n')

  return [
    'You are helping me address reviewer comments on an Azure DevOps pull request.',
    '',
    'Context:',
    contextLines,
    '',
    'The current working directory is already the worktree checked out to the PR source branch.',
    'The Azure CLI (`az`) is installed and authenticated, and the `azure-devops` extension is available.',
    '',
    'Workflow you MUST follow, in order:',
    `1. Fetch all comment threads for PR ${pullRequestId} via:`,
    `   az repos pr thread list --pull-request-id ${pullRequestId} --output json --detect true`,
    '   (Use `--detect true` so org/project/repo are inferred from the current git remote. If detection fails, run `git remote -v` and pass `--org`, `--project`, and `--repository` explicitly.)',
    '2. Filter to threads whose `status` is "active" (unresolved). Ignore fixed, closed, wontFix, byDesign, and pending threads.',
    '3. For each active thread, identify the file path, line number, reviewer, and the latest reviewer ask. Read the relevant code in the working directory so you understand the context.',
    '4. Produce a clear, numbered report grouped by file. For every item include:',
    '   - File and line',
    '   - Short summary of what the reviewer is asking for',
    '   - Your proposed fix (1-3 sentences, plus a short code sketch if useful)',
    '5. STOP. Ask me to confirm which items to apply. Let me skip individual items or modify your proposal. Do NOT edit any files before I confirm.',
    '6. After I confirm, apply the approved fixes file-by-file. Then summarize what changed and remind me to review, commit, and push.',
    '',
    'Hard rules:',
    '- Do NOT modify any files before I explicitly confirm in step 5.',
    '- Do NOT commit, push, or amend any git history unless I explicitly ask.',
    '- Do NOT reply to or resolve any PR threads via `az` unless I explicitly ask.',
    '- If `az` is not logged in or the PR cannot be fetched, stop and tell me exactly what failed.'
  ].join('\n')
}
