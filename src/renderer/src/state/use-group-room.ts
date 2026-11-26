import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GroupMessagesResult,
  GroupMessageWithTurnsPayload,
  GroupSendResult,
  GroupTurnPayload
} from '../../../shared/schemas/groups'
import type { Notice } from './workspace'
import { callApi, errorNotice } from '../lib/api'

export type GroupRoomState = {
  messages: GroupMessageWithTurnsPayload[]
  hasEarlier: boolean
  loading: boolean
  loadingEarlier: boolean
  sending: boolean
  busy: boolean
  reload: () => Promise<void>
  loadEarlier: () => Promise<void>
  send: (text: string) => Promise<boolean>
  stop: (botId?: string) => Promise<void>
}

/**
 * Group events may carry a message without its turns (a system notice, or the
 * owner message before its turns are scheduled). The room always needs an
 * array, and a later turn-less event must not erase turns already on screen.
 */
function mergeMessage(
  messages: GroupMessageWithTurnsPayload[],
  incoming: GroupMessageWithTurnsPayload
): GroupMessageWithTurnsPayload[] {
  const existing = messages.find((message) => message.id === incoming.id)
  const incomingTurns = Array.isArray(incoming.turns) ? incoming.turns : []
  const normalized = {
    ...incoming,
    turns:
      incomingTurns.length === 0 && existing !== undefined && existing.turns.length > 0
        ? existing.turns
        : incomingTurns
  }
  const next = existing !== undefined
    ? messages.map((message) => (message.id === incoming.id ? normalized : message))
    : [...messages, normalized]
  return next.sort((left, right) => left.seq - right.seq)
}

function mergeTurn(
  turns: GroupTurnPayload[],
  incoming: GroupTurnPayload
): GroupTurnPayload[] {
  return turns.some((turn) => turn.operationId === incoming.operationId)
    ? turns.map((turn) => (turn.operationId === incoming.operationId ? incoming : turn))
    : [...turns, incoming]
}

/** One group thread's transcript, kept live from group events. */
export function useGroupRoom(
  groupId: string,
  threadId: string,
  notify: (notice: Notice) => void
): GroupRoomState {
  const [messages, setMessages] = useState<GroupMessageWithTurnsPayload[]>([])
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [sending, setSending] = useState(false)
  const messagesRef = useRef<GroupMessageWithTurnsPayload[]>([])
  const threadRef = useRef(threadId)
  threadRef.current = threadId
  messagesRef.current = messages

  const markRead = useCallback((seq: number): void => {
    if (seq <= 0) return
    void window.icode.groups
      .markRead({ threadId, seq })
      .catch(() => undefined)
  }, [threadId])

  const reload = useCallback(async (): Promise<void> => {
    const result = await callApi<GroupMessagesResult>(
      window.icode.groups.messages({ threadId, limit: 60 })
    )
    if (threadRef.current !== threadId) return
    if (!result.ok) {
      notify(errorNotice(result.error))
      setLoading(false)
      return
    }
    setMessages(result.value.messages)
    setHasEarlier(result.value.hasEarlier)
    setLoading(false)
    const latest = result.value.messages.at(-1)
    if (latest !== undefined) markRead(latest.seq)
  }, [markRead, notify, threadId])

  useEffect(() => {
    setLoading(true)
    setMessages([])
    setHasEarlier(false)
    void reload()
    const unsubscribe = window.icode.groups.onEvent((event) => {
      if (event.groupId !== groupId) return
      if (event.type === 'message') {
        if (event.message.threadId !== threadRef.current) return
        setMessages((current) => mergeMessage(current, event.message))
        markRead(event.message.seq)
        return
      }
      if (event.type === 'turn') {
        if (event.turn.threadId !== threadRef.current) return
        if (
          !messagesRef.current.some((message) => message.id === event.turn.messageId)
        ) {
          void reload()
          return
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === event.turn.messageId
              ? { ...message, turns: mergeTurn(message.turns ?? [], event.turn) }
              : message
          )
        )
        return
      }
      if (event.type === 'thread' && event.threadId === threadRef.current) {
        void reload()
      }
    })
    return unsubscribe
  }, [groupId, markRead, reload])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const body = text.trim()
      if (body.length === 0 || sending) return false
      setSending(true)
      const result = await callApi<GroupSendResult>(
        window.icode.groups.send({ groupId, threadId, text: body })
      )
      setSending(false)
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      setMessages((current) => mergeMessage(current, result.value.message))
      return true
    },
    [groupId, notify, sending, threadId]
  )

  const stop = useCallback(
    async (botId?: string): Promise<void> => {
      const result = await callApi<{ turns: GroupTurnPayload[] }>(
        window.icode.groups.stop({
          groupId,
          threadId,
          ...(botId === undefined ? {} : { botId })
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      const stopped = new Map(
        result.value.turns.map((turn) => [turn.operationId, turn] as const)
      )
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          turns: message.turns.map((turn) => stopped.get(turn.operationId) ?? turn)
        }))
      )
    },
    [groupId, notify, threadId]
  )

  const loadEarlier = useCallback(async (): Promise<void> => {
    const first = messagesRef.current[0]
    if (first === undefined || loadingEarlier || !hasEarlier) return
    setLoadingEarlier(true)
    const result = await callApi<GroupMessagesResult>(
      window.icode.groups.messages({ threadId, beforeSeq: first.seq, limit: 60 })
    )
    setLoadingEarlier(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setHasEarlier(result.value.hasEarlier)
    setMessages((current) => {
      let next = current
      for (const message of result.value.messages) next = mergeMessage(next, message)
      return next
    })
  }, [hasEarlier, loadingEarlier, notify, threadId])

  const busy = messages.some((message) =>
    (message.turns ?? []).some(
      (turn) => turn.status === 'queued' || turn.status === 'working'
    )
  )

  return {
    messages,
    hasEarlier,
    loading,
    loadingEarlier,
    sending,
    busy,
    reload,
    loadEarlier,
    send,
    stop
  }
}
