import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TaskRecordPayload,
  TaskSchedulePayload,
  TaskSettingsPayload
} from '../../../shared/icode-api'
import { callApi, errorNotice } from '../lib/api'
import type { Notice } from '../state/workspace'

export type TaskQueue = {
  tasks: TaskRecordPayload[]
  /** Terminal tasks hidden from the working list; History reads these. */
  archivedTasks: TaskRecordPayload[]
  schedules: TaskSchedulePayload[]
  maxConcurrent: number
  maxConcurrentPerProject: number
  loading: boolean
  reload: (announce?: boolean) => Promise<void>
  setMaxConcurrent: (value: number) => Promise<void>
  setMaxConcurrentPerProject: (value: number) => Promise<void>
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
  const [archivedTasks, setArchivedTasks] = useState<TaskRecordPayload[]>([])
  const [schedules, setSchedules] = useState<TaskSchedulePayload[]>([])
  const [maxConcurrent, setMaxConcurrentValue] = useState(1)
  const [maxConcurrentPerProject, setMaxConcurrentPerProjectValue] = useState(1)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const reload = useCallback(
    async (announce = false): Promise<void> => {
      const [tasksResult, schedulesResult, settingsResult] = await Promise.all([
        callApi<TaskRecordPayload[]>(
          window.icode.tasks.list({ limit: 200, includeArchived: true })
        ),
        callApi<TaskSchedulePayload[]>(window.icode.schedules.list({})),
        callApi<TaskSettingsPayload>(window.icode.tasks.settings())
      ])
      if (!mounted.current) return
      if (tasksResult.ok) {
        setTasks(tasksResult.value.filter((task) => task.archivedAt === null || task.archivedAt === undefined))
        setArchivedTasks(
          tasksResult.value.filter((task) => task.archivedAt !== null && task.archivedAt !== undefined)
        )
      }
      else if (announce) notify(errorNotice(tasksResult.error))
      if (schedulesResult.ok) setSchedules(schedulesResult.value)
      else if (announce) notify(errorNotice(schedulesResult.error))
      if (settingsResult.ok) {
        setMaxConcurrentValue(settingsResult.value.maxConcurrent)
        setMaxConcurrentPerProjectValue(settingsResult.value.maxConcurrentPerProject)
      } else if (announce) notify(errorNotice(settingsResult.error))
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

  useEffect(() => window.icode.onTaskEvent(() => void reload()), [reload])

  const setMaxConcurrent = useCallback(
    async (value: number): Promise<void> => {
      const result = await callApi<TaskSettingsPayload>(
        window.icode.tasks.setSettings({ maxConcurrent: value })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setMaxConcurrentValue(result.value.maxConcurrent)
      setMaxConcurrentPerProjectValue(result.value.maxConcurrentPerProject)
      await reload()
    },
    [notify, reload]
  )

  const setMaxConcurrentPerProject = useCallback(
    async (value: number): Promise<void> => {
      const result = await callApi<TaskSettingsPayload>(
        window.icode.tasks.setSettings({ maxConcurrentPerProject: value })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setMaxConcurrentValue(result.value.maxConcurrent)
      setMaxConcurrentPerProjectValue(result.value.maxConcurrentPerProject)
      await reload()
    },
    [notify, reload]
  )

  return {
    tasks,
    archivedTasks,
    schedules,
    maxConcurrent,
    maxConcurrentPerProject,
    loading,
    reload,
    setMaxConcurrent,
    setMaxConcurrentPerProject
  }
}
