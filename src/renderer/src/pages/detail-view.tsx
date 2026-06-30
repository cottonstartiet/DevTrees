import * as React from 'react'
import {
  GitMerge as GitMergeIcon,
  GitPullRequest as GitPullRequestIcon,
  GitPullRequestArrow as GitPullRequestArrowIcon,
  Loader2 as Loader2Icon,
  Sparkles as SparklesIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { PlaceholderCard } from '@/components/detail/dashboard-card'
import { DetachedNudgePanel } from '@/components/detail/detached-nudge-panel'
import { MyOpenPrsPanel } from '@/components/detail/my-open-prs-panel'
import { PrCommentsPanel } from '@/components/detail/pr-comments-panel'
import { RecentCommitsPanel } from '@/components/detail/recent-commits-panel'
import {
  ChangesTabActions,
  WorkingCopyStatusView
} from '@/components/detail/working-copy-status-panel'
import {
  useWorkingCopyController,
  type WorkingCopyController
} from '@/components/detail/use-working-copy-controller'
import { WorktreesOverviewPanel } from '@/components/detail/worktrees-overview-panel'
import { MyBranchesPanel } from '@/components/detail/my-branches-panel'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { buildPrConflictsPrompt } from '@/lib/copilot-pr-conflicts-prompt'
import type { ExistingPullRequest } from '@shared/repo'
import type { Workspace } from '@shared/workspace'
import type { Worktree } from '@shared/worktree'

const IS_WINDOWS =
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '')

export type DetailViewSelectionKind =
  | 'empty'
  | 'workspace-default'
  | 'workspace-feature'
  | 'worktree-detached'
  | 'worktree-default'
  | 'worktree-feature'

export interface DetailViewProps {
  workspace: Workspace | null
  worktree: Worktree | null
  folderPath: string | null
  branch: string | null
  defaultBranch: string | null
  headState?: 'branch' | 'detached'
  existingPullRequest: ExistingPullRequest | null
  onCreateBranch?: () => void
  onCreatePullRequest?: () => void
  onOpenPullRequest?: () => void
  onPullRequestTabActive?: () => void
  isCreatingPullRequest?: boolean
  isPullRequestStatusResolved?: boolean
  onSelectWorktreePath?: (worktreePath: string) => void
}

function deriveKind(props: DetailViewProps): DetailViewSelectionKind {
  const { workspace, worktree, branch, defaultBranch, folderPath } = props
  if (!workspace || !folderPath) return 'empty'
  if (worktree) {
    if (worktree.isDetached) return 'worktree-detached'
    if (branch && defaultBranch && branch === defaultBranch) return 'worktree-default'
    return 'worktree-feature'
  }
  if (branch && defaultBranch && branch === defaultBranch) return 'workspace-default'
  return 'workspace-feature'
}

export function DetailView(props: DetailViewProps): React.JSX.Element {
  const kind = deriveKind(props)
  const ctrl = useWorkingCopyController({
    folderPath: props.folderPath,
    branch: props.branch,
    defaultBranch: props.defaultBranch
  })

  if (kind === 'empty') {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          Welcome to DevTrees. Add a workspace from the sidebar to get started.
        </p>
      </div>
    )
  }

  const folderPath = props.folderPath as string

  return (
    <Tabs
      key={folderPath}
      defaultValue="changes"
      onValueChange={(value) => {
        if (value === 'pull-request') props.onPullRequestTabActive?.()
      }}
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 p-6"
    >
      <div className="flex shrink-0 items-center gap-3">
        <TabsList>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="branches">Branches</TabsTrigger>
          <TabsTrigger value="pull-request">Pull Request</TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-1">
          <StartCopilotSessionAction
            folderPath={folderPath}
            branch={props.branch}
            isWorktree={props.worktree != null}
          />
          <PrTabActions
            existingPullRequest={props.existingPullRequest}
            folderPath={folderPath}
            branch={props.branch}
            defaultBranch={props.defaultBranch}
            onCreatePullRequest={props.onCreatePullRequest}
            onOpenPullRequest={props.onOpenPullRequest}
            isCreatingPullRequest={props.isCreatingPullRequest}
            isPullRequestStatusResolved={props.isPullRequestStatusResolved}
          />
          <ChangesTabActions ctrl={ctrl} />
        </div>
      </div>

      <TabsContent
        value="changes"
        forceMount
        className="min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden"
      >
        <ChangesTab ctrl={ctrl} folderPath={folderPath} />
      </TabsContent>

      <TabsContent
        value="branches"
        forceMount
        className="min-h-0 min-w-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
      >
        <BranchesTab {...props} kind={kind} />
      </TabsContent>

      <TabsContent
        value="pull-request"
        forceMount
        className="min-h-0 min-w-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
      >
        <PullRequestTab {...props} kind={kind} />
      </TabsContent>
    </Tabs>
  )
}

interface TabSectionProps extends DetailViewProps {
  kind: DetailViewSelectionKind
}

interface StartCopilotSessionActionProps {
  folderPath: string
  branch: string | null
  isWorktree: boolean
}

function StartCopilotSessionAction({
  folderPath,
  branch
}: StartCopilotSessionActionProps): React.JSX.Element {
  const [isStarting, setIsStarting] = React.useState(false)
  const launchCopilot = useCopilotLauncher()

  const handleStart = async (): Promise<void> => {
    if (isStarting) return
    setIsStarting(true)
    try {
      const result = await launchCopilot({
        folderPath,
        label: branch || folderPath.split(/[\\/]/).pop() || 'Copilot',
        branch: branch || undefined
      })
      if (result.ok) {
        toast.success('Copilot session started.')
      } else {
        toast.error(`Could not start Copilot session: ${result.error}`)
      }
    } catch (err) {
      toast.error(
        `Could not start Copilot session: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            disabled={!IS_WINDOWS || isStarting}
            onClick={() => void handleStart()}
          >
            {isStarting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            <span className="text-xs">Copilot</span>
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {IS_WINDOWS ? 'Start a Copilot session in this worktree' : 'Copilot sessions (Windows only)'}
      </TooltipContent>
    </Tooltip>
  )
}

interface PrTabActionsProps {
  existingPullRequest: ExistingPullRequest | null
  folderPath: string
  branch: string | null
  defaultBranch: string | null
  onCreatePullRequest?: () => void
  onOpenPullRequest?: () => void
  isCreatingPullRequest?: boolean
  isPullRequestStatusResolved?: boolean
}

function PrTabActions({
  existingPullRequest,
  folderPath,
  branch,
  defaultBranch,
  onCreatePullRequest,
  onOpenPullRequest,
  isCreatingPullRequest = false,
  isPullRequestStatusResolved = true
}: PrTabActionsProps): React.JSX.Element | null {
  const [isOpeningPR, setIsOpeningPR] = React.useState(false)
  const [isResolvingConflicts, setIsResolvingConflicts] = React.useState(false)
  const launchCopilot = useCopilotLauncher()

  const showOpenPr = !!existingPullRequest && !!onOpenPullRequest
  const showCreatePr = !showOpenPr && (!!onCreatePullRequest || isCreatingPullRequest)
  const showResolveConflicts = !!existingPullRequest

  if (!showOpenPr && !showCreatePr && !showResolveConflicts) return null

  const hasMergeConflict = existingPullRequest?.mergeStatus === 'conflicts'

  const handleOpenPR = async (): Promise<void> => {
    if (!onOpenPullRequest || isOpeningPR) return
    setIsOpeningPR(true)
    try {
      await Promise.resolve(onOpenPullRequest())
    } finally {
      setIsOpeningPR(false)
    }
  }

  const handleResolveConflicts = async (): Promise<void> => {
    if (!existingPullRequest || !defaultBranch || isResolvingConflicts) return
    setIsResolvingConflicts(true)
    try {
      const prompt = buildPrConflictsPrompt({
        folderPath,
        branch,
        targetBranch: defaultBranch,
        prId: existingPullRequest.id,
        prTitle: existingPullRequest.title
      })
      const result = await launchCopilot({
        folderPath,
        prompt,
        label: branch ? `Resolve PR conflicts: ${branch}` : 'Resolve PR conflicts',
        branch: branch ?? undefined
      })
      if (result.ok) {
        toast.success('Copilot session started.')
      } else {
        toast.error(`Could not start Copilot session: ${result.error}`)
      }
    } catch (err) {
      toast.error(
        `Could not start Copilot session: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    } finally {
      setIsResolvingConflicts(false)
    }
  }

  return (
    <>
      {showResolveConflicts ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                disabled={!hasMergeConflict || !defaultBranch || isResolvingConflicts}
                onClick={() => void handleResolveConflicts()}
              >
                {isResolvingConflicts ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <GitMergeIcon className="size-3.5" />
                )}
                <span className="text-xs">Resolve conflicts</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {hasMergeConflict
              ? 'Launch Copilot CLI to merge the target branch and resolve PR conflicts'
              : 'No merge conflicts to resolve in this pull request'}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showOpenPr ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                disabled={isOpeningPR}
                onClick={() => void handleOpenPR()}
              >
                {isOpeningPR ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <GitPullRequestIcon className="size-3.5" />
                )}
                <span className="text-xs">Open PR</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Open PR #{existingPullRequest!.id} in Azure DevOps</TooltipContent>
        </Tooltip>
      ) : null}
      {showCreatePr ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                disabled={
                  isCreatingPullRequest ||
                  !onCreatePullRequest ||
                  !isPullRequestStatusResolved
                }
                onClick={onCreatePullRequest}
              >
                {isCreatingPullRequest || !isPullRequestStatusResolved ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <GitPullRequestArrowIcon className="size-3.5" />
                )}
                <span className="text-xs">
                  {isCreatingPullRequest
                    ? 'Creating PR…'
                    : !isPullRequestStatusResolved
                      ? 'Checking PR…'
                      : 'Create PR'}
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {isCreatingPullRequest
              ? 'Creating pull request in Azure DevOps…'
              : !isPullRequestStatusResolved
                ? 'Checking for an existing pull request…'
                : 'Create pull request in Azure DevOps'}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}

interface ChangesTabProps {
  ctrl: WorkingCopyController
  folderPath: string | null
}

function ChangesTab({ ctrl, folderPath }: ChangesTabProps): React.JSX.Element {
  if (!folderPath) {
    return <PlaceholderCard title="Changes" hint="Select a folder to inspect changes." />
  }
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <WorkingCopyStatusView ctrl={ctrl} />
    </div>
  )
}

function BranchesTab({
  folderPath,
  workspace,
  onSelectWorktreePath
}: TabSectionProps): React.JSX.Element {
  if (!workspace) {
    return (
      <PlaceholderCard
        title="Branches"
        hint="Branch list is available at the workspace level."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-4">
      <MyBranchesPanel
        workspacePath={workspace.path}
        activeFolderPath={folderPath}
        onSelectWorktree={onSelectWorktreePath}
      />
    </div>
  )
}

function PullRequestTab({
  kind,
  folderPath,
  branch,
  defaultBranch,
  workspace,
  existingPullRequest,
  onCreateBranch,
  onSelectWorktreePath
}: TabSectionProps): React.JSX.Element {
  const isWorkspaceRoot = kind === 'workspace-default' || kind === 'workspace-feature'
  const isFeature = kind === 'workspace-feature' || kind === 'worktree-feature'
  const isWorktreeDetached = kind === 'worktree-detached'

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {isWorkspaceRoot && workspace ? (
        <>
          <WorktreesOverviewPanel
            workspacePath={workspace.path}
            activeFolderPath={folderPath}
            onSelectWorktree={onSelectWorktreePath}
          />
          {folderPath ? <MyOpenPrsPanel folderPath={folderPath} /> : null}
        </>
      ) : null}

      {isWorktreeDetached && folderPath ? (
        <DetachedNudgePanel onCreateBranch={onCreateBranch} />
      ) : null}

      {isFeature && folderPath && branch && defaultBranch ? (
        existingPullRequest ? (
          <PrCommentsPanel
            folderPath={folderPath}
            pullRequestId={existingPullRequest.id}
            prTitle={existingPullRequest.title}
            prWebUrl={existingPullRequest.webUrl}
          />
        ) : (
          <PlaceholderCard title="Pull request" hint="No active PR for this branch yet." />
        )
      ) : null}

      {folderPath ? (
        <div className="lg:col-span-2">
          <RecentCommitsPanel folderPath={folderPath} />
        </div>
      ) : null}
    </div>
  )
}
