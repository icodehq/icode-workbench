import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssistantEventPayload,
  AssistantMessagePayload,
  AssistantSendResult,
  AssistantSettingsPayload,
  AssistantStatePayload
} from '../../../shared/schemas/assistant'
import type { AssistantRunStage } from '../../../shared/domain/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../../shared/domain/assistant'
import type { Notice } from './workspace'
import { callApi, errorNotice } from '../lib/api'

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
  live: AssistantLive | null
  loading: boolean
  reload: (announce?: boolean) => Promise<void>
  send: (text: string, repoId?: string) => Promise<boolean>
  stop: () => Promise<void>
  markRead: (messageId?: string) => Promise<void>
  saveSettings: (settings: AssistantSettingsPayload) => Promise<void>
}

/**
 * The global Mira thread, shared by the rail, the assistant page and the
 * notification surface. It is deliberately outside WorkspaceState: a repository
 * refresh must not reset the conversation.
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
  const [live, setLive] = useState<AssistantLive | null>(null)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus

  const reload = useCallback(
    async (announce = false): Promise<void> => {
      const stateResult = await callApi<AssistantStatePayload>(window.icode.assistant.state())
      if (!mounted.current) return
      if (!stateResult.ok) {
        setLoading(false)
        if (announce) notify(errorNotice(stateResult.error))
        return
      }
      const next = stateResult.value
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
      const messagesResult = await callApi<AssistantMessagePayload[]>(
        window.icode.assistant.messages({ threadId: next.threadId, limit: 100 })
      )
      if (!mounted.current) return
      if (messagesResult.ok) setMessages(messagesResult.value)
      else if (announce) notify(errorNotice(messagesResult.error))
      setLoading(false)
    },
    [notify]
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
          void reload()
          onFocusRef.current?.(event)
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
    [reload]
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
      setMessages((current) =>
        current.some((message) => message.id === result.value.message.id)
          ? current
          : [...current, result.value.message]
      )
      setStatus('working')
      await reload()
      return true
    },
    [notify, reload]
  )

  const stop = useCallback(async (): Promise<void> => {
    const result = await callApi<null>(window.icode.assistant.stop())
    if (!result.ok) notify(errorNotice(result.error))
    await reload()
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
    live,
    loading,
    reload,
    send,
    stop,
    markRead,
    saveSettings
  }
}
