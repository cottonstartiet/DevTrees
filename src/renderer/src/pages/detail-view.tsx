import * as React from 'react'
import {
  GitPullRequest as GitPullRequestIcon,
  GitPullRequestArrow as GitPullRequestArrowIcon,
  Loader2 as Loader2Icon
} from 'lucide-react'

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
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExistingPullRequest } from '@shared/repo'
import type { Workspace } from '@shared/workspace'
import type { Worktree } from '@shared/worktree'

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
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 p-6"
    >
      <div className="flex shrink-0 items-center gap-3">
        <TabsList>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="pull-request">Pull Request</TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-1">
          <PrTabActions
            existingPullRequest={props.existingPullRequest}
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

interface PrTabActionsProps {
  existingPullRequest: ExistingPullRequest | null
  onCreatePullRequest?: () => void
  onOpenPullRequest?: () => void
  isCreatingPullRequest?: boolean
  isPullRequestStatusResolved?: boolean
}

function PrTabActions({
  existingPullRequest,
  onCreatePullRequest,
  onOpenPullRequest,
  isCreatingPullRequest = false,
  isPullRequestStatusResolved = true
}: PrTabActionsProps): React.JSX.Element | null {
  const [isOpeningPR, setIsOpeningPR] = React.useState(false)

  const showOpenPr = !!existingPullRequest && !!onOpenPullRequest
  const showCreatePr = !showOpenPr && (!!onCreatePullRequest || isCreatingPullRequest)

  if (!showOpenPr && !showCreatePr) return null

  const handleOpenPR = async (): Promise<void> => {
    if (!onOpenPullRequest || isOpeningPR) return
    setIsOpeningPR(true)
    try {
      await Promise.resolve(onOpenPullRequest())
    } finally {
      setIsOpeningPR(false)
    }
  }

  return (
    <>
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
