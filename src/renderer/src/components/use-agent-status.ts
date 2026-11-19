import { useCallback, useEffect, useState } from 'react'
import type { IpcResult } from '../../../shared/schemas/ipc'
import type { ManagedHooksStatePayload } from '../../../shared/schemas/managed-hooks'
import type { OpenCodeIntegrationStatePayload } from '../../../shared/schemas/opencode-integration'
import { callApi } from '../lib/api'

export type AgentStatusSettings = {
  managedHooks: ManagedHooksStatePayload | null
  opencode: OpenCodeIntegrationStatePayload | null
  managedError: string | null
  opencodeError: string | null
  saving: boolean
  /** Toggle-wide error; source-specific errors stay on their own field. */
  error: string | null
  reload: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
}

function failureMessage(result: IpcResult<unknown>): string {
  return result.ok ? 'Unknown error' : result.error.message
}

export function useAgentStatus(): AgentStatusSettings {
  const [managedHooks, setManagedHooks] = useState<ManagedHooksStatePayload | null>(null)
  const [opencode, setOpencode] = useState<OpenCodeIntegrationStatePayload | null>(null)
  const [managedError, setManagedError] = useState<string | null>(null)
  const [opencodeError, setOpencodeError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setManagedError(null)
    setOpencodeError(null)
    const [managedResult, opencodeResult] = await Promise.all([
      callApi(window.icode.managedHooks.get()),
      callApi(window.icode.opencodeIntegration.get())
    ])
    if (managedResult.ok) setManagedHooks(managedResult.value)
    else setManagedError(failureMessage(managedResult))
    if (opencodeResult.ok) setOpencode(opencodeResult.value)
    else setOpencodeError(failureMessage(opencodeResult))
  }, [])

  useEffect(() => {
    void reload()
    const unsubscribeManaged = window.icode.managedHooks.onChanged((next) => {
      setManagedHooks(next)
      setManagedError(null)
    })
    const unsubscribeOpenCode = window.icode.opencodeIntegration.onChanged((next) => {
      setOpencode(next)
      setOpencodeError(null)
    })
    return () => {
      unsubscribeManaged()
      unsubscribeOpenCode()
    }
  }, [reload])

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      setSaving(true)
      setError(null)
      try {
        const [managedResult, opencodeResult] = await Promise.allSettled([
          callApi(window.icode.managedHooks.setEnabled({ enabled })),
          callApi(window.icode.opencodeIntegration.setEnabled({ enabled }))
        ])
        const failures: string[] = []
        if (managedResult.status === 'fulfilled' && managedResult.value.ok) {
          setManagedHooks(managedResult.value.value)
        } else {
          failures.push(
            managedResult.status === 'fulfilled'
              ? failureMessage(managedResult.value)
              : String(managedResult.reason)
          )
        }
        if (opencodeResult.status === 'fulfilled' && opencodeResult.value.ok) {
          setOpencode(opencodeResult.value.value)
        } else {
          failures.push(
            opencodeResult.status === 'fulfilled'
              ? failureMessage(opencodeResult.value)
              : String(opencodeResult.reason)
          )
        }
        if (failures.length > 0) setError(failures.join('; '))
        await reload()
      } finally {
        setSaving(false)
      }
    },
    [reload]
  )

  return {
    managedHooks,
    opencode,
    managedError,
    opencodeError,
    saving,
    error,
    reload,
    setEnabled
  }
}
