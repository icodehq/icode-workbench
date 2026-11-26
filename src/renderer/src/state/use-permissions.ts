import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PendingPermissionPayload,
  PermissionDecisionPayload
} from '../../../shared/schemas/permissions'
import type { Notice } from './workspace'
import { callApi, errorNotice } from '../lib/api'

export type PermissionsState = {
  permissions: PendingPermissionPayload[]
  loading: boolean
  respond: (id: string, decision: PermissionDecisionPayload) => Promise<boolean>
}

/** Pending worker-session permissions for one group room. */
export function usePermissions(
  groupId: string,
  notify: (notice: Notice) => void
): PermissionsState {
  const [permissions, setPermissions] = useState<PendingPermissionPayload[]>([])
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const reload = useCallback(async (): Promise<void> => {
    const result = await callApi<PendingPermissionPayload[]>(
      window.icode.permissions.list({ groupId })
    )
    if (!mounted.current) return
    if (!result.ok) {
      notify(errorNotice(result.error))
      setLoading(false)
      return
    }
    setPermissions(result.value)
    setLoading(false)
  }, [groupId, notify])

  useEffect(() => {
    mounted.current = true
    void reload()
    const unsubscribe = window.icode.permissions.onEvent(() => {
      void reload()
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [reload])

  const respond = useCallback(
    async (id: string, decision: PermissionDecisionPayload): Promise<boolean> => {
      const result = await callApi(window.icode.permissions.respond({ id, decision }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      await reload()
      return result.value
    },
    [notify, reload]
  )

  return { permissions, loading, respond }
}
