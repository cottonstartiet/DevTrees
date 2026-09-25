---
name: commit-and-push
description: Use when the user asks to commit and push all current repository changes to the current Git branch. Always requires explicit confirmation immediately before staging, committing, and pushing.
user-invocable: true
argument-hint: '[optional commit message]'
---

Commit and push all repository changes to the current branch safely.

## Required workflow

1. Perform read-only checks:
   - Run `git status --short`.
   - Resolve the current branch with `git branch --show-current`.
   - Inspect configured remotes and the branch's upstream.
   - Review `git diff --check`, the diff summary, staged changes, unstaged
     changes, and untracked file names.
2. Stop if there are no changes to commit.
3. Stop and explain the problem if:
   - `HEAD` is detached.
   - The repository is mid-merge, mid-rebase, or has unresolved conflicts.
   - The intended remote or destination branch cannot be determined safely.
4. Summarize exactly what will happen, including:
   - The current branch.
   - The destination remote and branch.
   - The files that will be included.
   - The proposed commit message.
5. **Always use the user-question tool to ask for explicit confirmation
   immediately before making changes.** Ask:

   > Do you approve staging all listed changes, committing them as
   > "<message>", and pushing the commit to <remote>/<branch>?

   The request that invoked this skill is not confirmation. Do not stage,
   commit, or push until the user approves this prompt.

6. After approval, repeat `git status --short` and verify that the branch,
   destination, and file set still match the confirmed scope. If they changed,
   summarize the new scope and ask for confirmation again.
7. Stage all changes with `git add -A`.
8. Create one non-interactive commit:
   - Use the user's supplied commit message when provided.
   - Otherwise derive a concise imperative message from the diff.
   - Follow repository commit-message instructions.
   - Include any repository-required commit trailers.
9. Push without rewriting history:
   - Push the current branch to its confirmed remote branch.
   - Never use `--force`, `--force-with-lease`, amend, reset, or rebase.
   - If no upstream exists, use `git push --set-upstream <remote> <branch>`
     only when that exact destination was included in the confirmation.
10. Verify that:
    - `git status --short` is clean.
    - Local `HEAD` matches the confirmed remote-tracking branch.
11. Report the commit hash, subject, and pushed destination.

## Safety rules

- Confirmation is single-use and applies only to the exact branch, remote,
  commit message, and file set shown to the user.
- Never include files outside the repository.
- Never bypass hooks.
- If a hook changes files or the commit fails, do not silently retry. Show the
  result, reassess the file set, and obtain fresh confirmation before another
  commit or push attempt.
- If credentials, tokens, private keys, or other likely secrets are visible in
  the changes, stop and warn the user instead of committing.
- Do not push when the user declines, cancels, or gives an ambiguous response.
