import type { GitLogEntry } from '../../../shared/domain/git-workspace'

export type HistoryGraphRow = {
  entry: GitLogEntry
  /** Lane the commit's dot occupies. */
  lane: number
  /** Lanes that are active on this row and should draw a vertical segment. */
  lanes: number[]
  /** Lane index of each parent, in parent order. */
  parentLanes: number[]
  /** Palette index; lane identity is stable for the page. */
  color: number
  merge: boolean
}

/**
 * Assigns graph lanes to a newest-first commit list.
 *
 * `expected` holds the commit oid each lane is waiting for. Finding a commit
 * in that array continues its branch; otherwise it starts a new lane (or takes
 * a free one). The first parent inherits the commit's lane and additional
 * parents claim lanes of their own, which is the shape VS Code's swimlane
 * graph uses. Merge arcs are drawn by the view from `parentLanes`.
 */
export function buildHistoryGraph(commits: readonly GitLogEntry[]): HistoryGraphRow[] {
  const expected: Array<string | null> = []
  const rows: HistoryGraphRow[] = []

  for (const entry of commits) {
    let lane = expected.indexOf(entry.oid)
    if (lane === -1) {
      lane = expected.indexOf(null)
      if (lane === -1) {
        lane = expected.length
        expected.push(entry.oid)
      } else {
        expected[lane] = entry.oid
      }
    }

    const active = new Set<number>()
    for (let index = 0; index < expected.length; index += 1) {
      if (expected[index] !== null) active.add(index)
    }
    active.add(lane)

    const parentLanes: number[] = []
    if (entry.parents.length === 0) {
      expected[lane] = null
    } else {
      // A fork can make the first parent already expected on another lane.
      // Move the branch there instead of duplicating the oid, or the empty
      // lane would never close.
      const existingFirst = expected.indexOf(entry.parents[0]!)
      if (existingFirst !== -1 && existingFirst !== lane) {
        expected[lane] = null
        parentLanes.push(existingFirst)
      } else {
        expected[lane] = entry.parents[0]!
        parentLanes.push(lane)
      }
      for (const parent of entry.parents.slice(1)) {
        let parentLane = expected.indexOf(parent)
        if (parentLane === -1) {
          parentLane = expected.indexOf(null)
          if (parentLane === -1) {
            parentLane = expected.length
            expected.push(parent)
          } else {
            expected[parentLane] = parent
          }
        }
        parentLanes.push(parentLane)
      }
    }

    for (let index = 0; index < expected.length; index += 1) {
      if (expected[index] !== null) active.add(index)
    }
    for (const parentLane of parentLanes) active.add(parentLane)

    rows.push({
      entry,
      lane,
      lanes: [...active].sort((left, right) => left - right),
      parentLanes,
      color: lane % 6,
      merge: entry.parents.length > 1
    })

    while (expected.length > 0 && expected[expected.length - 1] === null) expected.pop()
  }

  return rows
}
