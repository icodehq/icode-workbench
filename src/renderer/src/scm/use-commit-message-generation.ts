import { useCallback, useEffect, useRef, useState } from 'react'
import { callApi } from '../lib/api'
import { harnessLabel, isAgentHarness, type HarnessId } from '../../../shared/domain/harness'
import type { AiCommitMessageResult } from '../../../shared/schemas/ai'

type GenerationState =
  | { status: 'idle' }
  | { status: 'generating'; requestId: string }
  | { status: 'replace'; message: string; agent: HarnessId }
  | { status: 'error'; detail: string }

export type CommitMessageGeneration = {
  status: GenerationState['status']
  /** True while the harness is running. */
  generating: boolean
  /** A generated message waiting for the user to replace a non-empty draft. */
  pending: string | null
  /** Short success/cancel note, never an error. */
  note: string
  /** Error detail when status is `error`. */
  error: string | null
  canGenerate: boolean
  disabledReason: string
  generate: () => void
  cancel: () => void
  applyPending: () => void
  dismissPending: () => void
}

type Options = {
  sessionId: string
  harness: HarnessId
  active: boolean
  stagedCount: number
  conflicts: number
  message: string
  setMessage: (value: string) => void
}

function requestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `gen-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
}

function agentLabel(agent: HarnessId): string {
  return harnessLabel(agent)
}

/**
 * One explicit, cancellable generation per panel. It only writes the draft;
 * committing remains a separate user action.
 */
export function useCommitMessageGeneration({
  sessionId,
  harness,
  active,
  stagedCount,
  conflicts,
  message,
  setMessage
}: Options): CommitMessageGeneration {
  const [state, setState] = useState<GenerationState>({ status: 'idle' })
  const [note, setNote] = useState('')
  const inFlight = useRef<{ requestId: string } | null>(null)
  const messageRef = useRef(message)
  messageRef.current = message

  const cancelRequest = useCallback((id: string): void => {
    void callApi<{ cancelled: boolean }>(window.icode.ai.cancelCommitMessage({ requestId: id }))
  }, [])

  const reset = useCallback((): void => {
    if (inFlight.current !== null) {
      cancelRequest(inFlight.current.requestId)
      inFlight.current = null
    }
    setState({ status: 'idle' })
    setNote('')
  }, [cancelRequest])

  useEffect(() => {
    reset()
  }, [reset, sessionId])

  useEffect(() => {
    if (active) return
    reset()
  }, [active, reset])

  useEffect(
    () => () => {
      if (inFlight.current !== null) cancelRequest(inFlight.current.requestId)
      inFlight.current = null
    },
    [cancelRequest]
  )

  const generate = useCallback((): void => {
    if (!isAgentHarness(harness) || inFlight.current !== null) return
    const id = requestId()
    inFlight.current = { requestId: id }
    setNote('')
    setState({ status: 'generating', requestId: id })
    void (async (): Promise<void> => {
      let result
      try {
        result = await callApi<AiCommitMessageResult>(
          window.icode.ai.commitMessage({ sessionId, requestId: id })
        )
      } catch (error) {
        if (inFlight.current?.requestId !== id) return
        inFlight.current = null
        setState({
          status: 'error',
          detail: error instanceof Error ? error.message : 'The agent could not be started.'
        })
        return
      }
      if (inFlight.current?.requestId !== id) return
      inFlight.current = null
      if (!result.ok) {
        setState({ status: 'error', detail: result.error.message })
        return
      }
      if (result.value.status === 'cancelled') {
        setState({ status: 'idle' })
        setNote('Generation cancelled.')
        return
      }
      if (result.value.status === 'unavailable') {
        setState({ status: 'error', detail: result.value.detail })
        return
      }
      const generated = result.value.message
      if (messageRef.current.trim().length === 0) {
        setMessage(generated)
        setState({ status: 'idle' })
        setNote(`Generated with ${agentLabel(result.value.agent)}.`)
      } else {
        setState({ status: 'replace', message: generated, agent: result.value.agent })
      }
    })()
  }, [harness, sessionId, setMessage])

  const cancel = useCallback((): void => {
    if (inFlight.current === null) return
    cancelRequest(inFlight.current.requestId)
    inFlight.current = null
    setState({ status: 'idle' })
    setNote('Generation cancelled.')
  }, [cancelRequest])

  const applyPending = useCallback((): void => {
    if (state.status !== 'replace') return
    setMessage(state.message)
    setState({ status: 'idle' })
    setNote(`Generated with ${agentLabel(state.agent)}.`)
  }, [setMessage, state])

  const dismissPending = useCallback((): void => {
    setState({ status: 'idle' })
  }, [])

  const canGenerate =
    isAgentHarness(harness) &&
    active &&
    stagedCount > 0 &&
    conflicts === 0 &&
    state.status !== 'generating'
  const disabledReason =
    !isAgentHarness(harness)
      ? 'Commit-message generation needs a coding-agent session.'
      : stagedCount === 0
        ? 'Stage files before generating a commit message.'
        : conflicts > 0
          ? 'Resolve conflicts before generating a commit message.'
          : !active
            ? 'Open Source Control to generate a commit message.'
            : ''

  return {
    status: state.status,
    generating: state.status === 'generating',
    pending: state.status === 'replace' ? state.message : null,
    note,
    error: state.status === 'error' ? state.detail : null,
    canGenerate,
    disabledReason,
    generate,
    cancel,
    applyPending,
    dismissPending
  }
}
