import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import { nextPaneKeys } from '../state/session-panes'
import {
  createTerminalInteractionHostProxy,
  type TerminalInteractionHost
} from './terminal-interaction-host'
import { TerminalInstance } from './terminal-instance'
import { TerminalRegistry } from './terminal-registry'

const TerminalRegistryContext = createContext<TerminalRegistry | null>(null)

export function useTerminalRegistry(): TerminalRegistry {
  const registry = useContext(TerminalRegistryContext)
  if (registry === null) {
    throw new Error('useTerminalRegistry must be used inside TerminalProvider')
  }
  return registry
}

/**
 * Owns terminal instances for one window.
 *
 * Instances survive pane mounts, splits and tab switches. The provider keeps
 * them while their session is retained (the same live/starting/last-frame set
 * the pane host uses) and disposes everything when the window unmounts.
 */
export function TerminalProvider({
  sessions,
  host = null,
  children
}: {
  sessions: readonly SessionSummary[]
  /** App services used by terminal interactions; read through a stable proxy. */
  host?: TerminalInteractionHost | null
  children: ReactNode
}): React.JSX.Element {
  const hostRef = useRef<TerminalInteractionHost | null>(host)
  useEffect(() => {
    hostRef.current = host
  }, [host])
  const [registry] = useState(
    () =>
      new TerminalRegistry(
        (options) =>
          new TerminalInstance({
            ...options,
            host: createTerminalInteractionHostProxy(() => hostRef.current)
          })
      )
  )
  const retained = useRef<Set<string>>(new Set())

  useEffect(() => {
    retained.current = nextPaneKeys(retained.current, sessions)
    registry.retain(retained.current)
  }, [registry, sessions])

  useEffect(
    () => () => {
      registry.disposeAll()
    },
    [registry]
  )

  return (
    <TerminalRegistryContext.Provider value={registry}>
      {children}
    </TerminalRegistryContext.Provider>
  )
}
