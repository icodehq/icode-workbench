import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssistantConversationPayload,
  AssistantEventPayload,
  AssistantMessagePayload,
  AssistantNewConversationResult,
  AssistantSendResult,
  AssistantSettingsPayload,
  AssistantStatePayload
} from '../../../shared/schemas/assistant'
import type { IpcResult } from '../../../shared/schemas/ipc'
import type { AssistantRunStage } from '../../../shared/domain/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../../shared/domain/assistant'
import type { Notice } from './workspace'
import { callApi, errorNotice } from '../lib/api'
import {
  computeHasMore,
  defaultConversationId,
  mergeNewest,
  MESSAGE_PAGE_SIZE,
  NOTIFICATION_FEED_LIMIT,
  prependOlder
} from './assistant-transcript'

export type AssistantLive = {
  runId: string
  stage: AssistantRunStage
  harness: string | null
  target: string | null
  round: number
  thinkingTokens: number | null
  startedAt: number
  /** The decoded `reply` prefix; empty until the model starts writing it. */
  draft: string
}

export type AssistantState = {
  threadId: string | null
  personaName: string
  unread: number
  status: AssistantStatePayload['status']
  harness: string | null
  target: string | null
  settings: AssistantSettingsPayload
  messages: AssistantMessagePayload[]
  notifications: AssistantMessagePayload[]
  conversations: AssistantConversationPayload[]
  selectedConversationId: string | null
  latestConversationId: string | null
  hasMore: boolean
  loadingOlder: boolean
  live: AssistantLive | null
  loading: boolean
  reload: (announce?: boolean) => Promise<void>
  send: (text: string, repoId?: string) => Promise<boolean>
  stop: () => Promise<void>
  newConversation: () => Promise<boolean>
  selectConversation: (conversationId: string) => Promise<void>
  loadOlder: () => Promise<boolean>
  markRead: (messageId?: string) => Promise<void>
  saveSettings: (settings: AssistantSettingsPayload) => Promise<void>
}

/**
 * The chat transport the state machine runs on.
 *
 * Mira and bots share the same conversation semantics; only their IPC
 * namespace differs. Keeping the transport here means one hook, one paging
 * implementation and one streaming path for both.
 */
export type ChatClient = {
  state: () => Promise<IpcResult<AssistantStatePayload>>
  messages: (input: {
    threadId: string
    beforeSeq?: number
    limit?: number
    conversationId?: string
  }) => Promise<IpcResult<AssistantMessagePayload[]>>
  conversations: () => Promise<IpcResult<AssistantConversationPayload[]>>
  notifications: (input: { limit?: number }) => Promise<IpcResult<AssistantMessagePayload[]>>
  focus: (input: { messageId: string }) => Promise<IpcResult<null>>
  send: (input: { text: string; repoId?: string }) => Promise<IpcResult<AssistantSendResult>>
  markRead: (input: {
    threadId: string
    messageId?: string
  }) => Promise<IpcResult<number>>
  stop: () => Promise<IpcResult<null>>
  newConversation: () => Promise<IpcResult<AssistantNewConversationResult>>
  settings: () => Promise<IpcResult<AssistantSettingsPayload>>
  setSettings: (input: {
    settings: AssistantSettingsPayload
  }) => Promise<IpcResult<AssistantSettingsPayload>>
  onEvent: (listener: (event: AssistantEventPayload) => void) => () => void
}

const miraChatClient: ChatClient = {
  state: () => window.icode.assistant.state(),
  messages: (input) => window.icode.assistant.messages(input),
  conversations: () => window.icode.assistant.conversations(),
  notifications: (input) => window.icode.assistant.notifications(input),
  focus: (input) => window.icode.assistant.focus(input),
  send: (input) => window.icode.assistant.send(input),
  markRead: (input) => window.icode.assistant.markRead(input),
  stop: () => window.icode.assistant.stop(),
  newConversation: () => window.icode.assistant.newConversation(),
  settings: () => window.icode.assistant.settings(),
  setSettings: (input) => window.icode.assistant.setSettings(input),
  onEvent: (listener) => window.icode.assistant.onEvent(listener)
}

function botChatClient(botId: string): ChatClient {
  return {
    state: () => window.icode.bots.state({ botId }),
    messages: (input) =>
      window.icode.bots.messages({
        botId,
        ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId })
      }),
    conversations: () => window.icode.bots.conversations({ botId }),
    notifications: (input) =>
      window.icode.bots.notifications({
        botId,
        ...(input.limit === undefined ? {} : { limit: input.limit })
      }),
    focus: (input) => window.icode.bots.focus({ botId, messageId: input.messageId }),
    send: (input) =>
      window.icode.bots.send({
        botId,
        text: input.text,
        ...(input.repoId === undefined ? {} : { repoId: input.repoId })
      }),
    markRead: (input) =>
      window.icode.bots.markRead({
        botId,
        ...(input.messageId === undefined ? {} : { messageId: input.messageId })
      }),
    stop: () => window.icode.bots.stop({ botId }),
    newConversation: () => window.icode.bots.newConversation({ botId }),
    settings: () => window.icode.bots.settings({ botId }),
    setSettings: (input) =>
      window.icode.bots.setSettings({ botId, settings: input.settings }),
    onEvent: (listener) =>
      window.icode.bots.onEvent((event) => {
        if (event.type === 'chat') {
          if (event.botId === botId) listener(event.event)
          return
        }
        // A roster change can rename or re-configure this bot; re-read state
        // so the chat header and placeholders follow the new name.
        if (event.botId === null || event.botId === botId) listener({ type: 'changed' })
      })
  }
}

/**
 * The global Mira thread, shared by the rail, the assistant page and the
 * notification surface. It is deliberately outside WorkspaceState: a repository
 * refresh must not reset the conversation.
 *
 * The transcript is segmented by native conversation. The newest segment is
 * followed by default; an older segment can be selected for reading. Only the
 * latest segment appends live progress and auto-marks read.
 */
export function useAssistant(
  notify: (notice: Notice) => void,
  onFocus?: (event: Extract<AssistantEventPayload, { type: 'focus' }>) => void,
  client: ChatClient = miraChatClient
): AssistantState {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [personaName, setPersonaName] = useState(DEFAULT_ASSISTANT_SETTINGS.personaName)
  const [unread, setUnread] = useState(0)
  const [status, setStatus] = useState<AssistantStatePayload['status']>('offline')
  const [harness, setHarness] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [settings, setSettings] = useState<AssistantSettingsPayload>(
    DEFAULT_ASSISTANT_SETTINGS
  )
  const [messages, setMessages] = useState<AssistantMessagePayload[]>([])
  const [notifications, setNotifications] = useState<AssistantMessagePayload[]>([])
  const [conversations, setConversations] = useState<AssistantConversationPayload[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [latestConversationId, setLatestConversationId] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [live, setLive] = useState<AssistantLive | null>(null)
  const [loading, setLoading] = useState(true)

  const mounted = useRef(true)
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus

  const threadIdRef = useRef<string | null>(null)
  const messagesRef = useRef<AssistantMessagePayload[]>([])
  const conversationsRef = useRef<AssistantConversationPayload[]>([])
  const selectionRef = useRef<string | null>(null)
  const latestRef = useRef<string | null>(null)
  const hasMoreRef = useRef(false)
  const loadingOlderRef = useRef(false)
  const followLatestRef = useRef(true)
  const reloadGenerationRef = useRef(0)
  const selectionGenerationRef = useRef(0)

  const applyMessages = useCallback((next: AssistantMessagePayload[]): void => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const applyHasMore = useCallback((next: boolean): void => {
    hasMoreRef.current = next
    setHasMore(next)
  }, [])

  const applySelection = useCallback((next: string | null): void => {
    selectionRef.current = next
    setSelectedConversationId(next)
  }, [])

  const reload = useCallback(
    async (announce = false): Promise<void> => {
      const generation = ++reloadGenerationRef.current
      const stateResult = await callApi<AssistantStatePayload>(client.state())
      if (!mounted.current || generation !== reloadGenerationRef.current) return
      if (!stateResult.ok) {
        setLoading(false)
        if (announce) notify(errorNotice(stateResult.error))
        return
      }
      const next = stateResult.value
      threadIdRef.current = next.threadId
      setThreadId(next.threadId)
      setPersonaName(next.personaName)
      setUnread(next.unread)
      setStatus(next.status)
      setHarness(next.harness)
      setTarget(next.target)
      setSettings(next.settings)
      setLive((current) =>
        next.activeRun === null
          ? null
          : {
              runId: next.activeRun.id,
              stage: next.activeRun.stage,
              harness: next.activeRun.harness,
              target: next.activeRun.target,
              round: next.activeRun.round,
              thinkingTokens: next.activeRun.thinkingTokens,
              startedAt: next.activeRun.startedAt,
              draft: current?.runId === next.activeRun.id ? current.draft : ''
            }
      )

      const [conversationsResult, notificationsResult] = await Promise.all([
        callApi<AssistantConversationPayload[]>(client.conversations()),
        callApi<AssistantMessagePayload[]>(
          client.notifications({ limit: NOTIFICATION_FEED_LIMIT })
        )
      ])
      if (!mounted.current || generation !== reloadGenerationRef.current) return
      const nextConversations = conversationsResult.ok
        ? conversationsResult.value
        : conversationsRef.current
      conversationsRef.current = nextConversations
      setConversations(nextConversations)
      if (notificationsResult.ok) setNotifications(notificationsResult.value)
      else if (announce) notify(errorNotice(notificationsResult.error))

      const latest = defaultConversationId(nextConversations)
      latestRef.current = latest
      setLatestConversationId(latest)

      let selection = selectionRef.current
      if (
        selection === null ||
        followLatestRef.current ||
        !nextConversations.some((conversation) => conversation.id === selection)
      ) {
        selection = latest
      }
      applySelection(selection)
      if (next.status !== 'working') followLatestRef.current = false

      if (selection === null) {
        const result = await callApi<AssistantMessagePayload[]>(
          client.messages({
            threadId: next.threadId,
            limit: MESSAGE_PAGE_SIZE
          })
        )
        if (!mounted.current || generation !== reloadGenerationRef.current) return
        if (!result.ok) {
          if (announce) notify(errorNotice(result.error))
          setLoading(false)
          return
        }
        applyMessages(mergeNewest(messagesRef.current, result.value))
        applyHasMore(false)
      } else if (selection === latest) {
        const conversation =
          nextConversations.find((entry) => entry.id === selection) ?? null
        const result = await callApi<AssistantMessagePayload[]>(
          client.messages({
            threadId: next.threadId,
            conversationId: selection,
            limit: MESSAGE_PAGE_SIZE
          })
        )
        if (!mounted.current || generation !== reloadGenerationRef.current) return
        if (!result.ok) {
          if (announce) notify(errorNotice(result.error))
          setLoading(false)
          return
        }
        const merged = mergeNewest(messagesRef.current, result.value)
        applyMessages(merged)
        applyHasMore(
          computeHasMore(merged, conversation, result.value.length === MESSAGE_PAGE_SIZE)
        )
      }
      setLoading(false)
    },
    [applyHasMore, applyMessages, applySelection, client, notify]
  )

  const selectConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      const thread = threadIdRef.current
      if (thread === null) return
      const generation = ++selectionGenerationRef.current
      followLatestRef.current = false
      applySelection(conversationId)
      applyMessages([])
      applyHasMore(false)
      const conversation =
        conversationsRef.current.find((entry) => entry.id === conversationId) ?? null
      const result = await callApi<AssistantMessagePayload[]>(
        client.messages({
          threadId: thread,
          conversationId,
          limit: MESSAGE_PAGE_SIZE
        })
      )
      if (!mounted.current || generation !== selectionGenerationRef.current) return
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      applyMessages(mergeNewest([], result.value))
      applyHasMore(
        computeHasMore(result.value, conversation, result.value.length === MESSAGE_PAGE_SIZE)
      )
    },
    [applyHasMore, applyMessages, applySelection, client, notify]
  )

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const thread = threadIdRef.current
    const selection = selectionRef.current
    const first = messagesRef.current[0]
    if (
      thread === null ||
      selection === null ||
      first === undefined ||
      !hasMoreRef.current ||
      loadingOlderRef.current
    ) {
      return false
    }
    loadingOlderRef.current = true
    setLoadingOlder(true)
    const generation = selectionGenerationRef.current
    const conversation =
      conversationsRef.current.find((entry) => entry.id === selection) ?? null
    const result = await callApi<AssistantMessagePayload[]>(
      client.messages({
        threadId: thread,
        conversationId: selection,
        beforeSeq: first.seq,
        limit: MESSAGE_PAGE_SIZE
      })
    )
    loadingOlderRef.current = false
    if (mounted.current) setLoadingOlder(false)
    if (!mounted.current || generation !== selectionGenerationRef.current) return false
    if (!result.ok) {
      notify(errorNotice(result.error))
      return false
    }
    const merged = prependOlder(messagesRef.current, result.value)
    applyMessages(merged)
    applyHasMore(
      computeHasMore(merged, conversation, result.value.length === MESSAGE_PAGE_SIZE)
    )
    return result.value.length > 0
  }, [applyHasMore, applyMessages, client, notify])

  const focusMessage = useCallback(
    async (event: Extract<AssistantEventPayload, { type: 'focus' }>): Promise<void> => {
      followLatestRef.current = false
      const conversationId = event.conversationId
      if (conversationId !== null) {
        selectionRef.current = conversationId
        setSelectedConversationId(conversationId)
      }
      await reload()
      if (
        conversationId === null ||
        event.seq === null ||
        threadIdRef.current === null
      ) {
        onFocusRef.current?.(event)
        return
      }
      const generation = ++selectionGenerationRef.current
      const conversation =
        conversationsRef.current.find((entry) => entry.id === conversationId) ?? null
      const result = await callApi<AssistantMessagePayload[]>(
        client.messages({
          threadId: threadIdRef.current,
          conversationId,
          beforeSeq: event.seq + MESSAGE_PAGE_SIZE,
          limit: MESSAGE_PAGE_SIZE
        })
      )
      if (!mounted.current || generation !== selectionGenerationRef.current) return
      if (result.ok) {
        applyMessages(mergeNewest([], result.value))
        applyHasMore(
          computeHasMore(result.value, conversation, result.value.length === MESSAGE_PAGE_SIZE)
        )
      }
      onFocusRef.current?.(event)
    },
    [applyHasMore, applyMessages, client, reload]
  )

  useEffect(() => {
    mounted.current = true
    void reload(true)
    return () => {
      mounted.current = false
    }
  }, [reload])

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.type === 'focus') {
          void focusMessage(event)
          return
        }
        if (event.type === 'status') {
          setStatus(event.status)
          if (event.status !== 'working') setLive(null)
          return
        }
        if (event.type === 'run') {
          setLive((current) => ({
            runId: event.runId,
            stage: event.stage,
            harness: event.harness,
            target: event.target,
            round: event.round,
            thinkingTokens: event.thinkingTokens,
            startedAt: event.startedAt,
            draft: current?.runId === event.runId ? current.draft : ''
          }))
          return
        }
        if (event.type === 'delta') {
          setLive((current) =>
            current === null || current.runId !== event.runId
              ? current
              : { ...current, draft: event.text }
          )
          return
        }
        void reload()
      }),
    [client, focusMessage, reload]
  )

  const send = useCallback(
    async (text: string, repoId?: string): Promise<boolean> => {
      const result = await callApi<AssistantSendResult>(
        client.send({ text, ...(repoId === undefined ? {} : { repoId }) })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      followLatestRef.current = true
      const latest = latestRef.current
      if (latest !== null && selectionRef.current !== latest) {
        applySelection(latest)
        applyMessages([])
        applyHasMore(false)
      }
      applyMessages(mergeNewest(messagesRef.current, [result.value.message]))
      setStatus('working')
      await reload()
      return true
    },
    [applyHasMore, applyMessages, applySelection, client, notify, reload]
  )

  const stop = useCallback(async (): Promise<void> => {
    const result = await callApi<null>(client.stop())
    if (!result.ok) notify(errorNotice(result.error))
    await reload()
  }, [client, notify, reload])

  const newConversation = useCallback(async (): Promise<boolean> => {
    followLatestRef.current = true
    const result = await callApi<AssistantNewConversationResult>(
      client.newConversation()
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return false
    }
    await reload()
    return true
  }, [client, notify, reload])

  const markRead = useCallback(
    async (messageId?: string): Promise<void> => {
      if (threadId === null) return
      const result = await callApi<number>(
        client.markRead({ threadId, ...(messageId === undefined ? {} : { messageId }) })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setUnread(result.value)
    },
    [client, notify, threadId]
  )

  const saveSettings = useCallback(
    async (next: AssistantSettingsPayload): Promise<void> => {
      const result = await callApi<AssistantSettingsPayload>(
        client.setSettings({ settings: next })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setSettings(result.value)
      setPersonaName(result.value.personaName)
      await reload()
    },
    [client, notify, reload]
  )

  return {
    threadId,
    personaName,
    unread,
    status,
    harness,
    target,
    settings,
    messages,
    notifications,
    conversations,
    selectedConversationId,
    latestConversationId,
    hasMore,
    loadingOlder,
    live,
    loading,
    reload,
    send,
    stop,
    newConversation,
    selectConversation,
    loadOlder,
    markRead,
    saveSettings
  }
}

/** The same chat state machine, talking to one bot's IPC namespace. */
export function useBotChat(
  botId: string,
  notify: (notice: Notice) => void,
  onFocus?: (event: Extract<AssistantEventPayload, { type: 'focus' }>) => void
): AssistantState {
  const client = useMemo(() => botChatClient(botId), [botId])
  return useAssistant(notify, onFocus, client)
}
