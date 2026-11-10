import { useCallback, useEffect, useState } from 'react'
import type { BranchRefSummary } from '../../../shared/schemas/ipc'
import type { AppError } from '../../../shared/domain/errors'
import { callApi } from '../lib/api'

type BranchRefsState = {
  refs: BranchRefSummary[]
  loading: boolean
  error: AppError | null
  reload: () => Promise<void>
}

/** Local branch refs for the start-from and finish dialogs. */
export function useBranchRefs(repoId: string | null): BranchRefsState {
  const [refs, setRefs] = useState<BranchRefSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (repoId === null || repoId.length === 0) {
      setRefs([])
      setError(null)
      return
    }
    setLoading(true)
    const result = await callApi(window.icode.branches.refs({ repoId }))
    setLoading(false)
    if (result.ok) {
      setRefs(result.value)
      setError(null)
    } else {
      setRefs([])
      setError(result.error)
    }
  }, [repoId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { refs, loading, error, reload }
}
