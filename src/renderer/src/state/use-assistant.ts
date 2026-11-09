import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssistantConversationPayload,
  AssistantEventPayload,
  AssistantMessagePayload,
  AssistantNewConversationResult,
  AssistantSendResult,
  AssistantSettingsPayload,
  AssistantStatePayload
} from '../../../shared/schemas/assistant'
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
  onFocus?: (event: Extract<AssistantEventPayload, { type: 'focus' }>) => void
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
      const stateResult = await callApi<AssistantStatePayload>(window.icode.assistant.state())
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
        callApi<AssistantConversationPayload[]>(window.icode.assistant.conversations()),
        callApi<AssistantMessagePayload[]>(
          window.icode.assistant.notifications({ limit: NOTIFICATION_FEED_LIMIT })
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
          window.icode.assistant.messages({
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
          window.icode.assistant.messages({
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
    [applyHasMore, applyMessages, applySelection, notify]
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
        window.icode.assistant.messages({
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
    [applyHasMore, applyMessages, applySelection, notify]
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
      window.icode.assistant.messages({
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
  }, [applyHasMore, applyMessages, notify])

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
        window.icode.assistant.messages({
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
    [applyHasMore, applyMessages, reload]
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
      window.icode.assistant.onEvent((event) => {
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
    [focusMessage, reload]
  )

  const send = useCallback(
    async (text: string, repoId?: string): Promise<boolean> => {
      const result = await callApi<AssistantSendResult>(
        window.icode.assistant.send({ text, ...(repoId === undefined ? {} : { repoId }) })
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
    [applyHasMore, applyMessages, applySelection, notify, reload]
  )

  const stop = useCallback(async (): Promise<void> => {
    const result = await callApi<null>(window.icode.assistant.stop())
    if (!result.ok) notify(errorNotice(result.error))
    await reload()
  }, [notify, reload])

  const newConversation = useCallback(async (): Promise<boolean> => {
    followLatestRef.current = true
    const result = await callApi<AssistantNewConversationResult>(
      window.icode.assistant.newConversation()
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return false
    }
    await reload()
    return true
  }, [notify, reload])

  const markRead = useCallback(
    async (messageId?: string): Promise<void> => {
      if (threadId === null) return
      const result = await callApi<number>(
        window.icode.assistant.markRead({ threadId, ...(messageId === undefined ? {} : { messageId }) })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setUnread(result.value)
    },
    [notify, threadId]
  )

  const saveSettings = useCallback(
    async (next: AssistantSettingsPayload): Promise<void> => {
      const result = await callApi<AssistantSettingsPayload>(
        window.icode.assistant.setSettings({ settings: next })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setSettings(result.value)
      setPersonaName(result.value.personaName)
      await reload()
    },
    [notify, reload]
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
