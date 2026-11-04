import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskRecordPayload, TaskSchedulePayload } from '../../../shared/ade-api'
import { callApi, errorNotice } from '../lib/api'
import type { Notice } from '../state/workspace'

export type TaskQueue = {
  tasks: TaskRecordPayload[]
  schedules: TaskSchedulePayload[]
  maxConcurrent: number
  loading: boolean
  reload: (announce?: boolean) => Promise<void>
  setMaxConcurrent: (value: number) => Promise<void>
}

/**
 * The durable queue, read once by the shell and shared by the wall, the project
 * header, the bell and the focused project views.
 *
 * Views still re-read after their own mutations. The task event is the backstop:
 * a task can change because the dispatcher, a schedule or another window acted,
 * and none of those run through this component.
 */
export function useTaskQueue(notify: (notice: Notice) => void): TaskQueue {
  const [tasks, setTasks] = useState<TaskRecordPayload[]>([])
  const [schedules, setSchedules] = useState<TaskSchedulePayload[]>([])
  const [maxConcurrent, setMaxConcurrentValue] = useState(1)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const reload = useCallback(
    async (announce = false): Promise<void> => {
      const [tasksResult, schedulesResult, settingsResult] = await Promise.all([
        callApi<TaskRecordPayload[]>(window.ade.tasks.list({ limit: 200 })),
        callApi<TaskSchedulePayload[]>(window.ade.schedules.list({})),
        callApi<{ maxConcurrent: number }>(window.ade.tasks.settings())
      ])
      if (!mounted.current) return
      if (tasksResult.ok) setTasks(tasksResult.value)
      else if (announce) notify(errorNotice(tasksResult.error))
      if (schedulesResult.ok) setSchedules(schedulesResult.value)
      else if (announce) notify(errorNotice(schedulesResult.error))
      if (settingsResult.ok) setMaxConcurrentValue(settingsResult.value.maxConcurrent)
      else if (announce) notify(errorNotice(settingsResult.error))
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

  useEffect(() => window.ade.onTaskEvent(() => void reload()), [reload])

  const setMaxConcurrent = useCallback(
    async (value: number): Promise<void> => {
      const result = await callApi<number>(window.ade.tasks.setSettings({ maxConcurrent: value }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setMaxConcurrentValue(result.value)
      await reload()
    },
    [notify, reload]
  )

  return {
    tasks,
    schedules,
    maxConcurrent,
    loading,
    reload,
    setMaxConcurrent
  }
}
