import { describe, expect, it } from 'vitest'
import {
  clearTabEverywhere,
  createLeaf,
  displayedTabKeys,
  dropPane,
  findPaneForTabKey,
  firstLeafPaneId,
  focusPane,
  layoutSplit,
  leafPaneIds,
  parseSplitState,
  reconcilePaneTabs,
  removePane,
  setPaneTabKey,
  splitAround,
  swapPaneContents,
  type SplitNode
} from './workspace-split'

const leaf = (paneId: string, activeTabKey: string | null = null) =>
  createLeaf(activeTabKey, paneId)

function twoPanes(): SplitNode {
  return splitAround(leaf('a', 'file:a.ts'), 'a', 'right', leaf('b', 'session:ses_b'))
}

describe('workspace split tree', () => {
  it('splits around a pane and reports layout order', () => {
    const root = twoPanes()
    expect(leafPaneIds(root)).toEqual(['a', 'b'])
    expect(firstLeafPaneId(root)).toBe('a')
    const rects = layoutSplit(root)
    expect(rects.map((rect) => rect.paneId)).toEqual(['a', 'b'])
    expect(rects[0]!.width).toBeCloseTo(0.5)
  })

  it('collapses a branch when a pane is removed', () => {
    const root = twoPanes()
    const remaining = removePane(root, 'b')
    expect(remaining).toMatchObject({ kind: 'leaf', paneId: 'a' })
  })

  it('keeps one pane per tab and swaps pane contents', () => {
    const root = twoPanes()
    const swapped = swapPaneContents(root, 'a', 'b')
    expect(displayedTabKeys(swapped)).toEqual(['session:ses_b', 'file:a.ts'])
    expect(findPaneForTabKey(swapped, 'session:ses_b')?.paneId).toBe('a')
  })

  it('moves a tab to another pane without duplicating it', () => {
    const root = twoPanes()
    const cleared = clearTabEverywhere(root, 'file:a.ts', 'b')
    const moved = setPaneTabKey(cleared, 'b', 'file:a.ts')
    expect(displayedTabKeys(moved)).toEqual(['file:a.ts'])
    expect(findPaneForTabKey(moved, 'file:a.ts')?.paneId).toBe('b')
  })

  it('clears tabs that left the tab list', () => {
    const root = twoPanes()
    const reconciled = reconcilePaneTabs(root, new Set(['session:ses_b']))
    expect(displayedTabKeys(reconciled)).toEqual(['session:ses_b'])
  })

  it('drops a pane onto a center by swapping, and onto an edge by splitting', () => {
    const root = twoPanes()
    const centered = dropPane(root, 'a', 'b', 'center')
    expect(displayedTabKeys(centered)).toEqual(['session:ses_b', 'file:a.ts'])

    const edged = dropPane(root, 'a', 'b', 'bottom')
    expect(leafPaneIds(edged)).toEqual(['b', 'a'])
    expect(displayedTabKeys(edged)).toEqual(['session:ses_b', 'file:a.ts'])
  })

  it('focuses the nearest pane in a direction', () => {
    const root = twoPanes()
    expect(focusPane(root, 'a', 'right')).toBe('b')
    expect(focusPane(root, 'b', 'left')).toBe('a')
    expect(focusPane(root, 'a', 'left')).toBeNull()
  })

  it('parses a persisted tree and rejects duplicate displayed tabs', () => {
    const root = twoPanes()
    const parsed = parseSplitState({ v: 2, root, focusedPaneId: 'b' })
    expect(parsed?.focusedPaneId).toBe('b')
    expect(parsed?.root).toEqual(root)

    const duplicate = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      pinned: false,
      first: leaf('a', 'file:a.ts'),
      second: leaf('b', 'file:a.ts')
    }
    expect(parseSplitState({ v: 2, root: duplicate, focusedPaneId: 'a' })).toBeNull()
  })
})
