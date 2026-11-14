export type AppTab = 'sessions' | 'mira' | 'settings' | 'schedules'
export type AuxAppTab = Exclude<AppTab, 'sessions'>

export const SESSIONS_TAB: AppTab = 'sessions'

/**
 * Auxiliary tabs are opened on demand and never persisted. Sessions is always
 * the pinned home and is never part of the mutable list.
 */
export function openAuxTab(tabs: readonly AuxAppTab[], tab: AuxAppTab): AuxAppTab[] {
  return tabs.includes(tab) ? [...tabs] : [...tabs, tab]
}

export function closeAuxTab(tabs: readonly AuxAppTab[], tab: AuxAppTab): AuxAppTab[] {
  return tabs.filter((entry) => entry !== tab)
}

export function nextActiveAfterClose(
  tabs: readonly AuxAppTab[],
  closing: AuxAppTab,
  active: AppTab
): AppTab {
  const remaining = closeAuxTab(tabs, closing)
  if (active !== closing) return active
  const closingIndex = tabs.indexOf(closing)
  if (remaining.length === 0) return SESSIONS_TAB
  const nextIndex = Math.min(Math.max(0, closingIndex), remaining.length - 1)
  return remaining[nextIndex] ?? SESSIONS_TAB
}

export function isAuxTab(tab: AppTab): tab is AuxAppTab {
  return tab !== 'sessions'
}
