import type { Task, TaskStatus } from '@shared/task'

/** Preserve changes (including deletions) made after an authoritative read began. */
export function reconcileTaskList(
  current: Task[],
  incoming: Task[],
  protectedIds: ReadonlySet<string>,
  complete = true,
  startedWith: Task[] = []
): Task[] {
  const result = new Map(complete ? [] : current.map((task) => [task.id, task] as const))
  const currentById = new Map(current.map((task) => [task.id, task]))
  const baselineById = new Map(startedWith.map((task) => [task.id, task]))
  for (const task of incoming) {
    if (!protectedIds.has(task.id)) result.set(task.id, task)
    else {
      const local = currentById.get(task.id)
      const baseline = baselineById.get(task.id)
      if (local) {
        // A session-link update must not discard a successful move/title edit.
        const changed = baseline
          ? Object.fromEntries(
              Object.entries(local).filter(([key, value]) => value !== baseline[key as keyof Task])
            )
          : local
        result.set(task.id, {
          ...task,
          ...changed,
          updatedAt: Math.max(local.updatedAt, task.updatedAt)
        })
      }
    }
  }
  for (const task of current) {
    if (protectedIds.has(task.id) && !result.has(task.id)) result.set(task.id, task)
  }
  return [...result.values()]
}

export function moveTaskOptimistically(
  tasks: Task[],
  id: string,
  status: TaskStatus,
  beforeId?: string | null
): Task[] {
  const target = tasks.find((task) => task.id === id)
  if (!target) return tasks
  const destination = tasks
    .filter((task) => task.id !== id && task.status === status)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const index = beforeId ? destination.findIndex((task) => task.id === beforeId) : -1
  destination.splice(index < 0 ? destination.length : index, 0, { ...target, status })
  return [
    ...tasks.filter((task) => task.id !== id && task.status !== status),
    ...destination.map((task, sortOrder) => ({ ...task, sortOrder }))
  ]
}
