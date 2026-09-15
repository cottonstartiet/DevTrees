import type { PrDiffLine, PrFileDiff } from '@shared/pr-review'

export type DiffDisplayRow =
  | { kind: 'expand'; key: string; from: number; to: number }
  | { kind: 'line'; key: string; line: PrDiffLine }

export type SplitDiffRow =
  | { kind: 'expand'; key: string; from: number; to: number }
  | {
      kind: 'line'
      key: string
      left: PrDiffLine | null
      right: PrDiffLine | null
    }

export function buildDiffRows(
  diff: PrFileDiff | null,
  headLines: string[] | null,
  expanded: Map<string, number>
): DiffDisplayRow[] {
  if (!diff) return []

  const rows: DiffDisplayRow[] = []
  let previousBaseEnd = 0
  let previousHeadEnd = 0

  diff.hunks.forEach((hunk, hunkIndex) => {
    const gapEnd = hunk.headStart - 1
    if (headLines && gapEnd > previousHeadEnd) {
      const key = `gap-${hunkIndex}`
      const revealed = expanded.get(key) ?? 0
      const from = Math.max(previousHeadEnd + 1, gapEnd - revealed + 1)
      if (from > previousHeadEnd + 1) {
        rows.push({ kind: 'expand', key, from: previousHeadEnd + 1, to: gapEnd })
      }
      for (let line = from; line <= gapEnd; line++) {
        rows.push({
          kind: 'line',
          key: `ctx-${line}`,
          line: {
            kind: 'context',
            baseLine: previousBaseEnd + (line - previousHeadEnd),
            headLine: line,
            text: headLines[line - 1] ?? ''
          }
        })
      }
    } else if (!headLines) {
      rows.push({ kind: 'expand', key: `header-${hunkIndex}`, from: 0, to: 0 })
    }

    hunk.lines.forEach((line, lineIndex) => {
      rows.push({ kind: 'line', key: `h${hunkIndex}-${lineIndex}`, line })
    })
    previousBaseEnd = Math.max(previousBaseEnd, hunk.baseStart + hunk.baseLines - 1)
    previousHeadEnd = Math.max(previousHeadEnd, hunk.headStart + hunk.headLines - 1)
  })

  return rows
}

export function alignSplitRows(rows: DiffDisplayRow[]): SplitDiffRow[] {
  const split: SplitDiffRow[] = []
  let index = 0

  while (index < rows.length) {
    const row = rows[index]
    if (row.kind === 'expand') {
      split.push(row)
      index += 1
      continue
    }

    if (row.line.kind === 'context') {
      split.push({
        kind: 'line',
        key: row.key,
        left: row.line,
        right: row.line
      })
      index += 1
      continue
    }

    const deleted: Extract<DiffDisplayRow, { kind: 'line' }>[] = []
    const added: Extract<DiffDisplayRow, { kind: 'line' }>[] = []
    while (index < rows.length) {
      const change = rows[index]
      if (change.kind !== 'line' || change.line.kind === 'context') break
      if (change.line.kind === 'del') deleted.push(change)
      else added.push(change)
      index += 1
    }

    const count = Math.max(deleted.length, added.length)
    for (let pairIndex = 0; pairIndex < count; pairIndex++) {
      const left = deleted[pairIndex] ?? null
      const right = added[pairIndex] ?? null
      split.push({
        kind: 'line',
        key: `split-${left?.key ?? 'blank'}-${right?.key ?? 'blank'}`,
        left: left?.line ?? null,
        right: right?.line ?? null
      })
    }
  }

  return split
}
