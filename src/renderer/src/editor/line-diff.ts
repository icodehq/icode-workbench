export type LineChange = {
  /** 1-based first line on the original side; 0 when the change only adds. */
  oldStart: number
  /** Number of original lines in the block; 0 for a pure addition. */
  oldCount: number
  /** 1-based first line on the modified side; 0 when the change only deletes. */
  newStart: number
  /** Number of modified lines in the block; 0 for a pure deletion. */
  newCount: number
  /** 1-based modified-side line to mark for a deletion; 1 otherwise. */
  newAnchor: number
}

/** DP cells above which the middle section is reported as one changed block. */
const MAX_DP_CELLS = 4_000_000

/**
 * Line-level diff for quick-diff decorations.
 *
 * Common prefix/suffix lines are trimmed first, so ordinary edits stay small;
 * only the middle is run through LCS. If that middle is pathologically large,
 * the whole middle is reported changed instead of allocating an unbounded table.
 */
export function lineDiff(originalText: string, modifiedText: string): LineChange[] {
  const original = originalText.split('\n')
  const modified = modifiedText.split('\n')

  let prefix = 0
  while (
    prefix < original.length &&
    prefix < modified.length &&
    original[prefix] === modified[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < original.length - prefix &&
    suffix < modified.length - prefix &&
    original[original.length - 1 - suffix] === modified[modified.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMiddle = original.slice(prefix, original.length - suffix)
  const newMiddle = modified.slice(prefix, modified.length - suffix)
  if (oldMiddle.length === 0 && newMiddle.length === 0) return []
  if (oldMiddle.length === 0) {
    return [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: prefix + 1,
        newCount: newMiddle.length,
        newAnchor: prefix + 1
      }
    ]
  }
  if (newMiddle.length === 0) {
    return [
      {
        oldStart: prefix + 1,
        oldCount: oldMiddle.length,
        newStart: 0,
        newCount: 0,
        newAnchor: Math.max(1, prefix + 1)
      }
    ]
  }

  if (oldMiddle.length * newMiddle.length > MAX_DP_CELLS) {
    return [
      {
        oldStart: prefix + 1,
        oldCount: oldMiddle.length,
        newStart: prefix + 1,
        newCount: newMiddle.length,
        newAnchor: prefix + 1
      }
    ]
  }

  // directions[i][j]: 0 = match, 1 = delete from old, 2 = insert from new.
  const width = newMiddle.length + 1
  const directions = new Uint8Array((oldMiddle.length + 1) * width)
  const lengths = new Uint32Array((oldMiddle.length + 1) * width)
  for (let i = 1; i <= oldMiddle.length; i += 1) {
    for (let j = 1; j <= newMiddle.length; j += 1) {
      const index = i * width + j
      if (oldMiddle[i - 1] === newMiddle[j - 1]) {
        lengths[index] = (lengths[(i - 1) * width + (j - 1)] ?? 0) + 1
        directions[index] = 0
      } else if ((lengths[(i - 1) * width + j] ?? 0) >= (lengths[i * width + (j - 1)] ?? 0)) {
        lengths[index] = lengths[(i - 1) * width + j] ?? 0
        directions[index] = 1
      } else {
        lengths[index] = lengths[i * width + (j - 1)] ?? 0
        directions[index] = 2
      }
    }
  }

  type Op = { kind: 'match' | 'delete' | 'insert'; oldIndex: number; newIndex: number }
  const ops: Op[] = []
  let i = oldMiddle.length
  let j = newMiddle.length
  while (i > 0 || j > 0) {
    const direction = i > 0 && j > 0 ? directions[i * width + j] : i > 0 ? 1 : 2
    if (direction === 0) {
      ops.push({ kind: 'match', oldIndex: i - 1, newIndex: j - 1 })
      i -= 1
      j -= 1
    } else if (direction === 1) {
      ops.push({ kind: 'delete', oldIndex: i - 1, newIndex: j })
      i -= 1
    } else {
      ops.push({ kind: 'insert', oldIndex: i, newIndex: j - 1 })
      j -= 1
    }
  }
  ops.reverse()

  const changes: LineChange[] = []
  let block: {
    oldIndexes: number[]
    newIndexes: number[]
    /** New-side insertion point where the first deletion occurred (0-based). */
    newAnchorIndex: number
  } | null = null
  const flush = (): void => {
    if (block === null || (block.oldIndexes.length === 0 && block.newIndexes.length === 0)) return
    const firstOld = block.oldIndexes[0]
    const firstNew = block.newIndexes[0]
    changes.push({
      oldStart: firstOld === undefined ? 0 : prefix + firstOld + 1,
      oldCount: block.oldIndexes.length,
      newStart: firstNew === undefined ? 0 : prefix + firstNew + 1,
      newCount: block.newIndexes.length,
      newAnchor:
        firstNew === undefined
          ? Math.max(1, prefix + block.newAnchorIndex)
          : prefix + firstNew + 1
    })
    block = null
  }
  for (const op of ops) {
    if (op.kind === 'match') {
      flush()
      continue
    }
    block ??= { oldIndexes: [], newIndexes: [], newAnchorIndex: op.newIndex }
    if (op.kind === 'delete') block.oldIndexes.push(op.oldIndex)
    else block.newIndexes.push(op.newIndex)
  }
  flush()
  return changes
}

export type QuickDiffCounts = { additions: number; deletions: number }

export function quickDiffCounts(changes: readonly LineChange[]): QuickDiffCounts {
  let additions = 0
  let deletions = 0
  for (const change of changes) {
    additions += change.newCount
    deletions += change.oldCount
  }
  return { additions, deletions }
}
