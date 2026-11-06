import { describe, expect, it } from 'vitest'
import {
  TREE_STATE_MAX_EXPANDED,
  clearTreeState,
  loadTreeState,
  pruneTreeStates,
  saveTreeState,
  treeStateStorageKey
} from './tree-state'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
}

describe('tree state persistence', () => {
  it('round-trips expansion, focus, selection and scroll', () => {
    const store = storage()
    expect(
      saveTreeState(
        'ses_a',
        {
          expanded: ['', 'src', 'src/files'],
          focused: 'src/files/a.ts',
          selected: ['src/files/a.ts'],
          anchor: 'src/files/a.ts',
          scrollTop: 84
        },
        store
      )
    ).toBe(true)
    expect(loadTreeState('ses_a', store)).toEqual({
      v: 1,
      expanded: ['', 'src', 'src/files'],
      focused: 'src/files/a.ts',
      selected: ['src/files/a.ts'],
      anchor: 'src/files/a.ts',
      scrollTop: 84
    })
  })

  it('caps expansion and rejects malformed or hostile payloads', () => {
    const store = storage()
    saveTreeState(
      'ses_a',
      {
        expanded: Array.from({ length: TREE_STATE_MAX_EXPANDED + 50 }, (_, index) =>
          `dir${String(index)}`
        ),
        focused: null,
        selected: [],
        anchor: null,
        scrollTop: -10
      },
      store
    )
    const loaded = loadTreeState('ses_a', store)
    expect(loaded?.expanded).toHaveLength(TREE_STATE_MAX_EXPANDED)
    expect(loaded?.scrollTop).toBe(0)

    store.setItem(treeStateStorageKey('ses_a'), '{"v":1,"expanded":["ok"],"scrollTop":"no"}')
    expect(loadTreeState('ses_a', store)).toBeNull()
    store.setItem(treeStateStorageKey('ses_a'), '{')
    expect(loadTreeState('ses_a', store)).toBeNull()
  })

  it('clears and prunes removed sessions without touching live keys', () => {
    const store = storage({
      [treeStateStorageKey('ses_a')]: '{}',
      [treeStateStorageKey('ses_b')]: '{}',
      'icoder.unrelated': 'keep'
    })
    pruneTreeStates(new Set(['ses_b']), store)
    expect(store.getItem(treeStateStorageKey('ses_a'))).toBeNull()
    expect(store.getItem(treeStateStorageKey('ses_b'))).toBe('{}')
    expect(store.getItem('icoder.unrelated')).toBe('keep')
    clearTreeState('ses_b', store)
    expect(store.getItem(treeStateStorageKey('ses_b'))).toBeNull()
  })
})
