import { z } from 'zod'

/**
 * Per-session explorer position: expanded folders, focus/selection and scroll.
 *
 * This is renderer-only state persisted in localStorage. The cap keeps a large
 * tree from turning into a megabyte of stale paths; malformed data is ignored
 * rather than half-restored.
 */

export const TREE_STATE_VERSION = 1
export const TREE_STATE_MAX_EXPANDED = 200
export const TREE_STATE_MAX_SELECTED = 100
export const treeStateStorageKey = (sessionId: string): string =>
  `icode.files.tree.v1.${sessionId}`

const pathSchema = z.string().max(4096)
const schema = z.object({
  v: z.literal(TREE_STATE_VERSION),
  expanded: z.array(pathSchema).max(TREE_STATE_MAX_EXPANDED),
  focused: pathSchema.nullable(),
  selected: z.array(pathSchema).max(TREE_STATE_MAX_SELECTED),
  anchor: pathSchema.nullable(),
  scrollTop: z.number().finite().min(0)
})

export type PersistedTreeState = z.infer<typeof schema>

type ReadableStorage = Pick<Storage, 'getItem' | 'key' | 'length' | 'removeItem'>
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadTreeState(
  sessionId: string,
  storage: ReadableStorage | null = browserStorage()
): PersistedTreeState | null {
  if (storage === null) return null
  let raw: string | null
  try {
    raw = storage.getItem(treeStateStorageKey(sessionId))
  } catch {
    return null
  }
  if (raw === null || raw.length > 2_000_000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = schema.safeParse(parsed)
  return result.success ? result.data : null
}

export function saveTreeState(
  sessionId: string,
  state: Omit<PersistedTreeState, 'v'>,
  storage: WritableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  const payload: PersistedTreeState = {
    v: TREE_STATE_VERSION,
    expanded: state.expanded.slice(0, TREE_STATE_MAX_EXPANDED),
    focused: state.focused,
    selected: state.selected.slice(0, TREE_STATE_MAX_SELECTED),
    anchor: state.anchor,
    scrollTop: Math.max(0, Number.isFinite(state.scrollTop) ? state.scrollTop : 0)
  }
  try {
    storage.setItem(treeStateStorageKey(sessionId), JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function clearTreeState(
  sessionId: string,
  storage: WritableStorage | null = browserStorage()
): void {
  try {
    storage?.removeItem(treeStateStorageKey(sessionId))
  } catch {
    // A failed cleanup is not a user-visible failure.
  }
}

/** Drops keys for sessions that no longer exist. */
export function pruneTreeStates(
  sessionIds: ReadonlySet<string>,
  storage: ReadableStorage & WritableStorage | null = browserStorage()
): void {
  if (storage === null) return
  const keys: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key.startsWith('icode.files.tree.v1.')) keys.push(key)
    }
    for (const key of keys) {
      const sessionId = key.slice('icode.files.tree.v1.'.length)
      if (!sessionIds.has(sessionId)) storage.removeItem(key)
    }
  } catch {
    // localStorage can be blocked; persistence is best-effort.
  }
}
