import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BotRecordPayload,
  BotSummaryPayload,
  BotCreateInput,
  BotUpdateInput
} from '../../../shared/schemas/bots'
import type { AssistantSettingsPayload } from '../../../shared/schemas/assistant'
import type {
  GroupCreateInput,
  GroupSummaryPayload,
  GroupThreadPayload,
  GroupUpdateInput
} from '../../../shared/schemas/groups'
import type { Notice } from './workspace'
import { callApi, errorNotice } from '../lib/api'
import { openFilesStore } from '../files/open-files'
import { groupWorkspaceKey } from '../workspace/workspace-key'
import { mergeLocalRead } from './group-thread-read'
import { setRoomWorkspaceEmpty } from './room-workspace-empty'
import { clearWorkspaceSplit } from './use-workspace-split'

export type BotsSelection =
  | { kind: 'group'; groupId: string; threadId: string }
  | { kind: 'bot'; botId: string }
  | null

export type OpenBotsTab = Exclude<BotsSelection, null>

export type BotsWorkspaceState = {
  groups: GroupSummaryPayload[]
  bots: BotSummaryPayload[]
  group: GroupSummaryPayload | null
  thread: GroupThreadPayload | null
  bot: BotSummaryPayload | null
  selected: BotsSelection
  /** An explicit open from the sidebar or a notification, not a background refresh. */
  roomRequest: { groupId: string; threadId: string; nonce: number } | null
  /** An explicit open of one bot chat, e.g. from Session History. */
  chatRequest: { botId: string; threadId: string; nonce: number } | null
  groupHomeRead: Record<string, boolean>
  loading: boolean
  unread: number
  reload: () => Promise<void>
  openGroup: (groupId: string, threadId?: string) => void
  selectGroup: (groupId: string, threadId?: string) => void
  selectThread: (threadId: string) => void
  selectBot: (botId: string) => void
  openBotChat: (botId: string, threadId: string) => void
  groupHomeUnread: (group: GroupSummaryPayload) => number
  setGroupHomeRead: (groupId: string, read: boolean) => void
  createGroup: (input: GroupCreateInput) => Promise<GroupSummaryPayload | null>
  updateGroup: (input: GroupUpdateInput) => Promise<GroupSummaryPayload | null>
  archiveGroup: (groupId: string) => Promise<boolean>
  setGroupRead: (groupId: string, read: boolean) => Promise<number | null>
  setGroupMuted: (groupId: string, muted: boolean) => Promise<GroupSummaryPayload | null>
  deleteGroup: (groupId: string) => Promise<boolean>
  createThread: (groupId: string) => Promise<GroupThreadPayload | null>
  createBot: (input: BotCreateInput) => Promise<BotRecordPayload | null>
  updateBot: (input: BotUpdateInput) => Promise<BotRecordPayload | null>
  setPaused: (botId: string, paused: boolean) => Promise<BotRecordPayload | null>
  setBotRead: (botId: string, read: boolean) => Promise<number | null>
  setBotNotifications: (botId: string, enabled: boolean) => Promise<boolean>
  archiveBot: (botId: string) => Promise<boolean>
}

function defaultThread(group: GroupSummaryPayload): GroupThreadPayload | null {
  return group.threads.find((thread) => thread.isDefault) ?? group.threads[0] ?? null
}

const ACTIVE_GROUP_KEY = 'icode.bots.active-group.v1'

function readStoredActiveGroup(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(ACTIVE_GROUP_KEY)
    return raw !== null && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

function writeStoredActiveGroup(groupId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ACTIVE_GROUP_KEY, groupId)
  } catch {
    // A blocked storage is only a lost selection preference.
  }
}

/** A group-home read/unread toggle, independent of each room's tab markers. */
const GROUP_HOME_READ_KEY = 'icode.bots.group-home-read.v1'

function readGroupHomeRead(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(GROUP_HOME_READ_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, boolean> = {}
    for (const [groupId, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[groupId] = value
    }
    return result
  } catch {
    return {}
  }
}

function writeGroupHomeRead(value: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(GROUP_HOME_READ_KEY, JSON.stringify(value))
  } catch {
    // A blocked storage is only a lost unread preference.
  }
}

/**
 * Global bot/group state for the Bots surface.
 *
 * A group selection always carries a thread; a bot selection is its home chat.
 * Room messages/turns live in use-group-room, not here.
 */
export function useBots(notify: (notice: Notice) => void): BotsWorkspaceState {
  const [groups, setGroups] = useState<GroupSummaryPayload[]>([])
  const [bots, setBots] = useState<BotSummaryPayload[]>([])
  const [selected, setSelected] = useState<BotsSelection>(null)
  const [roomRequest, setRoomRequest] = useState<{
    groupId: string
    threadId: string
    nonce: number
  } | null>(null)
  const [chatRequest, setChatRequest] = useState<{
    botId: string
    threadId: string
    nonce: number
  } | null>(null)
  const [groupHomeRead, setGroupHomeReadState] =
    useState<Record<string, boolean>>(readGroupHomeRead)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  const selectedRef = useRef<BotsSelection>(null)
  selectedRef.current = selected
  const groupRefreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const botsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preferredGroupId = useRef<string | null>(readStoredActiveGroup())
  const readSeqByThread = useRef(new Map<string, number>())
  const groupRefreshEpoch = useRef(0)
  const groupsRef = useRef<GroupSummaryPayload[]>([])
  groupsRef.current = groups

  const setGroupHomeRead = useCallback((groupId: string, read: boolean): void => {
    setGroupHomeReadState((current) => {
      const next = { ...current, [groupId]: read }
      writeGroupHomeRead(next)
      return next
    })
  }, [])

  const clearGroupHomeRead = useCallback((groupId: string): void => {
    setGroupHomeReadState((current) => {
      if (!(groupId in current)) return current
      const next = { ...current }
      delete next[groupId]
      writeGroupHomeRead(next)
      return next
    })
  }, [])

  const groupHomeUnread = useCallback(
    (group: GroupSummaryPayload): number => {
      const override = groupHomeRead[group.id]
      if (override === true) return 0
      if (override === false) return Math.max(1, group.unread)
      return group.unread
    },
    [groupHomeRead]
  )

  /** An explicit group-wide read/unread is authoritative over this window's reads. */
  const clearReadForGroup = useCallback((groupId: string): void => {
    const group = groupsRef.current.find((entry) => entry.id === groupId)
    if (group === undefined) return
    for (const thread of group.threads) readSeqByThread.current.delete(thread.id)
  }, [])

  /** A refresh that left before a read must not raise that read's unread again. */
  const mergeThreadRead = useCallback(
    (thread: GroupThreadPayload): GroupThreadPayload =>
      mergeLocalRead(thread, readSeqByThread.current.get(thread.id)),
    []
  )

  const mergeGroupRead = useCallback(
    (group: GroupSummaryPayload): GroupSummaryPayload => {
      const threads = group.threads.map(mergeThreadRead)
      if (threads.every((thread, index) => thread === group.threads[index])) {
        return group
      }
      return {
        ...group,
        threads,
        unread: threads.reduce((total, thread) => total + thread.unread, 0)
      }
    },
    [mergeThreadRead]
  )

  const reload = useCallback(async (): Promise<void> => {
    // A full reload supersedes any per-group refresh already in flight.
    groupRefreshEpoch.current += 1
    const [groupsResult, botsResult] = await Promise.all([
      callApi<GroupSummaryPayload[]>(window.icode.groups.list()),
      callApi<BotSummaryPayload[]>(window.icode.bots.list())
    ])
    if (!mounted.current) return
    if (!groupsResult.ok) {
      notify(errorNotice(groupsResult.error))
      setLoading(false)
      return
    }
    if (!botsResult.ok) {
      notify(errorNotice(botsResult.error))
      setLoading(false)
      return
    }
    const nextGroups = groupsResult.value.map(mergeGroupRead)
    const nextBots = botsResult.value
    setGroups(nextGroups)
    setBots(nextBots)
    setSelected((current) => {
      if (current?.kind === 'group') {
        const group = nextGroups.find((entry) => entry.id === current.groupId)
        if (group !== undefined) {
          const thread =
            group.threads.find((entry) => entry.id === current.threadId) ?? defaultThread(group)
          return thread === null
            ? null
            : { kind: 'group', groupId: group.id, threadId: thread.id }
        }
      }
      if (current?.kind === 'bot') {
        if (nextBots.some((bot) => bot.id === current.botId)) return current
      }
      const firstGroup =
        nextGroups.find((group) => group.id === preferredGroupId.current) ??
        nextGroups[0]
      if (firstGroup !== undefined) {
        const thread = defaultThread(firstGroup)
        if (thread !== null) {
          return { kind: 'group', groupId: firstGroup.id, threadId: thread.id }
        }
      }
      const firstBot = nextBots[0]
      return firstBot === undefined ? null : { kind: 'bot', botId: firstBot.id }
    })
    setLoading(false)
  }, [mergeGroupRead, notify])

  /** A burst of room events costs one thread refresh per group. */
  const refreshGroupSoon = useCallback((groupId: string): void => {
    const existing = groupRefreshTimers.current.get(groupId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      groupRefreshTimers.current.delete(groupId)
      const epoch = groupRefreshEpoch.current
      void (async () => {
        const result = await callApi<GroupThreadPayload[]>(
          window.icode.groups.threads({ groupId })
        )
        if (
          !mounted.current ||
          !result.ok ||
          epoch !== groupRefreshEpoch.current
        ) {
          return
        }
        const threads = result.value.map(mergeThreadRead)
        setGroups((current) =>
          current.map((group) =>
            group.id === groupId
              ? {
                  ...group,
                  threads,
                  unread: threads.reduce(
                    (total, thread) => total + thread.unread,
                    0
                  )
                }
              : group
          )
        )
      })()
    }, 75)
    groupRefreshTimers.current.set(groupId, timer)
  }, [mergeThreadRead])

  const refreshBotsSoon = useCallback((): void => {
    if (botsRefreshTimer.current !== null) clearTimeout(botsRefreshTimer.current)
    botsRefreshTimer.current = setTimeout(() => {
      botsRefreshTimer.current = null
      void (async () => {
        const result = await callApi<BotSummaryPayload[]>(window.icode.bots.list())
        if (!mounted.current || !result.ok) return
        setBots(result.value)
      })()
    }, 75)
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => {
      mounted.current = false
      for (const timer of groupRefreshTimers.current.values()) clearTimeout(timer)
      groupRefreshTimers.current.clear()
      if (botsRefreshTimer.current !== null) {
        clearTimeout(botsRefreshTimer.current)
        botsRefreshTimer.current = null
      }
    }
  }, [reload])

  useEffect(() => {
    const unsubscribeGroups = window.icode.groups.onEvent((event) => {
      if (event.type === 'read') {
        clearGroupHomeRead(event.groupId)
        readSeqByThread.current.set(
          event.threadId,
          Math.max(readSeqByThread.current.get(event.threadId) ?? 0, event.seq)
        )
        setGroups((current) =>
          current.map((group) => {
            if (group.id !== event.groupId) return group
            const threads = group.threads.map((thread) =>
              thread.id === event.threadId
                ? {
                    ...thread,
                    lastReadSeq: Math.max(thread.lastReadSeq, event.seq),
                    unread: event.unread
                  }
                : thread
            )
            return {
              ...group,
              threads,
              unread: threads.reduce((total, thread) => total + thread.unread, 0)
            }
          })
        )
        return
      }
      clearGroupHomeRead(event.groupId)
      if (event.type === 'changed') {
        clearReadForGroup(event.groupId)
        void reload()
        return
      }
      if (event.type === 'thread') {
        // A new thread invalidates a list refresh that started before it.
        groupRefreshEpoch.current += 1
      }
      refreshGroupSoon(event.groupId)
    })
    const unsubscribeBots = window.icode.bots.onEvent((event) => {
      if (event.type === 'changed' || event.event.type !== 'delta') refreshBotsSoon()
    })
    const unsubscribeTasks = window.icode.onTaskEvent(() => refreshBotsSoon())
    return () => {
      unsubscribeGroups()
      unsubscribeBots()
      unsubscribeTasks()
    }
  }, [
    clearGroupHomeRead,
    clearReadForGroup,
    refreshBotsSoon,
    refreshGroupSoon,
    reload
  ])

  // Restore the group the owner last used, while keeping it valid.
  useEffect(() => {
    if (selected?.kind !== 'group') return
    preferredGroupId.current = selected.groupId
    writeStoredActiveGroup(selected.groupId)
  }, [selected])

  // A per-group refresh can drop a removed thread; keep the selection valid.
  useEffect(() => {
    setSelected((current) => {
      if (current?.kind !== 'group') return current
      const group = groups.find((entry) => entry.id === current.groupId)
      if (group === undefined) return null
      if (group.threads.some((thread) => thread.id === current.threadId)) return current
      const fallback = defaultThread(group)
      return fallback === null
        ? null
        : { kind: 'group', groupId: group.id, threadId: fallback.id }
    })
  }, [groups])

  const selectGroup = useCallback(
    (groupId: string, threadId?: string): void => {
      const group = groups.find((entry) => entry.id === groupId)
      if (group === undefined) return
      const thread =
        (threadId === undefined
          ? undefined
          : group.threads.find((entry) => entry.id === threadId)) ?? defaultThread(group)
      if (thread === null) return
      setSelected({ kind: 'group', groupId, threadId: thread.id })
    },
    [groups]
  )

  /** An explicit open: select the group and ask its workspace for that room. */
  const openGroup = useCallback(
    (groupId: string, threadId?: string): void => {
      const group = groups.find((entry) => entry.id === groupId)
      if (group === undefined) return
      const thread =
        (threadId === undefined
          ? undefined
          : group.threads.find((entry) => entry.id === threadId)) ?? defaultThread(group)
      if (thread === null) return
      clearGroupHomeRead(groupId)
      setSelected({ kind: 'group', groupId, threadId: thread.id })
      setRoomRequest({ groupId, threadId: thread.id, nonce: Date.now() })
    },
    [clearGroupHomeRead, groups]
  )

  const selectThread = useCallback((threadId: string): void => {
    const current = selectedRef.current
    if (current?.kind !== 'group') return
    setSelected({ kind: 'group', groupId: current.groupId, threadId })
  }, [])

  const selectBot = useCallback((botId: string): void => {
    setSelected({ kind: 'bot', botId })
  }, [])

  const openBotChat = useCallback((botId: string, threadId: string): void => {
    setSelected({ kind: 'bot', botId })
    setChatRequest({ botId, threadId, nonce: Date.now() })
  }, [])

  const createGroup = useCallback(
    async (input: GroupCreateInput): Promise<GroupSummaryPayload | null> => {
      const result = await callApi<GroupSummaryPayload>(window.icode.groups.create(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      const thread = defaultThread(result.value)
      if (thread !== null) {
        setSelected({ kind: 'group', groupId: result.value.id, threadId: thread.id })
      }
      return result.value
    },
    [notify, reload]
  )

  const updateGroup = useCallback(
    async (input: GroupUpdateInput): Promise<GroupSummaryPayload | null> => {
      const result = await callApi<GroupSummaryPayload>(window.icode.groups.update(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const archiveGroup = useCallback(
    async (groupId: string): Promise<boolean> => {
      const result = await callApi<GroupSummaryPayload>(
        window.icode.groups.archive({ groupId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return true
    },
    [notify, reload]
  )

  const setGroupMuted = useCallback(
    async (groupId: string, muted: boolean): Promise<GroupSummaryPayload | null> => {
      const result = await callApi<{ group: GroupSummaryPayload }>(
        window.icode.groups.setMuted({ groupId, muted })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value.group
    },
    [notify, reload]
  )

  const setGroupRead = useCallback(
    async (groupId: string, read: boolean): Promise<number | null> => {
      clearReadForGroup(groupId)
      const result = await callApi<{ unread: number }>(
        window.icode.groups.setRead({ groupId, read })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value.unread
    },
    [clearReadForGroup, notify, reload]
  )

  const deleteGroup = useCallback(
    async (groupId: string): Promise<boolean> => {
      const result = await callApi<boolean>(window.icode.groups.remove({ groupId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      if (result.value) {
        const scopeKey = groupWorkspaceKey(groupId)
        openFilesStore.clearScope(scopeKey)
        clearWorkspaceSplit(scopeKey)
        setRoomWorkspaceEmpty(scopeKey, false)
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const createThread = useCallback(
    async (groupId: string): Promise<GroupThreadPayload | null> => {
      const result = await callApi<{ thread: GroupThreadPayload }>(
        window.icode.groups.threadCreate({ groupId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      setSelected({ kind: 'group', groupId, threadId: result.value.thread.id })
      setRoomRequest({
        groupId,
        threadId: result.value.thread.id,
        nonce: Date.now()
      })
      return result.value.thread
    },
    [notify, reload]
  )

  const createBot = useCallback(
    async (input: BotCreateInput): Promise<BotRecordPayload | null> => {      const result = await callApi<BotRecordPayload>(window.icode.bots.create(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      setSelected({ kind: 'bot', botId: result.value.id })
      return result.value
    },
    [notify, reload]
  )

  const updateBot = useCallback(
    async (input: BotUpdateInput): Promise<BotRecordPayload | null> => {
      const result = await callApi<BotRecordPayload>(window.icode.bots.update(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const setPaused = useCallback(
    async (botId: string, paused: boolean): Promise<BotRecordPayload | null> => {
      const result = await callApi<BotRecordPayload>(
        window.icode.bots.setPaused({ botId, paused })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const setBotRead = useCallback(
    async (botId: string, read: boolean): Promise<number | null> => {
      const result = await callApi<number>(
        window.icode.bots.markRead({ botId, read })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const setBotNotifications = useCallback(
    async (botId: string, enabled: boolean): Promise<boolean> => {
      const loaded = await callApi<AssistantSettingsPayload>(
        window.icode.bots.settings({ botId })
      )
      if (!loaded.ok) {
        notify(errorNotice(loaded.error))
        return false
      }
      const saved = await callApi<AssistantSettingsPayload>(
        window.icode.bots.setSettings({
          botId,
          settings: {
            ...loaded.value,
            notifications: { ...loaded.value.notifications, enabled }
          }
        })
      )
      if (!saved.ok) {
        notify(errorNotice(saved.error))
        return false
      }
      await reload()
      return true
    },
    [notify, reload]
  )

  const archiveBot = useCallback(
    async (botId: string): Promise<boolean> => {
      const result = await callApi<boolean>(window.icode.bots.archive({ botId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const group =
    selected?.kind === 'group'
      ? (groups.find((entry) => entry.id === selected.groupId) ?? null)
      : null
  const thread =
    group !== null && selected?.kind === 'group'
      ? (group.threads.find((entry) => entry.id === selected.threadId) ?? null)
      : null
  const bot =
    selected?.kind === 'bot'
      ? (bots.find((entry) => entry.id === selected.botId) ?? null)
      : null
  const unread =
    groups.reduce((total, entry) => total + entry.unread, 0) +
    bots.reduce((total, entry) => total + entry.unread, 0)

  return {
    groups,
    bots,
    group,
    thread,
    bot,
    selected,
    roomRequest,
    chatRequest,
    groupHomeRead,
    loading,
    unread,
    reload,
    openGroup,
    selectGroup,
    selectThread,
    selectBot,
    openBotChat,
    groupHomeUnread,
    setGroupHomeRead,
    createGroup,
    updateGroup,
    archiveGroup,
    deleteGroup,
    setGroupRead,
    setGroupMuted,
    createThread,
    createBot,
    updateBot,
    setPaused,
    setBotRead,
    setBotNotifications,
    archiveBot
  }
}
