/**
 * A group workspace whose owner closed every room tab must restore empty, not
 * fall back to the original room. The tab store deletes an empty scope, so the
 * explicit empty state lives beside it.
 */
const STORAGE_KEY = 'icode.rooms.empty.v1'

function readAll(): Record<string, true> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, true> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) result[key] = true
    }
    return result
  } catch {
    return {}
  }
}

function writeAll(value: Record<string, true>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // A blocked storage is only a lost empty-state preference.
  }
}

export function isRoomWorkspaceEmpty(scopeKey: string): boolean {
  return readAll()[scopeKey] === true
}

export function setRoomWorkspaceEmpty(scopeKey: string, empty: boolean): void {
  const current = readAll()
  if (empty) {
    current[scopeKey] = true
  } else {
    if (current[scopeKey] !== true) return
    delete current[scopeKey]
  }
  writeAll(current)
}
