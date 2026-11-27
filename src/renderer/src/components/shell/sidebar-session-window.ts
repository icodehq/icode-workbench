export type SessionWindowState = {
  start: number
  end: number
}

export type SessionWindow<T> = SessionWindowState & {
  visible: T[]
  hiddenBefore: number
  hiddenAfter: number
  activeIndex: number
}

/**
 * The sidebar renders large session groups as a moving window instead of
 * mounting every row. The active session always wins: when it falls outside
 * the remembered window, the window shifts to end at that row. That keeps a
 * newly created session visible without rendering every predecessor.
 */
export function resolveSessionWindow<T extends { id: string }>(
  sessions: readonly T[],
  state: SessionWindowState | undefined,
  activeId: string | null,
  batch: number
): SessionWindow<T> {
  const total = sessions.length
  const activeIndex =
    activeId === null ? -1 : sessions.findIndex((session) => session.id === activeId)
  let start = state?.start ?? 0
  let end = state?.end ?? Math.min(batch, total)

  if (activeIndex >= 0 && (activeIndex < start || activeIndex >= end)) {
    start = Math.max(
      0,
      Math.min(activeIndex - batch + 1, Math.max(0, total - batch))
    )
    end = Math.min(total, start + batch)
  }

  if (total === 0) {
    start = 0
    end = 0
  } else {
    start = Math.max(0, Math.min(start, total - 1))
    end = Math.max(start, Math.min(end, total))
  }

  const visible = sessions.slice(start, end)
  return {
    start,
    end,
    visible,
    hiddenBefore: start,
    hiddenAfter: total - end,
    activeIndex
  }
}
