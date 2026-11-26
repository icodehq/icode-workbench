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

export type BotsSelection =
  | { kind: 'group'; groupId: string; threadId: string }
  | { kind: 'bot'; botId: string }
  | null

export type OpenBotsTab = Exclude<BotsSelection, null>

export function botsTabKey(tab: OpenBotsTab): string {
  return tab.kind === 'group' ? `group:${tab.groupId}` : `bot:${tab.botId}`
}

export type BotsWorkspaceState = {
  groups: GroupSummaryPayload[]
  bots: BotSummaryPayload[]
  group: GroupSummaryPayload | null
  thread: GroupThreadPayload | null
  bot: BotSummaryPayload | null
  selected: BotsSelection
  openTabs: OpenBotsTab[]
  loading: boolean
  unread: number
  reload: () => Promise<void>
  selectGroup: (groupId: string, threadId?: string) => void
  selectThread: (threadId: string) => void
  selectBot: (botId: string) => void
  activateTab: (tab: OpenBotsTab) => void
  closeTab: (tab: OpenBotsTab) => void
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
  const [openTabs, setOpenTabs] = useState<OpenBotsTab[]>([])
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  const selectedRef = useRef<BotsSelection>(null)
  selectedRef.current = selected
  const openTabsRef = useRef<OpenBotsTab[]>([])
  openTabsRef.current = openTabs

  const reload = useCallback(async (): Promise<void> => {
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
    const nextGroups = groupsResult.value
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
      const firstGroup = nextGroups[0]
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
  }, [notify])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => {
      mounted.current = false
    }
  }, [reload])

  useEffect(() => {
    const unsubscribeGroups = window.icode.groups.onEvent(() => {
      void reload()
    })
    const unsubscribeBots = window.icode.bots.onEvent((event) => {
      if (event.type === 'changed' || event.event.type !== 'delta') void reload()
    })
    const unsubscribeTasks = window.icode.onTaskEvent(() => {
      void reload()
    })
    return () => {
      unsubscribeGroups()
      unsubscribeBots()
      unsubscribeTasks()
    }
  }, [reload])

  // The active selection always has an open tab; selecting an open room only
  // activates it, and a group keeps one tab while its thread changes.
  useEffect(() => {
    if (selected === null) return
    setOpenTabs((current) => {
      const key = botsTabKey(selected)
      const index = current.findIndex((tab) => botsTabKey(tab) === key)
      if (index === -1) return [...current, selected]
      if (selected.kind !== 'group') return current
      const existing = current[index]
      if (existing?.kind !== 'group' || existing.threadId === selected.threadId) return current
      return current.map((tab, position) =>
        position === index ? { ...existing, threadId: selected.threadId } : tab
      )
    })
  }, [selected])

  useEffect(() => {
    setOpenTabs((current) =>
      current.filter((tab) =>
        tab.kind === 'group'
          ? groups.some((group) => group.id === tab.groupId)
          : bots.some((bot) => bot.id === tab.botId)
      )
    )
  }, [bots, groups])

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

  const selectThread = useCallback((threadId: string): void => {
    const current = selectedRef.current
    if (current?.kind !== 'group') return
    setSelected({ kind: 'group', groupId: current.groupId, threadId })
  }, [])

  const selectBot = useCallback((botId: string): void => {
    setSelected({ kind: 'bot', botId })
  }, [])

  const activateTab = useCallback((tab: OpenBotsTab): void => {
    setSelected(tab)
  }, [])

  const closeTab = useCallback((tab: OpenBotsTab): void => {
    const current = openTabsRef.current
    const index = current.findIndex((entry) => botsTabKey(entry) === botsTabKey(tab))
    if (index === -1) return
    const next = current.filter((_, position) => position !== index)
    setOpenTabs(next)
    const active = selectedRef.current
    if (active !== null && botsTabKey(active) === botsTabKey(tab)) {
      setSelected(next[Math.min(index, next.length - 1)] ?? null)
    }
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
    [notify, reload]
  )

  const deleteGroup = useCallback(
    async (groupId: string): Promise<boolean> => {
      const result = await callApi<boolean>(window.icode.groups.remove({ groupId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
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
    openTabs,
    loading,
    unread,
    reload,
    selectGroup,
    selectThread,
    selectBot,
    activateTab,
    closeTab,
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
