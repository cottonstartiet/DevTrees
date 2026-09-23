import * as React from 'react'
import { DndContext } from '@dnd-kit/core'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '@/assets/main.css'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { alignSplitRows, type DiffDisplayRow } from '@/components/pr-review/diff-rows'
import { DiffView } from '@/components/pr-review/diff-view'
import { ReviewWorkspace } from '@/components/pr-review/review-workspace'
import { CreateBranchDialog } from '@/components/create-branch-dialog'
import { GlobalTaskShortcut } from '@/components/global-task-shortcut'
import { TaskCard } from '@/components/task-card'
import { TaskColumn } from '@/components/task-column'
import { TaskDetailDialog } from '@/components/task-detail-dialog'
import { TerminalTimeline } from '@/components/sessions/terminal-timeline'
import { TasksProvider } from '@/contexts/tasks-context'
import { TaskBoardProvider, useTaskBoard } from '@/contexts/task-board-context'
import { ThemeProvider } from '@/contexts/theme-context'
import { useNativeSessions } from '@/contexts/use-native-sessions'
import { useRepoStatus } from '@/hooks/use-repo-status'
import { openTaskSession } from '@/lib/task-session-routing'
import { TasksBoardLayout } from '@/pages/tasks'
import { RemoteTimelineEntry } from '../src/remote/src/session-timeline-entry'
import {
  mergeNativeSnapshot,
  type NativeSnapshot,
  type NativeSnapshotUpdate
} from '@shared/native-session'
import type { MoveTaskResult, Task } from '@shared/task'
import type { Repository } from '@shared/repository'
import type {
  TerminalSession,
  TerminalSessionStatus,
  TerminalTimelineEntry
} from '@shared/terminal-session'
import type { Worktree } from '@shared/worktree'
import type { PrChangedFile, PrFileContent, PrFileDiff } from '@shared/pr-review'

type Report = { name: string; error?: string; metrics?: Record<string, unknown> }
declare global {
  interface Window {
    uiRegressions: Promise<Report[]>
  }
}

const delay = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert(performance.now() < deadline, 'UI condition timed out')
    await delay(20)
  }
}
async function stableBounds(element: Element): Promise<DOMRect> {
  const deadline = performance.now() + 5000
  let previous = element.getBoundingClientRect()
  while (performance.now() < deadline) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const current = element.getBoundingClientRect()
    if (
      Math.abs(current.top - previous.top) < 0.25 &&
      Math.abs(current.right - previous.right) < 0.25 &&
      Math.abs(current.bottom - previous.bottom) < 0.25 &&
      Math.abs(current.left - previous.left) < 0.25
    ) {
      return current
    }
    previous = current
  }
  throw new Error('Popup bounds did not stabilize')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function mount(element: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  root.render(element)
  return {
    root,
    container,
    dispose: () => {
      root.unmount()
      container.remove()
    }
  }
}
function mockApi(api: unknown): void {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

async function popupLifecycles(): Promise<void> {
  const pointerEvents = (): string => document.body.style.pointerEvents
  let controls!: {
    menu: (open: boolean) => void
    dialog: (open: boolean) => void
    select: (open: boolean) => void
  }
  function Popups() {
    const [menu, setMenu] = React.useState(false)
    const [dialog, setDialog] = React.useState(false)
    const [select, setSelect] = React.useState(false)
    React.useLayoutEffect(() => {
      controls = { menu: setMenu, dialog: setDialog, select: setSelect }
    }, [])
    return (
      <>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger>Repository actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem id="open-dialog" onSelect={() => setDialog(true)}>
              Create worktree
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={dialog} onOpenChange={setDialog}>
          <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
            <DialogTitle>Create worktree</DialogTitle>
            <DialogDescription>Popup lifecycle regression</DialogDescription>
            <input aria-label="Worktree name" />
            <Select open={select} onOpenChange={setSelect}>
              <SelectTrigger>
                <SelectValue placeholder="Run in" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 40 }, (_, index) => (
                  <SelectItem key={index} value={`worktree-${index}`}>
                    Worktree {index + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DialogContent>
        </Dialog>
      </>
    )
  }
  const fixture = mount(<Popups />)
  try {
    await until(() => Boolean(controls))
    for (let iteration = 0; iteration < 3; iteration++) {
      controls.menu(true)
      await until(() => Boolean(document.getElementById('open-dialog')))
      document.getElementById('open-dialog')!.click()
      await until(
        () =>
          !document.querySelector('[role="menu"]') &&
          Boolean(document.querySelector('[role="dialog"]'))
      )
      assert(pointerEvents() === 'none', 'Dialog lost its outside-click lock')
      controls.dialog(false)
      await until(() => !document.querySelector('[role="dialog"]'))
      assert(pointerEvents() === '', 'Menu-to-dialog handoff leaked the input lock')
      controls.dialog(true)
      await until(() => Boolean(document.querySelector('[role="dialog"]')))
      controls.select(true)
      await until(() => Boolean(document.querySelector('[role="listbox"]')))
      const dialogElement = document.querySelector('[role="dialog"]')
      const selectContent = document.querySelector('[data-slot="select-content"]')
      assert(dialogElement && selectContent, 'Select popup did not render')
      assert(!dialogElement.contains(selectContent), 'Select popup remained inside dialog overflow')
      const selectBounds = selectContent.getBoundingClientRect()
      assert(selectBounds.top >= 8, 'Select popup exceeded the top viewport boundary')
      assert(
        selectBounds.bottom <= window.innerHeight - 8,
        'Select popup exceeded the bottom viewport boundary'
      )
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await until(() => !document.querySelector('[role="listbox"]'))
      assert(document.querySelector('[role="dialog"]'), 'Select Escape dismissed its parent dialog')
      controls.dialog(false)
      await until(() => !document.querySelector('[role="dialog"]'))
      assert(pointerEvents() === '', 'Select Escape leaked the input lock')
    }
    controls.menu(true)
    await until(() => Boolean(document.querySelector('[role="menu"]')))
  } finally {
    fixture.dispose()
  }
  await delay(50)
  assert(pointerEvents() === '', 'Navigation with an open menu leaked the input lock')
}

async function globalNewTaskShortcut(): Promise<void> {
  const repository: Repository = {
    id: 'repo',
    path: 'C:\\repo',
    name: 'Repo',
    addedAt: 0,
    remoteKind: 'github'
  }
  let openCount = 0
  mockApi({
    tasks: {
      discardAttachmentStage: () => Promise.resolve()
    }
  })

  function Harness(): React.JSX.Element {
    const [open, setOpen] = React.useState(false)
    return (
      <>
        <span data-current-view="dashboard">Dashboard</span>
        <GlobalTaskShortcut
          onNewTask={() => {
            openCount += 1
            setOpen(true)
          }}
        />
        <TaskDetailDialog
          open={open}
          onOpenChange={setOpen}
          task={null}
          repositories={[repository]}
          worktreesByRepositoryId={{ [repository.id]: [] }}
          onCreate={() => Promise.resolve(true)}
          onUpdate={() => Promise.resolve(true)}
          onDelete={() => Promise.resolve()}
        />
      </>
    )
  }

  const fixture = mount(<Harness />)
  try {
    await delay()
    const modifiedAccepted = window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'N',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    assert(modifiedAccepted, 'Ctrl+Shift+N was incorrectly intercepted')
    assert(!document.querySelector('[role="dialog"]'), 'Modified shortcut opened the task dialog')

    const shortcutAccepted = window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    assert(!shortcutAccepted, 'Ctrl+N did not prevent the WebView default')
    await until(() => Boolean(document.querySelector('[role="dialog"]')))
    await until(() => document.activeElement?.id === 'task-title')
    assert(
      fixture.container.querySelector('[data-current-view="dashboard"]'),
      'Opening a task changed the current view'
    )

    const title = document.querySelector<HTMLInputElement>('#task-title')
    assert(title, 'Task title did not render')
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await delay()
    assert(openCount === 1, 'Ctrl+N replaced an already-open task draft')
    assert(document.querySelector<HTMLInputElement>('#task-title') === title, 'Task form remounted')
  } finally {
    fixture.dispose()
  }
}

async function taskSaveShortcut(): Promise<void> {
  const repository: Repository = {
    id: 'repo',
    path: 'C:\\repo',
    name: 'Repo',
    addedAt: 0,
    remoteKind: 'github'
  }
  mockApi({
    tasks: {
      discardAttachmentStage: () => Promise.resolve()
    }
  })

  let invalidCreateCalls = 0
  const invalidFixture = mount(
    <TaskDetailDialog
      open
      onOpenChange={() => undefined}
      task={null}
      repositories={[repository]}
      worktreesByRepositoryId={{ [repository.id]: [] }}
      onCreate={() => {
        invalidCreateCalls += 1
        return Promise.resolve(true)
      }}
      onUpdate={() => Promise.resolve(true)}
      onDelete={() => Promise.resolve()}
    />
  )
  try {
    await until(() => Boolean(document.querySelector('[role="dialog"]')))
    const shortcutAccepted = window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    assert(!shortcutAccepted, 'Ctrl+S did not prevent the WebView default')
    await until(() => document.body.textContent?.includes('Title is required.') === true)
    assert(invalidCreateCalls === 0, 'Ctrl+S bypassed task validation')
    assert(document.querySelector('[role="dialog"]'), 'Invalid Ctrl+S closed the task dialog')
  } finally {
    invalidFixture.dispose()
  }

  let createCalls = 0
  let createSucceeds = false
  function CreateHarness(): React.JSX.Element {
    const [open, setOpen] = React.useState(true)
    return (
      <TaskDetailDialog
        open={open}
        onOpenChange={setOpen}
        task={null}
        initialDraft={{
          id: 'draft',
          title: 'Draft task',
          description: 'Draft description',
          repositoryName: repository.name
        }}
        repositories={[repository]}
        worktreesByRepositoryId={{ [repository.id]: [] }}
        onCreate={() => {
          createCalls += 1
          return Promise.resolve(createSucceeds)
        }}
        onUpdate={() => Promise.resolve(true)}
        onDelete={() => Promise.resolve()}
      />
    )
  }
  const createFixture = mount(<CreateHarness />)
  try {
    await until(() => Boolean(document.querySelector('[role="dialog"]')))
    const modifiedAccepted = window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    assert(modifiedAccepted, 'Ctrl+Shift+S was incorrectly intercepted')
    assert(createCalls === 0, 'Modified save shortcut created a task')

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await until(() => createCalls === 1)
    assert(document.querySelector('[role="dialog"]'), 'Failed Ctrl+S create closed the task dialog')

    createSucceeds = true
    await delay(20)
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'S',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await until(() => !document.querySelector('[role="dialog"]'))
    assert(Number(createCalls) === 2, 'Successful Ctrl+S did not create the task exactly once')
  } finally {
    createFixture.dispose()
  }

  const update = deferred<boolean>()
  let updateCalls = 0
  function UpdateHarness(): React.JSX.Element {
    const [open, setOpen] = React.useState(true)
    return (
      <TaskDetailDialog
        open={open}
        onOpenChange={setOpen}
        task={task}
        repositories={[repository]}
        worktreesByRepositoryId={{ [repository.id]: [] }}
        onCreate={() => Promise.resolve(true)}
        onUpdate={() => {
          updateCalls += 1
          return update.promise
        }}
        onDelete={() => Promise.resolve()}
      />
    )
  }
  const updateFixture = mount(<UpdateHarness />)
  try {
    await until(() => Boolean(document.querySelector('[role="dialog"]')))
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await until(() => updateCalls === 1)
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true
      })
    )
    await delay(20)
    assert(updateCalls === 1, 'Ctrl+S submitted again while a task save was in progress')
    update.resolve(true)
    await until(() => !document.querySelector('[role="dialog"]'))
  } finally {
    update.resolve(true)
    updateFixture.dispose()
  }
}

async function taskMainBranchDefault(): Promise<void> {
  const repositories: Repository[] = [
    {
      id: 'repo-a',
      path: 'C:\\repo-a',
      name: 'Repo A',
      addedAt: 0,
      remoteKind: 'github'
    },
    {
      id: 'repo-b',
      path: 'C:\\repo-b',
      name: 'Repo B',
      addedAt: 1,
      remoteKind: 'github'
    }
  ]
  mockApi({
    tasks: {
      discardAttachmentStage: () => Promise.resolve()
    }
  })

  const renderDialog = (availableRepositories: Repository[]): React.JSX.Element => (
    <TaskDetailDialog
      open
      onOpenChange={() => undefined}
      task={null}
      repositories={availableRepositories}
      worktreesByRepositoryId={{}}
      onCreate={() => Promise.resolve(true)}
      onUpdate={() => Promise.resolve(true)}
      onDelete={() => Promise.resolve()}
    />
  )

  const fixture = mount(renderDialog([]))
  try {
    fixture.root.render(renderDialog(repositories))
    const repositoryTriggerSelector = '[aria-labelledby="task-repository-label"]'
    const worktreeTriggerSelector = '[aria-labelledby="task-worktree-label"]'
    await until(
      () =>
        document.querySelector(repositoryTriggerSelector)?.textContent?.includes('Repo A') === true
    )
    await until(
      () =>
        document.querySelector(worktreeTriggerSelector)?.textContent?.includes('Main branch') ===
        true
    )

    const repositoryTrigger = document.querySelector<HTMLElement>(repositoryTriggerSelector)
    assert(repositoryTrigger, 'Repository select trigger did not render')
    repositoryTrigger.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await until(() => Boolean(document.querySelector('[role="listbox"]')))
    const repoBOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent?.includes('Repo B')
    )
    assert(repoBOption, 'Second repository option did not render')
    repoBOption.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse'
      })
    )
    repoBOption.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await until(() => repositoryTrigger.textContent?.includes('Repo B') === true)
    assert(
      document.querySelector(worktreeTriggerSelector)?.textContent?.includes('Main branch'),
      'Changing repositories did not keep Main branch selected'
    )
  } finally {
    fixture.dispose()
  }
}

async function worktreeDropdownPlacement(): Promise<Record<string, unknown>> {
  const repository: Repository = {
    id: 'repo',
    path: 'C:\\repo',
    name: 'Repo',
    addedAt: 0,
    remoteKind: 'github'
  }
  const worktrees: Worktree[] = Array.from({ length: 40 }, (_, index) => ({
    path: `C:\\repo.worktrees\\worktree-${index + 1}`,
    branch: `feature/worktree-${index + 1}`,
    head: `${index + 1}`.padStart(40, '0'),
    isDetached: false,
    isMain: false,
    isLocked: false
  }))
  const fixture = mount(
    <TaskDetailDialog
      open
      onOpenChange={() => undefined}
      task={null}
      repositories={[repository]}
      worktreesByRepositoryId={{ [repository.id]: worktrees }}
      onCreate={() => Promise.resolve(true)}
      onUpdate={() => Promise.resolve(true)}
      onDelete={() => Promise.resolve()}
    />
  )
  try {
    const triggerSelector = '[aria-labelledby="task-worktree-label"]'
    await until(() => Boolean(document.querySelector(triggerSelector)))
    const trigger = document.querySelector<HTMLElement>(triggerSelector)
    const repositoryTrigger = document.querySelector<HTMLElement>(
      '[aria-labelledby="task-repository-label"]'
    )
    const titleLabel = document.querySelector<HTMLElement>('label[for="task-title"]')
    const dialogDescription = document.querySelector<HTMLElement>(
      '[data-slot="dialog-description"]'
    )
    const description = document.querySelector<HTMLTextAreaElement>('#task-description')
    const dialogElement = document.querySelector<HTMLElement>('[role="dialog"]')
    assert(
      trigger &&
        repositoryTrigger &&
        titleLabel &&
        dialogDescription &&
        description &&
        dialogElement,
      'Task dialog layout controls did not render'
    )
    const triggerBounds = trigger.getBoundingClientRect()
    const repositoryBounds = repositoryTrigger.getBoundingClientRect()
    const titleLabelBounds = titleLabel.getBoundingClientRect()
    const dialogDescriptionBounds = dialogDescription.getBoundingClientRect()
    const descriptionBounds = description.getBoundingClientRect()
    const viewportProbe = document.createElement('div')
    viewportProbe.style.cssText = 'position:fixed;width:60vw;visibility:hidden'
    document.body.append(viewportProbe)
    const expectedDialogWidth = viewportProbe.clientWidth
    viewportProbe.remove()
    assert(
      Math.abs(dialogElement.clientWidth - expectedDialogWidth) <= 2,
      `Task dialog width did not match 60vw (${dialogElement.clientWidth}px vs ${expectedDialogWidth}px)`
    )
    assert(
      Math.abs(repositoryBounds.top - triggerBounds.top) <= 1,
      'Repository and worktree controls did not share a row in the wide dialog'
    )
    assert(
      titleLabelBounds.top - dialogDescriptionBounds.bottom <= 12,
      'Task dialog left too much space between its subtitle and Title field'
    )
    assert(
      descriptionBounds.height >= 100,
      `Task description did not expand into the available dialog height (${descriptionBounds.height}px)`
    )
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await until(() => Boolean(document.querySelector('[role="listbox"]')))
    const selectContent = document.querySelector<HTMLElement>('[data-slot="select-content"]')
    const selectViewport = selectContent?.querySelector<HTMLElement>('[data-radix-select-viewport]')
    const positionedContent = selectContent?.parentElement
    assert(
      dialogElement && selectContent && selectViewport && positionedContent,
      'Worktree select popup did not render'
    )
    assert(
      !dialogElement.contains(selectContent),
      'Worktree select popup remained inside dialog overflow'
    )
    const selectBounds = await stableBounds(positionedContent)
    assert(
      selectBounds.bottom <= triggerBounds.top || selectBounds.top >= triggerBounds.bottom,
      'Worktree select popup overlapped its trigger'
    )
    assert(selectBounds.top >= 8, 'Worktree select popup exceeded the top viewport boundary')
    assert(
      selectBounds.bottom <= window.innerHeight - 8,
      'Worktree select popup exceeded the bottom viewport boundary'
    )
    assert(
      selectViewport.scrollHeight > selectViewport.clientHeight,
      'Long worktree list did not scroll within the viewport'
    )
    return {
      side: selectContent.dataset.side,
      dialogWidth: dialogElement.clientWidth,
      expectedDialogWidth: Math.round(expectedDialogWidth),
      triggerTop: Math.round(triggerBounds.top),
      triggerBottom: Math.round(triggerBounds.bottom),
      descriptionHeight: Math.round(descriptionBounds.height),
      popupTop: Math.round(selectBounds.top),
      popupBottom: Math.round(selectBounds.bottom),
      popupClientHeight: selectViewport.clientHeight,
      popupScrollHeight: selectViewport.scrollHeight
    }
  } finally {
    fixture.dispose()
  }
}

async function editableBranchName(): Promise<void> {
  mockApi({
    repo: {
      userAlias: async () => 'developer'
    }
  })
  const repository: Repository = {
    id: 'repo',
    path: 'C:\\repo',
    name: 'Repo',
    addedAt: 0,
    remoteKind: 'other'
  }
  const worktree: Worktree = {
    path: 'C:\\repo\\Fix branch modal',
    branch: null,
    head: 'abc123',
    isDetached: true,
    isMain: false,
    isLocked: false
  }
  let submitted: string | null = null
  const fixture = mount(
    <ThemeProvider>
      <CreateBranchDialog
        repository={repository}
        worktree={worktree}
        open
        onOpenChange={() => undefined}
        onSubmit={(branchName) => {
          submitted = branchName
        }}
      />
    </ThemeProvider>
  )
  try {
    const input = await (async (): Promise<HTMLInputElement> => {
      await until(() => Boolean(document.querySelector<HTMLInputElement>('#branch-name')?.value))
      return document.querySelector<HTMLInputElement>('#branch-name')!
    })()
    assert(
      input.value === 'users/developer/Fix-branch-modal',
      `Generated branch name was not fully editable: ${input.value}`
    )
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    assert(valueSetter, 'Browser did not expose the input value setter')

    valueSetter.call(input, 'feature..broken')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() =>
      Boolean(document.body.textContent?.includes('cannot contain two consecutive dots'))
    )
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Create branch'
    )
    assert(submit?.disabled, 'Invalid full branch name did not disable submission')

    valueSetter.call(input, ' release/editable-branch ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => Boolean(submit && !submit.disabled))
    submit.click()
    await until(() => submitted !== null)
    assert(
      submitted === 'release/editable-branch',
      `Full replacement branch name was not submitted: ${submitted}`
    )
  } finally {
    fixture.dispose()
  }
}

async function repositoryIsolation(): Promise<void> {
  const stalled = deferred<{ ok: true }>()
  const fetches: string[] = []
  mockApi({
    repo: {
      defaultBranch: async () => 'main',
      currentBranch: async () => 'main',
      fetch: (path: string) => {
        fetches.push(path)
        return path === 'C:\\A' ? stalled.promise : Promise.resolve({ ok: true })
      },
      status: async (path: string) => ({
        ahead: path === 'C:\\B' ? 2 : 1,
        behind: 0,
        hasRemote: true
      })
    }
  })
  let select!: (path: string) => void
  let repo!: ReturnType<typeof useRepoStatus>
  function Repository() {
    const [path, setPath] = React.useState('C:\\A')
    const value = useRepoStatus(path, true)
    React.useLayoutEffect(() => {
      select = setPath
      repo = value
    }, [value])
    return null
  }
  const fixture = mount(
    <TasksProvider>
      <Repository />
    </TasksProvider>
  )
  try {
    await until(() => fetches.length === 1)
    select('C:\\B')
    await until(() => repo.status?.ahead === 2 && !repo.isFetching)
    assert(fetches.join(',') === 'C:\\A,C:\\B', 'A blocked repository B')
    stalled.resolve({ ok: true })
    await delay(50)
    assert(repo.status?.ahead === 2, 'A late response overwrote B')
    select('C:\\A')
    await until(() => repo.status?.ahead === 1 && !repo.isFetching)
    assert(fetches.length === 3, 'Returning to A did not refresh it')
  } finally {
    stalled.resolve({ ok: true })
    fixture.dispose()
  }
}

const task: Task = {
  id: 'a',
  title: 'Task A',
  description: '',
  intent: 'task',
  status: 'todo',
  repositoryId: 'repo',
  repositoryName: 'Repo',
  repositoryPath: 'C:\\repo',
  worktreePath: 'C:\\repo',
  worktreeBranch: 'main',
  pendingWorktreeName: null,
  copilotSessionId: null,
  queueStatus: 'queued',
  queueOrder: 0,
  sortOrder: 0,
  executionTargetKey: 'repo',
  attachments: [],
  createdAt: 0,
  updatedAt: 0
}

const taskSession: TerminalSession = {
  id: 'task-session',
  taskId: task.id,
  folderPath: task.worktreePath,
  label: task.title,
  repository: task.repositoryName,
  branch: task.worktreeBranch,
  status: 'working',
  lastActivity: 'Implementing task',
  createdAt: 0,
  updatedAt: 0,
  transport: 'acp',
  permissionProfile: 'default',
  generation: 'one',
  revision: 1
}

async function taskCardSessionRouting(): Promise<void> {
  const calls: string[] = []
  const noop = (): void => {}
  const fixture = mount(
    <DndContext>
      <TaskCard
        task={{ ...task, status: 'in_progress' }}
        session={taskSession}
        onOpen={() => calls.push('task')}
        onOpenSession={() => calls.push('session')}
        onStart={noop}
        onReview={() => calls.push('review')}
        onDone={noop}
        onDelete={noop}
        isStarting={false}
        canReview
      />
    </DndContext>
  )
  try {
    await until(() => Boolean(fixture.container.firstElementChild))
    const card = fixture.container.firstElementChild as HTMLElement
    card.click()
    assert(calls.join(',') === 'session', 'In-progress card did not open its session')
    assert(
      !Array.from(card.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Session'
      ),
      'In-progress card retained its redundant Session button'
    )
    const review = Array.from(card.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Review'
    )
    assert(review, 'In-progress card did not render Review')
    review.click()
    assert(calls.join(',') === 'session,review', 'Review click propagated to the card action')

    flushSync(() =>
      fixture.root.render(
        <DndContext>
          <TaskCard
            task={{ ...task, status: 'in_progress' }}
            session={undefined}
            onOpen={() => calls.push('task')}
            onOpenSession={() => calls.push('session')}
            onStart={noop}
            onReview={noop}
            onDone={noop}
            onDelete={noop}
            isStarting={false}
            canReview={false}
          />
        </DndContext>
      )
    )
    ;(fixture.container.firstElementChild as HTMLElement).click()
    assert(
      calls.join(',') === 'session,review,task',
      'Sessionless in-progress card did not fall back to task details'
    )
  } finally {
    fixture.dispose()
  }
}

async function taskColumnContentHeight(): Promise<Record<string, unknown>> {
  const noop = (): void => {}
  const tasks = Array.from(
    { length: 12 },
    (_, index): Task => ({
      ...task,
      id: `overflow-task-${index}`,
      title: `Overflow task ${index + 1}`,
      status: 'todo'
    })
  )
  const fixture = mount(
    <div className="flex h-80 min-h-0 flex-col overflow-auto p-4">
      <DndContext>
        <TasksBoardLayout>
          <TaskColumn
            status="todo"
            label="To do"
            tasks={tasks}
            sessionByTaskId={{}}
            onOpenTask={noop}
            onOpenSession={noop}
            onStartTask={noop}
            onReviewTask={noop}
            onDoneTask={noop}
            onDeleteTask={noop}
            startingTaskIds={new Set()}
            canReviewTask={() => false}
          />
          <TaskColumn
            status="in_progress"
            label="In progress"
            tasks={[]}
            sessionByTaskId={{}}
            onOpenTask={noop}
            onOpenSession={noop}
            onStartTask={noop}
            onReviewTask={noop}
            onDoneTask={noop}
            onDeleteTask={noop}
            startingTaskIds={new Set()}
            canReviewTask={() => false}
          />
        </TasksBoardLayout>
      </DndContext>
    </div>
  )
  try {
    await until(() => fixture.container.querySelectorAll('[role="button"]').length === tasks.length)
    const viewport = fixture.container.firstElementChild as HTMLElement
    const board = viewport.firstElementChild as HTMLElement
    const populatedColumn = board.children[0] as HTMLElement
    const emptyColumn = board.children[1] as HTMLElement
    const populatedDropzone = populatedColumn.lastElementChild as HTMLElement
    const emptyDropzone = emptyColumn.lastElementChild as HTMLElement
    const finalCard = populatedDropzone.querySelector('[role="button"]:last-of-type')
    assert(finalCard, 'Overflowing task column did not render its final card')
    const finalCardBounds = finalCard.getBoundingClientRect()
    const populatedBounds = populatedDropzone.getBoundingClientRect()
    const emptyBounds = emptyDropzone.getBoundingClientRect()
    assert(
      viewport.scrollHeight > viewport.clientHeight,
      'Overflowing task board did not make its page viewport scrollable'
    )
    assert(
      populatedBounds.bottom >= finalCardBounds.bottom,
      'Task cards extended beyond the populated column background'
    )
    assert(
      Math.abs(populatedBounds.bottom - emptyBounds.bottom) <= 1,
      'Task column backgrounds did not stretch to the same board height'
    )
    return {
      viewportHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      columnBottom: Math.round(populatedBounds.bottom),
      finalCardBottom: Math.round(finalCardBounds.bottom)
    }
  } finally {
    fixture.dispose()
  }
}

async function taskColumnSessionOrdering(): Promise<void> {
  const noop = (): void => {}
  const statuses: Array<[string, TerminalSessionStatus | undefined]> = [
    ['Ended first', 'done'],
    ['Working first', 'working'],
    ['Idle', 'idle'],
    ['Needs input', 'waiting-input'],
    ['Starting', 'starting'],
    ['Working second', 'working'],
    ['No session', undefined],
    ['Failed', 'error']
  ]
  const tasks = statuses.map(
    ([title], index): Task => ({
      ...task,
      id: `status-task-${index}`,
      title,
      status: 'in_progress',
      sortOrder: index
    })
  )
  const sessionByTaskId = Object.fromEntries(
    statuses.flatMap(([, status], index) =>
      status
        ? [
            [
              `status-task-${index}`,
              {
                ...taskSession,
                id: `status-session-${index}`,
                taskId: `status-task-${index}`,
                status
              }
            ]
          ]
        : []
    )
  ) as Record<string, TerminalSession>
  const fixture = mount(
    <DndContext>
      <TaskColumn
        status="in_progress"
        label="In progress"
        tasks={tasks}
        sessionByTaskId={sessionByTaskId}
        onOpenTask={noop}
        onOpenSession={noop}
        onStartTask={noop}
        onReviewTask={noop}
        onDoneTask={noop}
        onDeleteTask={noop}
        startingTaskIds={new Set()}
        canReviewTask={() => false}
      />
    </DndContext>
  )
  try {
    await until(() => fixture.container.querySelectorAll('[role="button"]').length === tasks.length)
    const titles = Array.from(fixture.container.querySelectorAll<HTMLElement>('[role="button"]'))
      .map((card) => card.querySelector('p')?.textContent?.trim())
      .filter((title): title is string => Boolean(title))
    assert(
      titles.join(',') ===
        [
          'Working first',
          'Needs input',
          'Starting',
          'Working second',
          'Idle',
          'Ended first',
          'No session',
          'Failed'
        ].join(','),
      `In-progress cards were not grouped by session status: ${titles.join(', ')}`
    )
  } finally {
    fixture.dispose()
  }
}

async function taskSessionTransportRouting(): Promise<void> {
  const selected: string[] = []
  let navigations = 0
  const focused: string[] = []
  const actions = {
    select: (id: string): void => {
      selected.push(id)
    },
    navigate: (): void => {
      navigations++
    },
    focusExternal: async (id: string): Promise<void> => {
      focused.push(id)
    }
  }

  for (const transport of ['sdk', 'acp'] as const) {
    openTaskSession({ ...taskSession, id: transport, transport }, actions)
  }
  assert(
    selected.join(',') === 'sdk,acp' && navigations === 2 && focused.length === 0,
    'In-app task sessions did not select and navigate'
  )

  openTaskSession({ ...taskSession, id: 'external', transport: 'external' }, actions)
  assert(
    focused.join(',') === 'external' && selected.length === 2 && navigations === 2,
    'External task session did not focus its terminal exclusively'
  )
}

async function taskMutationRaces(): Promise<void> {
  const move = deferred<{ ok: true; tasks: Task[] }>()
  let moving = false
  let created = false
  let taskUpdate: (() => void) | undefined
  let unsubscribed = false
  let listedTasks = [task]
  let listRequests = 0
  let moveTask: () => Promise<MoveTaskResult> = () => {
    moving = true
    return move.promise
  }
  mockApi({
    tasks: {
      list: async () => {
        listRequests++
        return listedTasks
      },
      onUpdate: async (callback: () => void) => {
        taskUpdate = callback
        return () => {
          unsubscribed = true
        }
      },
      move: () => moveTask(),
      create: async () => {
        created = true
        return { ok: true, task: { ...task, id: 'b' } }
      }
    }
  })
  let board!: ReturnType<typeof useTaskBoard>
  function Board() {
    const value = useTaskBoard()
    React.useLayoutEffect(() => {
      board = value
    }, [value])
    return null
  }
  const fixture = mount(
    <TaskBoardProvider>
      <Board />
    </TaskBoardProvider>
  )
  try {
    await until(() => Boolean(board) && !board.loading)
    const movingTask = board.moveTask('a', 'in_progress')
    await until(() => moving)
    board.setTaskLocal({ ...task, copilotSessionId: 'new-session', queueStatus: 'running' })
    const creatingTask = board.createTask({
      ...task,
      attachmentStageId: crypto.randomUUID(),
      attachments: []
    })
    await delay(20)
    assert(!created, 'Database mutations were not serialized')
    move.resolve({ ok: true, tasks: [{ ...task, status: 'in_progress' }] })
    await Promise.all([movingTask, creatingTask])
    await until(() => board.tasks.length === 2)
    assert(
      board.tasks.find((t) => t.id === 'a')?.copilotSessionId === 'new-session',
      'Old move response overwrote session linkage'
    )
    assert(
      board.tasks.find((t) => t.id === 'a')?.status === 'in_progress',
      'Session linkage discarded the successful move'
    )
    assert(
      board.tasks.some((t) => t.id === 'b'),
      'Concurrent creation disappeared'
    )

    const externalMove = deferred<{ ok: true; tasks: Task[] }>()
    moveTask = () => externalMove.promise
    const localMove = board.moveTask('b', 'review')
    const remoteTask: Task = {
      ...task,
      id: 'remote',
      title: 'Remote task',
      status: 'in_progress',
      copilotSessionId: 'remote-session',
      queueStatus: 'running'
    }
    listedTasks = [
      ...board.tasks.map((item) =>
        item.id === 'b' ? { ...item, status: 'review' as const } : item
      ),
      remoteTask
    ]
    const requestsBeforeUpdate = listRequests
    taskUpdate?.()
    await delay(150)
    assert(
      listRequests === requestsBeforeUpdate,
      'External refresh was not serialized behind a local mutation'
    )
    externalMove.resolve({
      ok: true,
      tasks: board.tasks.map((item) =>
        item.id === 'b' ? { ...item, status: 'review' as const } : item
      )
    })
    await localMove
    await until(() => board.tasks.some((item) => item.id === remoteTask.id))
    assert(
      board.tasks.find((item) => item.id === remoteTask.id)?.copilotSessionId === 'remote-session',
      'External task refresh did not include the started session linkage'
    )
    assert(
      board.tasks.find((item) => item.id === 'b')?.status === 'review',
      'External task refresh clobbered a newer local move'
    )

    const first = deferred<{ ok: false; error: 'unknown'; message: string }>()
    const second = deferred<{ ok: true; tasks: Task[] }>()
    let requests = 0
    moveTask = () => (++requests === 1 ? first.promise : second.promise)
    const before = board.tasks
    const failedMove = board.moveTask('a', 'review')
    const laterMove = board.moveTask('b', 'done')
    await until(() => board.tasks.find((t) => t.id === 'b')?.status === 'done' && requests === 1)
    first.resolve({
      ok: false,
      error: 'unknown',
      message: 'Expected regression-test failure'
    })
    await failedMove
    await until(
      () => requests === 2 && board.tasks.find((t) => t.id === 'a')?.status === 'in_progress'
    )
    assert(
      board.tasks.find((t) => t.id === 'b')?.status === 'done',
      'Failed move rolled back a newer optimistic move'
    )
    second.resolve({
      ok: true,
      tasks: before.map((t) => (t.id === 'b' ? { ...t, status: 'done' } : t))
    })
    await laterMove
  } finally {
    fixture.dispose()
    await delay()
    assert(unsubscribed, 'Task update listener was not removed on provider cleanup')
  }
}

async function nativeEventRecovery(): Promise<void> {
  let receive!: (snapshot: NativeSnapshotUpdate) => void
  let native!: ReturnType<typeof useNativeSessions>
  let refreshes = 0
  const recovery = deferred<NativeSnapshot>()
  mockApi({
    nativeSessions: {
      onUpdate: async (callback: typeof receive) => {
        receive = callback
        return () => {}
      },
      snapshot: () => {
        refreshes++
        return recovery.promise
      }
    },
    terminalSessions: { list: async () => [] }
  })
  const noop = (): void => {}
  const known = {}
  function Native() {
    const value = useNativeSessions(known, noop, noop, noop)
    React.useLayoutEffect(() => {
      native = value
    }, [value])
    return null
  }
  const fixture = mount(<Native />)
  try {
    await until(() => Boolean(receive))
    const full: NativeSnapshot = {
      session: {
        id: 'native',
        generation: 'one',
        revision: 1,
        transport: 'acp',
        label: 'Test',
        folderPath: 'C:\\repo',
        status: 'working',
        lastActivity: '',
        pendingPrompt: null,
        taskId: null,
        repository: null,
        branch: null,
        permissionProfile: 'default',
        createdAt: 0,
        updatedAt: 0
      },
      entries: [{ kind: 'notice', seq: 1, timestamp: null, level: 'info', text: 'old' }],
      interactions: [],
      historyTruncated: false,
      error: null,
      availableModes: [],
      planTransitionAvailable: false
    }
    receive(full)
    await until(() => native.nativeById.native?.session.revision === 1)
    const gap = {
      ...full,
      session: { ...full.session, revision: 3 },
      baseRevision: 2,
      entrySeqs: [1],
      entries: []
    }
    receive(gap)
    receive(gap)
    await until(() => refreshes === 1)
    const latest = { ...full, session: { ...full.session, revision: 3 } }
    recovery.resolve(latest)
    await until(() => native.nativeById.native?.session.revision === 3)
    const previous = native.nativeById.native
    receive(latest)
    await delay(30)
    assert(native.nativeById.native === previous, 'Duplicate event replaced current snapshot')
    assert(refreshes === 1, 'Missing-event recovery issued duplicate commands')
  } finally {
    fixture.dispose()
  }
}

async function transcriptWork(): Promise<Record<string, unknown>> {
  let outputReads = 0
  const entries: TerminalTimelineEntry[] = Array.from({ length: 500 }, (_, seq) => ({
    kind: 'acp',
    seq,
    category: 'tool',
    timestamp: null,
    data: {
      title: `Tool ${seq}`,
      status: 'completed',
      get rawOutput() {
        outputReads++
        return { text: 'x'.repeat(12_000) }
      }
    }
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    const start = performance.now()
    flushSync(() => root.render(<TerminalTimeline entries={entries} />))
    const initialMs = Math.round(performance.now() - start)
    assert(outputReads === 0, 'Collapsed tools eagerly serialized their output')
    assert(container.querySelectorAll('pre').length === 0, 'Collapsed tool payloads were mounted')
    const first = container.querySelector('details')!
    first.open = true
    await until(() => Boolean(first.querySelector('pre')))
    outputReads = 0
    const session: NativeSnapshot = {
      session: {
        id: 'test',
        generation: 'one',
        revision: 1,
        transport: 'acp',
        label: 'Test',
        folderPath: 'C:\\repo',
        status: 'working',
        lastActivity: '',
        pendingPrompt: null,
        taskId: null,
        repository: null,
        branch: null,
        permissionProfile: 'default',
        createdAt: 0,
        updatedAt: 0
      },
      entries,
      interactions: [],
      historyTruncated: false,
      error: null,
      availableModes: [],
      planTransitionAvailable: false
    }
    let current = session
    const durations: number[] = []
    for (let revision = 2; revision < 7; revision++) {
      const next = mergeNativeSnapshot(
        {
          ...current,
          session: { ...current.session, revision },
          baseRevision: current.session.revision,
          entrySeqs: entries.map((entry) => entry.seq),
          entries: [
            { kind: 'notice', seq: 499, timestamp: null, level: 'info', text: `Update ${revision}` }
          ]
        },
        current
      )
      assert(next, 'Valid delta did not reconstruct')
      current = next
      const before = performance.now()
      flushSync(() => root.render(<TerminalTimeline entries={current.entries} />))
      durations.push(Math.round(performance.now() - before))
      await delay(20)
    }
    assert(outputReads === 0, 'Unchanged expanded tool was rerendered by another row update')
    return { initialMs, updateMs: durations, rows: entries.length }
  } finally {
    root.unmount()
    container.remove()
  }
}

async function remoteSessionTimelineCompaction(): Promise<void> {
  const outputReads = { count: 0 }
  const entries: TerminalTimelineEntry[] = [
    {
      kind: 'toolCall',
      seq: 1,
      timestamp: null,
      toolCallId: 'running',
      name: 'Running tool',
      detail: 'still working',
      success: null,
      result: null
    },
    {
      kind: 'acp',
      seq: 2,
      timestamp: null,
      category: 'tool',
      data: {
        title: 'Completed tool',
        status: 'completed',
        get rawOutput() {
          outputReads.count++
          return { text: 'x'.repeat(12_000) }
        }
      }
    },
    {
      kind: 'permission',
      seq: 3,
      timestamp: null,
      description: 'Allow the next operation?',
      resolution: null,
      selectionKind: null
    }
  ]
  const fixture = mount(
    <div className="w-[320px] max-w-full overflow-hidden">
      {entries.map((entry) => (
        <RemoteTimelineEntry
          key={`${entry.kind}-${entry.seq}`}
          entry={entry}
          context={{ sessionFinished: false, hasLiveInteraction: false }}
        />
      ))}
    </div>
  )
  try {
    await until(() => Boolean(fixture.container.querySelector('details')))
    assert(!fixture.container.textContent?.includes('Running tool'), 'Running tool was not omitted')
    assert(
      fixture.container.textContent?.includes('Allow the next operation?'),
      'Pending permission was hidden'
    )
    assert(outputReads.count === 0, 'Collapsed remote tool eagerly serialized its output')
    assert(fixture.container.querySelectorAll('pre').length === 0, 'Collapsed detail was mounted')
    const disclosure = fixture.container.querySelector('details')!
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    await until(() => Boolean(disclosure.querySelector('pre')))
    assert(outputReads.count > 0, 'Expanded remote tool did not read its output')
    const viewport = fixture.container.firstElementChild
    assert(viewport, 'Remote timeline viewport did not render')
    assert(
      viewport.scrollWidth <= viewport.clientWidth,
      'Remote timeline detail caused horizontal page overflow'
    )
  } finally {
    fixture.dispose()
  }
}

async function diffViewerLayouts(): Promise<void> {
  const rows: DiffDisplayRow[] = [
    {
      kind: 'line',
      key: 'context',
      line: { kind: 'context', baseLine: 1, headLine: 1, text: 'same' }
    },
    {
      kind: 'line',
      key: 'delete-1',
      line: { kind: 'del', baseLine: 2, headLine: null, text: 'old one' }
    },
    {
      kind: 'line',
      key: 'delete-2',
      line: { kind: 'del', baseLine: 3, headLine: null, text: 'old two' }
    },
    {
      kind: 'line',
      key: 'add-1',
      line: { kind: 'add', baseLine: null, headLine: 2, text: 'new one' }
    }
  ]
  const aligned = alignSplitRows(rows)
  assert(aligned.length === 3, 'Split alignment produced the wrong row count')
  assert(
    aligned[1].kind === 'line' &&
      aligned[1].left?.text === 'old one' &&
      aligned[1].right?.text === 'new one',
    'Split alignment did not pair a replacement'
  )
  assert(
    aligned[2].kind === 'line' && aligned[2].left?.text === 'old two' && aligned[2].right === null,
    'Split alignment did not pad an unequal replacement'
  )
  const addedOnly = alignSplitRows([
    {
      kind: 'line',
      key: 'add-only',
      line: { kind: 'add', baseLine: null, headLine: 1, text: 'created' }
    }
  ])
  assert(
    addedOnly[0].kind === 'line' &&
      addedOnly[0].left === null &&
      addedOnly[0].right?.text === 'created',
    'Split alignment did not preserve a pure addition'
  )

  const diff: PrFileDiff = {
    path: 'review.txt',
    isBinary: false,
    truncated: false,
    hunks: [
      {
        header: '@@ -1,3 +1,3 @@',
        baseStart: 1,
        baseLines: 3,
        headStart: 1,
        headLines: 3,
        lines: [
          { kind: 'context', baseLine: 1, headLine: 1, text: '# Title' },
          { kind: 'del', baseLine: 2, headLine: null, text: 'old' },
          { kind: 'add', baseLine: null, headLine: 2, text: 'new' },
          { kind: 'context', baseLine: 3, headLine: 3, text: 'end' }
        ]
      }
    ]
  }
  let setLayout!: React.Dispatch<React.SetStateAction<'inline' | 'split'>>
  function Viewer() {
    const [layout, updateLayout] = React.useState<'inline' | 'split'>('inline')
    React.useLayoutEffect(() => {
      setLayout = updateLayout
    }, [])
    return (
      <DiffView
        path={diff.path}
        layout={layout}
        diff={diff}
        error={null}
        isLoading={false}
        headText="# Title\nnew\nend"
      />
    )
  }
  const fixture = mount(
    <ThemeProvider>
      <Viewer />
    </ThemeProvider>
  )
  try {
    await until(() => Boolean(setLayout))
    assert(document.querySelectorAll('th').length === 0, 'Inline mode rendered split headers')
    flushSync(() => setLayout('split'))
    assert(document.querySelector('th'), 'Split mode did not render headers')
    assert(
      Array.from(document.querySelectorAll('th'))
        .map((cell) => cell.textContent)
        .join(',') === 'Old,New',
      'Split mode did not render old and new panes'
    )
    assert(
      document.body.textContent?.includes('old') && document.body.textContent?.includes('new'),
      'Split mode omitted changed code'
    )
    flushSync(() => setLayout('inline'))
    assert(document.querySelectorAll('th').length === 0, 'Inline mode retained split headers')
  } finally {
    fixture.dispose()
  }
}

async function reviewWorkspaceModes(): Promise<void> {
  const files: PrChangedFile[] = [
    {
      path: 'README.md',
      changeType: 'edit',
      additions: 1,
      deletions: 1,
      isBinary: false,
      isMarkdown: true
    },
    {
      path: 'src/app.ts',
      changeType: 'edit',
      additions: 1,
      deletions: 1,
      isBinary: false,
      isMarkdown: false
    },
    {
      path: 'src/components/button.tsx',
      changeType: 'add',
      additions: 3,
      deletions: 0,
      isBinary: false,
      isMarkdown: false
    }
  ]
  const diffs = new Map<string, PrFileDiff>(
    files.map((file) => [
      file.path,
      {
        path: file.path,
        isBinary: false,
        truncated: false,
        hunks: [
          {
            header: '@@ -1,3 +1,3 @@',
            baseStart: 1,
            baseLines: 3,
            headStart: 1,
            headLines: 3,
            lines: [
              { kind: 'context', baseLine: 1, headLine: 1, text: 'title' },
              { kind: 'del', baseLine: 2, headLine: null, text: 'old value' },
              { kind: 'add', baseLine: null, headLine: 2, text: 'new value' },
              { kind: 'context', baseLine: 3, headLine: 3, text: 'end' }
            ]
          }
        ]
      }
    ])
  )
  const contents = new Map<string, PrFileContent>([
    [
      'README.md',
      {
        path: 'README.md',
        side: 'head',
        text: '# title\nnew value\nend',
        isBinary: false,
        truncated: false
      }
    ],
    [
      'src/app.ts',
      {
        path: 'src/app.ts',
        side: 'head',
        text: 'const title = true\rconst value = "new"\rend()',
        isBinary: false,
        truncated: false
      }
    ],
    [
      'src/components/button.tsx',
      {
        path: 'src/components/button.tsx',
        side: 'head',
        text: 'export function Button() {\n  return <button />\n}',
        isBinary: false,
        truncated: false
      }
    ]
  ])
  const contentRequests: string[] = []
  const fileDiffFor = (path: string | null) => ({
    data: path ? (diffs.get(path) ?? null) : null,
    error: null,
    isLoading: false
  })
  const fileContentFor = (path: string | null) => ({
    data: path ? (contents.get(path) ?? null) : null,
    error: null,
    isLoading: false
  })
  const ensureFileDiff = (): void => undefined
  const ensureFileContent = (path: string): void => {
    contentRequests.push(path)
  }
  const fixture = mount(
    <ThemeProvider>
      <ReviewWorkspace
        header={<div>Review changes</div>}
        files={files}
        diffStats={new Map()}
        error={null}
        isLoading={false}
        fileDiffFor={fileDiffFor}
        ensureFileDiff={ensureFileDiff}
        fileContentFor={fileContentFor}
        ensureFileContent={ensureFileContent}
        onClose={() => undefined}
      />
    </ThemeProvider>
  )
  try {
    await until(() => contentRequests.includes('README.md'))
    const button = (label: string): HTMLButtonElement | undefined =>
      Array.from(fixture.container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label
      )
    assert(button('Diff')?.getAttribute('aria-pressed') === 'true', 'Markdown did not open in Diff')
    assert(
      fixture.container.querySelector('[aria-label="Diff layout"]'),
      'Diff layout controls were not shown'
    )
    assert(
      !fixture.container.querySelector('.markdown-preview'),
      'Markdown preview opened by default'
    )

    const changedFilesTree = fixture.container.querySelector(
      '[role="tree"][aria-label="Changed files"]'
    )
    assert(changedFilesTree, 'Changed files did not render as a tree')
    const sourceFolder = fixture.container.querySelector<HTMLButtonElement>(
      'button[role="treeitem"][title="src"]'
    )
    const componentsFolder = fixture.container.querySelector<HTMLButtonElement>(
      'button[role="treeitem"][title="src/components"]'
    )
    assert(sourceFolder?.getAttribute('aria-expanded') === 'true', 'Source folder was not expanded')
    assert(
      componentsFolder?.getAttribute('aria-level') === '2',
      'Nested folder did not render at the expected depth'
    )
    assert(
      fixture.container
        .querySelector('button[title="src/components/button.tsx"]')
        ?.getAttribute('aria-level') === '3',
      'Nested file did not render at the expected depth'
    )

    sourceFolder.click()
    await until(() => !fixture.container.querySelector('button[title="src/app.ts"]'))

    const filter = fixture.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter changed files"]'
    )
    assert(filter, 'Changed-file filter was not rendered')
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    assert(valueSetter, 'Browser did not expose the input value setter')
    valueSetter.call(filter, 'button.tsx')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() =>
      Boolean(fixture.container.querySelector('button[title="src/components/button.tsx"]'))
    )
    assert(
      fixture.container
        .querySelector('button[role="treeitem"][title="src"]')
        ?.getAttribute('aria-expanded') === 'true',
      'Filtering did not reveal the matching file ancestry'
    )

    valueSetter.call(filter, '')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => !fixture.container.querySelector('button[title="src/app.ts"]'))
    fixture.container.querySelector<HTMLButtonElement>('button[title="src"]')?.click()
    await until(() => Boolean(fixture.container.querySelector('button[title="src/app.ts"]')))

    button('Preview')?.click()
    await until(() => Boolean(fixture.container.querySelector('.markdown-preview')))
    assert(
      !fixture.container.querySelector('[aria-label="Diff layout"]'),
      'Preview retained irrelevant diff layout controls'
    )

    const sourceFile = Array.from(fixture.container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('title') === 'src/components/button.tsx'
    )
    assert(sourceFile, 'Nested source file was not listed')
    sourceFile.click()
    await until(() => contentRequests.includes('src/components/button.tsx'))
    assert(
      fixture.container.querySelector('[aria-label="Diff layout"]'),
      'Nested source diff did not expose layout controls'
    )
    assert(
      !fixture.container.querySelector('[aria-label="View mode"]'),
      'Source file exposed Markdown view modes'
    )
  } finally {
    fixture.dispose()
  }
}

window.uiRegressions = (async () => {
  const reports: Report[] = []
  for (const [name, run] of [
    ['popup input lock recovery', popupLifecycles],
    ['global new task shortcut', globalNewTaskShortcut],
    ['task save shortcut', taskSaveShortcut],
    ['task main branch default', taskMainBranchDefault],
    ['worktree dropdown placement', worktreeDropdownPlacement],
    ['editable branch name', editableBranchName],
    ['repository request isolation', repositoryIsolation],
    ['task card session routing', taskCardSessionRouting],
    ['task column content height', taskColumnContentHeight],
    ['task column session ordering', taskColumnSessionOrdering],
    ['task session transport routing', taskSessionTransportRouting],
    ['task mutation ordering', taskMutationRaces],
    ['native event gap recovery', nativeEventRecovery],
    ['bounded transcript rendering', transcriptWork],
    ['remote session timeline compaction', remoteSessionTimelineCompaction],
    ['diff viewer layouts', diffViewerLayouts],
    ['review workspace modes', reviewWorkspaceModes]
  ] as const) {
    try {
      const metrics = await run()
      reports.push({ name, ...(metrics ? { metrics } : {}) })
    } catch (error) {
      reports.push({ name, error: String(error) })
    }
  }
  return reports
})()
