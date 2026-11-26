/**
 * The Bots section's sort and filter preferences.
 *
 * Manual order is the default and the only mode where rows drag. The other
 * modes derive a view without rewriting the saved order, so switching back to
 * Manual restores exactly what the owner arranged.
 */

export const BOTS_SIDEBAR_SORTS = ['manual', 'smart', 'recent', 'name'] as const
export type BotsSidebarSort = (typeof BOTS_SIDEBAR_SORTS)[number]

export type BotsSidebarView = {
  sortBy: BotsSidebarSort
  hidePaused: boolean
  hideSleeping: boolean
}

export const DEFAULT_BOTS_SIDEBAR_VIEW: BotsSidebarView = {
  sortBy: 'manual',
  hidePaused: false,
  hideSleeping: false
}

export const BOTS_SIDEBAR_VIEW_KEY = 'icode.bots.view.v1'

export type BotsRowFacts = {
  key: string
  kind: 'bot' | 'group'
  name: string
  paused: boolean
  needs: number
  unread: number
  working: boolean
  sleeping: boolean
  activityAt: number
}

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function normalizeBotsSidebarView(value: unknown): BotsSidebarView {
  const saved =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof BotsSidebarView, unknown>>)
      : {}
  const sortBy = BOTS_SIDEBAR_SORTS.find((choice) => choice === saved.sortBy)
  return {
    sortBy: sortBy ?? DEFAULT_BOTS_SIDEBAR_VIEW.sortBy,
    hidePaused: saved.hidePaused === true,
    hideSleeping: saved.hideSleeping === true
  }
}

export function loadBotsSidebarView(
  storage: ReadableStorage | null = browserStorage()
): BotsSidebarView {
  if (storage === null) return DEFAULT_BOTS_SIDEBAR_VIEW
  try {
    const raw = storage.getItem(BOTS_SIDEBAR_VIEW_KEY)
    if (raw === null) return DEFAULT_BOTS_SIDEBAR_VIEW
    return normalizeBotsSidebarView(JSON.parse(raw))
  } catch {
    return DEFAULT_BOTS_SIDEBAR_VIEW
  }
}

export function saveBotsSidebarView(
  view: BotsSidebarView,
  storage: WritableStorage | null = browserStorage()
): void {
  if (storage === null) return
  try {
    storage.setItem(BOTS_SIDEBAR_VIEW_KEY, JSON.stringify(view))
  } catch {
    // A blocked storage is only a lost preference.
  }
}

export function countActiveBotsFilters(view: BotsSidebarView): number {
  return Number(view.hidePaused) + Number(view.hideSleeping)
}

/** Applies the view to rows already in their saved Manual order. */
export function arrangeBotsRows<T extends BotsRowFacts>(
  rows: readonly T[],
  view: BotsSidebarView
): T[] {
  const shown = rows.filter(
    (row) =>
      row.kind !== 'bot' ||
      ((!view.hidePaused || !row.paused) && (!view.hideSleeping || !row.sleeping))
  )
  if (view.sortBy === 'manual') return shown
  if (view.sortBy === 'recent') {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
    return shown
      .map((row, index) => ({ row, index }))
      .sort(
        (left, right) =>
          right.row.activityAt - left.row.activityAt ||
          collator.compare(left.row.name, right.row.name) ||
          left.index - right.index
      )
      .map(({ row }) => row)
  }
  if (view.sortBy === 'name') {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
    return shown
      .map((row, index) => ({ row, index }))
      .sort(
        (left, right) =>
          collator.compare(left.row.name, right.row.name) || left.index - right.index
      )
      .map(({ row }) => row)
  }
  return shown
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        Number(right.row.needs > 0) - Number(left.row.needs > 0) ||
        right.row.needs - left.row.needs ||
        Number(right.row.working) - Number(left.row.working) ||
        right.row.unread - left.row.unread ||
        right.row.activityAt - left.row.activityAt ||
        left.index - right.index
    )
    .map(({ row }) => row)
}
