import { describe, expect, it } from 'vitest'
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  clampedRatio,
  containsSession,
  directionForSide,
  dropInGroups,
  dropPane,
  dropZoneAt,
  equalized,
  firstLeafSessionId,
  focusSession,
  groupOf,
  groupedSessionIds,
  layoutSplit,
  leafSessionIds,
  parseSplitGroups,
  parseSplitTree,
  placeInGroups,
  placeSession,
  pruneGroups,
  pruneLeaves,
  removeLeaf,
  removeSessionFromGroups,
  replaceLeaf,
  segmentCount,
  slotForSide,
  splitAround,
  splitPair,
  swapInGroups,
  swapLeaves,
  toggleGroupForActive,
  updateGroupRatio,
  updateRatio,
  type SplitBranch,
  type SplitNode
} from './session-split'

type Bare =
  | { kind: 'leaf'; sessionId: string }
  | {
      kind: 'split'
      direction: 'horizontal' | 'vertical'
      ratio: number
      pinned: boolean
      first: Bare
      second: Bare
    }

function bare(node: SplitNode | null): Bare | null {
  if (node === null) return null
  if (node.kind === 'leaf') return { kind: 'leaf', sessionId: node.sessionId }
  return {
    kind: 'split',
    direction: node.direction,
    ratio: node.ratio,
    pinned: node.pinned,
    first: bare(node.first) as Bare,
    second: bare(node.second) as Bare
  }
}

function rootOf(node: SplitNode | null): SplitBranch {
  if (node === null || node.kind !== 'split') throw new Error('expected a branch')
  return node
}

describe('split directions', () => {
  it('maps sides to axes and slots', () => {
    expect(directionForSide('left')).toBe('horizontal')
    expect(directionForSide('right')).toBe('horizontal')
    expect(directionForSide('up')).toBe('vertical')
    expect(directionForSide('down')).toBe('vertical')
    expect(slotForSide('left')).toBe('first')
    expect(slotForSide('up')).toBe('first')
    expect(slotForSide('right')).toBe('second')
    expect(slotForSide('down')).toBe('second')
  })
})

describe('splitPair', () => {
  it('places the new session on the requested side of the active one', () => {
    const pair = (side: 'left' | 'right' | 'up' | 'down'): Bare | null =>
      bare(splitPair('a', side, 'b'))

    expect(pair('right')).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'a' },
      second: { kind: 'leaf', sessionId: 'b' }
    })
    expect(pair('left')).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'b' },
      second: { kind: 'leaf', sessionId: 'a' }
    })
    expect(pair('down')).toEqual({
      kind: 'split',
      direction: 'vertical',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'a' },
      second: { kind: 'leaf', sessionId: 'b' }
    })
    expect(pair('up')).toEqual({
      kind: 'split',
      direction: 'vertical',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'b' },
      second: { kind: 'leaf', sessionId: 'a' }
    })
  })
})

describe('splitAround', () => {
  it('replaces the target leaf and nests under the existing branch', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(splitAround(ab, 'b', 'down', 'c'))).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'a' },
      second: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        pinned: false,
        first: { kind: 'leaf', sessionId: 'b' },
        second: { kind: 'leaf', sessionId: 'c' }
      }
    })
  })

  it('places the new pane before the target for left and up', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(splitAround(ab, 'a', 'left', 'c'))).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        pinned: false,
        first: { kind: 'leaf', sessionId: 'c' },
        second: { kind: 'leaf', sessionId: 'a' }
      },
      second: { kind: 'leaf', sessionId: 'b' }
    })
  })

  it('leaves the tree untouched when the target is missing', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(splitAround(ab, 'missing', 'left', 'c')).toBe(ab)
  })
})

describe('placeSession', () => {
  it('creates the first tree around the active session', () => {
    expect(bare(placeSession(null, 'a', 'down', 'b'))).toEqual({
      kind: 'split',
      direction: 'vertical',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'a' },
      second: { kind: 'leaf', sessionId: 'b' }
    })
  })

  it('splits the focused pane when the tab comes from outside the tree', () => {
    const ab = splitPair('a', 'right', 'b')
    const placed = placeSession(ab, 'a', 'right', 'c')
    expect(rootOf(placed).direction).toBe('horizontal')
    expect(leafSessionIds(placed)).toEqual(['a', 'c', 'b'])
  })

  it('moves a leaf that already belongs to the tree', () => {
    const ab = splitPair('a', 'right', 'b')
    const up = placeSession(ab, 'a', 'up', 'b')
    expect(rootOf(up).direction).toBe('vertical')
    expect(leafSessionIds(up)).toEqual(['b', 'a'])

    const left = placeSession(ab, 'a', 'left', 'b')
    expect(leafSessionIds(left)).toEqual(['b', 'a'])
  })

  it('leaves the tree alone when the focused session is not in it', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(placeSession(ab, 'missing', 'left', 'c')).toBe(ab)
  })
})

describe('removeLeaf', () => {
  it('collapses a branch into its surviving sibling', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(removeLeaf(ab, 'a'))).toEqual({ kind: 'leaf', sessionId: 'b' })
    expect(bare(removeLeaf(ab, 'b'))).toEqual({ kind: 'leaf', sessionId: 'a' })
  })

  it('collapses nested branches without disturbing the rest of the tree', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    expect(bare(removeLeaf(abc, 'b'))).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'a' },
      second: { kind: 'leaf', sessionId: 'c' }
    })
  })

  it('returns null for the last leaf and ignores unknown sessions', () => {
    expect(removeLeaf({ kind: 'leaf', sessionId: 'a' }, 'a')).toBeNull()
    const ab = splitPair('a', 'right', 'b')
    expect(removeLeaf(ab, 'missing')).toBe(ab)
  })
})

describe('swapLeaves', () => {
  it('exchanges leaves while keeping shape and ratios', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(swapLeaves(ab, 'a', 'b'))).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'b' },
      second: { kind: 'leaf', sessionId: 'a' }
    })
  })

  it('swaps nested leaves', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    expect(leafSessionIds(swapLeaves(abc, 'a', 'c'))).toEqual(['c', 'b', 'a'])
  })

  it('ignores unknown sessions and identical ids', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(swapLeaves(ab, 'a', 'a')).toBe(ab)
    expect(swapLeaves(ab, 'a', 'missing')).toBe(ab)
  })
})

describe('dropZoneAt', () => {
  const width = 200
  const height = 100

  it('uses the centred 40% box for swaps', () => {
    expect(dropZoneAt(100, 50, width, height)).toBe('center')
    expect(dropZoneAt(60, 30, width, height)).toBe('center')
    expect(dropZoneAt(140, 70, width, height)).toBe('center')
  })

  it('uses the nearest edge outside the centre', () => {
    expect(dropZoneAt(10, 50, width, height)).toBe('left')
    expect(dropZoneAt(190, 50, width, height)).toBe('right')
    expect(dropZoneAt(100, 10, width, height)).toBe('top')
    expect(dropZoneAt(100, 90, width, height)).toBe('bottom')
    expect(dropZoneAt(20, 10, width, height)).toBe('top')
  })

  it('falls back to the centre for a degenerate pane', () => {
    expect(dropZoneAt(0, 0, 0, 0)).toBe('center')
  })
})

describe('dropPane', () => {
  it('swaps on a centre drop', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(leafSessionIds(dropPane(ab, 'a', 'b', 'center'))).toEqual(['b', 'a'])
  })

  it('re-splits the target on an edge drop', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(dropPane(ab, 'a', 'b', 'right'))).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'b' },
      second: { kind: 'leaf', sessionId: 'a' }
    })
    const down = dropPane(ab, 'a', 'b', 'bottom')
    expect(rootOf(down).direction).toBe('vertical')
    expect(leafSessionIds(down)).toEqual(['b', 'a'])
  })

  it('ignores self and unknown drops', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(dropPane(ab, 'a', 'a', 'center')).toBe(ab)
    expect(dropPane(ab, 'a', 'missing', 'center')).toBe(ab)
  })

  it('rearranges a nested tree', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    expect(leafSessionIds(dropPane(abc, 'c', 'a', 'right'))).toEqual(['a', 'c', 'b'])
  })
})

describe('equalized', () => {
  it('balances unpinned branches by segment count', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'right', 'c')
    expect(segmentCount(abc, 'horizontal')).toBe(3)
    expect(rootOf(equalized(abc)).ratio).toBeCloseTo(1 / 3)
  })

  it('keeps a pinned divider ratio', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'right', 'c')
    const pinned = updateRatio(abc, rootOf(abc).id, 0.8)
    expect(rootOf(equalized(pinned)).ratio).toBe(0.8)
  })

  it('counts a cross-axis branch as one segment', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    expect(segmentCount(abc, 'horizontal')).toBe(2)
    expect(segmentCount(abc, 'vertical')).toBe(1)
    expect(rootOf(equalized(abc)).ratio).toBeCloseTo(0.5)
  })
})

describe('updateRatio', () => {
  it('clamps and pins a divider', () => {
    const ab = splitPair('a', 'right', 'b')
    const high = rootOf(updateRatio(ab, rootOf(ab).id, 0.99))
    expect(high.ratio).toBe(SPLIT_MAX_RATIO)
    expect(high.pinned).toBe(true)

    const low = rootOf(updateRatio(ab, rootOf(ab).id, 0.01))
    expect(low.ratio).toBe(SPLIT_MIN_RATIO)
  })

  it('leaves an unchanged pinned branch alone', () => {
    const ab = splitPair('a', 'right', 'b')
    const pinned = updateRatio(ab, rootOf(ab).id, 0.8)
    expect(updateRatio(pinned, rootOf(ab).id, 0.8)).toBe(pinned)
  })

  it('ignores unknown branches', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(updateRatio(ab, 'missing', 0.8)).toBe(ab)
  })
})

describe('pruneLeaves', () => {
  it('drops invisible leaves and collapses their parents', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(pruneLeaves(ab, new Set(['a'])))).toEqual({
      kind: 'leaf',
      sessionId: 'a'
    })
    expect(pruneLeaves(ab, new Set())).toBeNull()
  })

  it('returns the same tree when every leaf is visible', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(pruneLeaves(ab, new Set(['a', 'b']))).toBe(ab)
  })
})

describe('replaceLeaf', () => {
  it('changes only the target leaf', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(bare(replaceLeaf(ab, 'a', 'c'))).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'c' },
      second: { kind: 'leaf', sessionId: 'b' }
    })
    expect(replaceLeaf(ab, 'missing', 'c')).toBe(ab)
  })
})

describe('groupOf and groupedSessionIds', () => {
  it('finds the group containing a session', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    expect(groupOf([ab, cd], 'c')).toBe(cd)
    expect(groupOf([ab, cd], 'missing')).toBeNull()
    expect(groupOf([ab, cd], null)).toBeNull()
    expect([...groupedSessionIds([ab, cd])].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('pruneGroups', () => {
  it('drops invisible leaves and dissolves groups that fall to one pane', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    expect(pruneGroups([ab, cd], ['c', 'd'])).toEqual([cd])
    expect(pruneGroups([ab], [])).toEqual([])
  })

  it('keeps the array when nothing changed', () => {
    const ab = splitPair('a', 'right', 'b')
    const groups = [ab]
    expect(pruneGroups(groups, ['a', 'b'])).toBe(groups)
  })
})

describe('removeSessionFromGroups', () => {
  it('dissolves a two-pane group', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(removeSessionFromGroups([ab], 'a')).toEqual([])
  })

  it('keeps a larger group and collapses the branch', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    const groups = removeSessionFromGroups([abc], 'b')
    expect(groups).toHaveLength(1)
    expect(leafSessionIds(groups[0]!)).toEqual(['a', 'c'])
  })

  it('ignores ungrouped sessions', () => {
    const groups = [splitPair('a', 'right', 'b')]
    expect(removeSessionFromGroups(groups, 'missing')).toBe(groups)
  })
})

describe('placeInGroups', () => {
  it('creates a group beside an ungrouped anchor', () => {
    const groups = placeInGroups([], 'a', 'right', 'b')
    expect(groups).toHaveLength(1)
    expect(leafSessionIds(groups[0]!)).toEqual(['a', 'b'])
  })

  it('adds a session to the anchor group', () => {
    const ab = splitPair('a', 'right', 'b')
    const groups = placeInGroups([ab], 'a', 'down', 'c')
    expect(leafSessionIds(groups[0]!)).toEqual(['a', 'c', 'b'])
  })

  it('moves a session out of another group and dissolves it when needed', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    const groups = placeInGroups([ab, cd], 'a', 'right', 'c')
    expect(groups).toHaveLength(1)
    expect([...leafSessionIds(groups[0]!)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('never duplicates a session when it already belongs to the group', () => {
    const ab = splitPair('a', 'right', 'b')
    const groups = placeInGroups([ab], 'a', 'left', 'b')
    expect(groups).toHaveLength(1)
    expect(leafSessionIds(groups[0]!)).toEqual(['b', 'a'])
  })

  it('ignores a self anchor', () => {
    const groups = [splitPair('a', 'right', 'b')]
    expect(placeInGroups(groups, 'a', 'right', 'a')).toBe(groups)
  })
})

describe('toggleGroupForActive', () => {
  it('closes the active group', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(toggleGroupForActive([ab], 'a', ['a', 'b'])).toEqual([])
  })

  it('opens a group with an ungrouped visible session', () => {
    const groups = toggleGroupForActive([], 'a', ['a', 'b'])
    expect(groups).toHaveLength(1)
    expect(leafSessionIds(groups[0]!)).toEqual(['a', 'b'])
  })

  it('does not steal a session from another group', () => {
    const cd = splitPair('c', 'right', 'd')
    const groups = [cd]
    expect(toggleGroupForActive(groups, 'a', ['a', 'c', 'd'])).toBe(groups)
  })
})

describe('updateGroupRatio', () => {
  it('updates the branch in its group', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    const groups = updateGroupRatio([ab, cd], rootOf(ab).id, 0.8)
    expect(rootOf(groups[0]!).ratio).toBe(0.8)
    expect(rootOf(groups[0]!).pinned).toBe(true)
    expect(groups[1]).toBe(cd)
  })

  it('ignores an unknown branch', () => {
    const groups = [splitPair('a', 'right', 'b')]
    expect(updateGroupRatio(groups, 'missing', 0.8)).toBe(groups)
  })
})

describe('swapInGroups', () => {
  it('swaps leaves within a group', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    const groups = swapInGroups([ab, cd], 'a', 'b')
    expect(leafSessionIds(groups[0]!)).toEqual(['b', 'a'])
    expect(groups[1]).toBe(cd)
  })

  it('refuses to swap across groups', () => {
    const groups = [splitPair('a', 'right', 'b'), splitPair('c', 'right', 'd')]
    expect(swapInGroups(groups, 'a', 'c')).toBe(groups)
  })
})

describe('dropInGroups', () => {
  it('rearranges within a group', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    const groups = dropInGroups([ab, cd], 'a', 'b', 'bottom')
    expect(rootOf(groups[0]!).direction).toBe('vertical')
    expect(leafSessionIds(groups[0]!)).toEqual(['b', 'a'])
    expect(groups[1]).toBe(cd)
  })

  it('refuses a cross-group drop', () => {
    const groups = [splitPair('a', 'right', 'b'), splitPair('c', 'right', 'd')]
    expect(dropInGroups(groups, 'a', 'c', 'center')).toBe(groups)
  })
})

describe('parseSplitGroups', () => {
  it('reads an array of groups', () => {
    const ab = splitPair('a', 'right', 'b')
    const cd = splitPair('c', 'right', 'd')
    const parsed = parseSplitGroups(JSON.parse(JSON.stringify([ab, cd])))
    expect(parsed.map((group) => leafSessionIds(group))).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('reads a legacy single tree as one group', () => {
    const ab = splitPair('a', 'right', 'b')
    const parsed = parseSplitGroups(JSON.parse(JSON.stringify(ab)))
    expect(parsed).toHaveLength(1)
    expect(leafSessionIds(parsed[0]!)).toEqual(['a', 'b'])
  })

  it('drops duplicate-session and malformed groups', () => {
    const ab = splitPair('a', 'right', 'b')
    const dup = splitPair('b', 'right', 'c')
    const parsed = parseSplitGroups(JSON.parse(JSON.stringify([ab, dup])))
    expect(parsed).toHaveLength(1)
    expect(leafSessionIds(parsed[0]!)).toEqual(['a', 'b'])
    expect(parseSplitGroups(null)).toEqual([])
    expect(parseSplitGroups({ kind: 'leaf', sessionId: 'a' })).toEqual([])
  })
})

describe('parseSplitTree', () => {
  it('round-trips a serialized tree', () => {
    const tree = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    const parsed = parseSplitTree(JSON.parse(JSON.stringify(tree)))
    expect(parsed).not.toBeNull()
    expect(leafSessionIds(parsed)).toEqual(['a', 'b', 'c'])
  })

  it('clamps a persisted ratio', () => {
    const parsed = parseSplitTree({
      kind: 'split',
      id: 'branch',
      direction: 'horizontal',
      ratio: 5,
      pinned: false,
      first: { kind: 'leaf', sessionId: 'a' },
      second: { kind: 'leaf', sessionId: 'b' }
    })
    expect(parsed).toMatchObject({ kind: 'split', ratio: SPLIT_MAX_RATIO })
  })

  it('rejects malformed trees', () => {
    expect(parseSplitTree(null)).toBeNull()
    expect(parseSplitTree({ kind: 'leaf' })).toBeNull()
    expect(parseSplitTree({ kind: 'leaf', sessionId: '' })).toBeNull()
    expect(
      parseSplitTree({
        kind: 'split',
        id: 'branch',
        direction: 'diagonal',
        ratio: 0.5,
        pinned: false,
        first: { kind: 'leaf', sessionId: 'a' },
        second: { kind: 'leaf', sessionId: 'b' }
      })
    ).toBeNull()
    expect(
      parseSplitTree({
        kind: 'split',
        id: 'branch',
        direction: 'horizontal',
        ratio: Number.NaN,
        pinned: false,
        first: { kind: 'leaf', sessionId: 'a' },
        second: { kind: 'leaf', sessionId: 'b' }
      })
    ).toBeNull()
    expect(
      parseSplitTree({
        kind: 'split',
        id: 'branch',
        direction: 'horizontal',
        ratio: 0.5,
        pinned: false,
        first: { kind: 'leaf', sessionId: 'a' },
        second: { kind: 'leaf', sessionId: 'a' }
      })
    ).toBeNull()
  })
})

describe('layoutSplit and focusSession', () => {
  it('derives pane rectangles from the tree', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(layoutSplit(ab)).toEqual([
      { sessionId: 'a', x: 0, y: 0, width: 0.5, height: 1 },
      { sessionId: 'b', x: 0.5, y: 0, width: 0.5, height: 1 }
    ])

    const stacked = splitPair('a', 'down', 'b')
    expect(layoutSplit(stacked)).toEqual([
      { sessionId: 'a', x: 0, y: 0, width: 1, height: 0.5 },
      { sessionId: 'b', x: 0, y: 0.5, width: 1, height: 0.5 }
    ])
  })

  it('moves focus along both axes', () => {
    const ab = splitPair('a', 'right', 'b')
    expect(focusSession(ab, 'a', 'right')).toBe('b')
    expect(focusSession(ab, 'b', 'left')).toBe('a')
    expect(focusSession(ab, 'a', 'left')).toBeNull()

    const stacked = splitPair('a', 'down', 'b')
    expect(focusSession(stacked, 'a', 'down')).toBe('b')
    expect(focusSession(stacked, 'b', 'up')).toBe('a')
  })

  it('prefers the pane that lines up in a nested layout', () => {
    const tab = rootOf(placeSession(splitPair('a', 'down', 'b'), 'a', 'right', 'c'))
    expect(focusSession(tab, 'a', 'right')).toBe('c')
    expect(focusSession(tab, 'a', 'down')).toBe('b')
  })
})

describe('tree helpers', () => {
  it('reports membership and leaves in layout order', () => {
    const abc = splitAround(splitPair('a', 'right', 'b'), 'b', 'down', 'c')
    expect(containsSession(abc, 'c')).toBe(true)
    expect(containsSession(abc, 'missing')).toBe(false)
    expect(leafSessionIds(abc)).toEqual(['a', 'b', 'c'])
    expect(firstLeafSessionId(abc)).toBe('a')
  })

  it('clamps ratios to the usable range', () => {
    expect(clampedRatio(0.5)).toBe(0.5)
    expect(clampedRatio(0)).toBe(SPLIT_MIN_RATIO)
    expect(clampedRatio(1)).toBe(SPLIT_MAX_RATIO)
  })
})
