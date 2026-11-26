import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ItemPayload,
  ItemsAnswerInput,
  ItemsAttachInput,
  ItemsLinkAddInput,
  ItemsListResult,
  TaskAttachmentPayload,
  TaskCommentPayload,
  TaskLinkPayload
} from '../../../shared/schemas/items'
import type { ItemStatus } from '../../../shared/domain/item'
import type { Notice } from './workspace'
import { callApi, errorNotice } from '../lib/api'

export type ItemsFilter = {
  repoId?: string
  groupId?: string
  botId?: string
  includeArchived?: boolean
}

export type ItemsState = {
  items: ItemPayload[]
  counts: ItemsListResult['counts']
  loading: boolean
  reload: () => Promise<void>
  comment: (taskId: string, body: string) => Promise<boolean>
  answer: (taskId: string, commentId: string, body: string) => Promise<boolean>
  snooze: (taskId: string, until: number | null) => Promise<boolean>
  setStatus: (taskId: string, status: ItemStatus | null) => Promise<boolean>
  linkAdd: (input: ItemsLinkAddInput) => Promise<TaskLinkPayload | null>
  attach: (input: ItemsAttachInput) => Promise<TaskAttachmentPayload | null>
  removeAttachment: (taskId: string, id: string) => Promise<boolean>
  linkRemove: (input: ItemsLinkAddInput) => Promise<boolean>
}

const EMPTY_COUNTS: ItemsListResult['counts'] = {
  planned: 0,
  working: 0,
  waiting: 0,
  needs_you: 0,
  done: 0,
  canceled: 0
}

/** Items for one group or bot, refreshed from the task-change event. */
export function useItems(
  filter: ItemsFilter,
  notify: (notice: Notice) => void
): ItemsState {
  const [items, setItems] = useState<ItemPayload[]>([])
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  const { repoId, groupId, botId, includeArchived } = filter

  const reload = useCallback(async (): Promise<void> => {
    const result = await callApi<ItemsListResult>(
      window.icode.items.list({
        ...(repoId === undefined ? {} : { repoId }),
        ...(groupId === undefined ? {} : { groupId }),
        ...(botId === undefined ? {} : { botId }),
        ...(includeArchived === true ? { includeArchived: true } : {})
      })
    )
    if (!mounted.current) return
    if (!result.ok) {
      notify(errorNotice(result.error))
      setLoading(false)
      return
    }
    setItems(result.value.items)
    setCounts(result.value.counts)
    setLoading(false)
  }, [botId, groupId, includeArchived, notify, repoId])

  useEffect(() => {
    mounted.current = true
    setLoading(true)
    void reload()
    return () => {
      mounted.current = false
    }
  }, [reload])

  useEffect(() => {
    return window.icode.onTaskEvent(() => {
      void reload()
    })
  }, [reload])

  const comment = useCallback(
    async (taskId: string, body: string): Promise<boolean> => {
      const result = await callApi<TaskCommentPayload>(
        window.icode.items.comment({ taskId, body })
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

  const answer = useCallback(
    async (taskId: string, commentId: string, body: string): Promise<boolean> => {
      const input: ItemsAnswerInput = { taskId, commentId, body }
      const result = await callApi(window.icode.items.answer(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return true
    },
    [notify, reload]
  )

  const snooze = useCallback(
    async (taskId: string, until: number | null): Promise<boolean> => {
      const result = await callApi(window.icode.items.snooze({ taskId, until }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return true
    },
    [notify, reload]
  )

  const setStatus = useCallback(
    async (taskId: string, status: ItemStatus | null): Promise<boolean> => {
      const result = await callApi(window.icode.items.setStatus({ taskId, status }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return true
    },
    [notify, reload]
  )

  const attach = useCallback(
    async (input: ItemsAttachInput): Promise<TaskAttachmentPayload | null> => {
      const result = await callApi<TaskAttachmentPayload>(window.icode.items.attach(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const removeAttachment = useCallback(
    async (taskId: string, id: string): Promise<boolean> => {
      const result = await callApi<boolean>(
        window.icode.items.removeAttachment({ taskId, id })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const linkAdd = useCallback(
    async (input: ItemsLinkAddInput): Promise<TaskLinkPayload | null> => {
      const result = await callApi<TaskLinkPayload>(window.icode.items.linkAdd(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return null
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  const linkRemove = useCallback(
    async (input: ItemsLinkAddInput): Promise<boolean> => {
      const result = await callApi<boolean>(window.icode.items.linkRemove(input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  return {
    items,
    counts,
    loading,
    reload,
    comment,
    answer,
    snooze,
    setStatus,
    linkAdd,
    linkRemove,
    attach,
    removeAttachment
  }
}
