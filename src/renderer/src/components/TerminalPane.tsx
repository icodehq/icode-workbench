import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import { SessionTerminal, type TerminalStatus } from '../terminal/session-terminal'

const TERMINAL_THEME = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#fafafa',
  cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(20, 71, 230, 0.35)',
  black: '#171717',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
}

type Props = {
  session: SessionSummary
  active: boolean
  onError: (error: AppError) => void
}

function describesTerminal(state: SessionSummary['state']): boolean {
  return state === 'starting' || state === 'live'
}

export default function TerminalPane({ session, active, onError }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const controllerRef = useRef<SessionTerminal | null>(null)
  const activeRef = useRef(active)
  const [status, setStatus] = useState<TerminalStatus>({
    phase: 'connecting',
    message: null,
    incarnationId: null,
    exitCode: null,
    error: null
  })

  activeRef.current = active

  const fit = useCallback((): void => {
    const term = termRef.current
    const fitAddon = fitRef.current
    const container = containerRef.current
    if (!term || !fitAddon || !container) return
    if (container.clientWidth === 0 || container.clientHeight === 0) return
    try {
      fitAddon.fit()
    } catch {
      // A hidden or detached container is not an error; the next activation fits.
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term
    fitRef.current = fitAddon

    const inputDisposable = term.onData((data) => {
      void controllerRef.current?.write(data)
    })
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      controllerRef.current?.resize(cols, rows)
    })

    const controller = new SessionTerminal({
      sessionId: session.id,
      api: window.ade,
      sink: {
        reset: () => term.reset(),
        write: (data) => term.write(data),
        resize: (cols, rows) => {
          if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
        }
      },
      onStatus: setStatus,
      onAttached: () => {
        window.requestAnimationFrame(() => {
          if (!activeRef.current) return
          fit()
          term.focus()
        })
      },
      onError
    })
    controllerRef.current = controller
    controller.start()

    const observer = new ResizeObserver(() => {
      if (!activeRef.current) return
      fit()
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      resizeDisposable.dispose()
      inputDisposable.dispose()
      controller.dispose()
      controllerRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // The component is keyed by session and incarnation by its owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  useEffect(() => {
    if (!active) return
    const frame = window.requestAnimationFrame(() => {
      fit()
      termRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, fit])

  const showOverlay = status.phase === 'error'
  const busy = status.phase === 'connecting' || status.phase === 'resyncing'
  const finished =
    status.phase === 'exited' || status.phase === 'failed' || status.phase === 'unavailable'

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-background ${active ? '' : 'hidden'}`}
      data-testid={`terminal-pane-${session.id}`}
      data-active={active ? 'true' : 'false'}
      data-phase={status.phase}
    >
      <div
        ref={containerRef}
        className="terminal-host absolute inset-0 px-2 py-1"
        data-testid={`terminal-${session.id}`}
        onClick={() => termRef.current?.focus()}
      />
      {busy ? (
        <div className="pointer-events-none absolute left-3 top-2 z-10 flex items-center gap-2 rounded-md border border-border bg-card/95 px-2 py-1 text-[10px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          {status.phase === 'connecting'
            ? 'Connecting to the terminal host…'
            : 'Synchronizing terminal output…'}
        </div>
      ) : null}
      {finished ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 border-t border-border bg-card/95 px-3 py-1.5 text-[10px] text-muted-foreground">
          {status.phase === 'exited'
            ? `Process exited${status.exitCode === null ? '' : ` (code ${String(status.exitCode)})`}. The output above is final.`
            : status.phase === 'unavailable'
              ? (status.message ?? 'The terminal host no longer owns this session.')
              : (status.message ?? 'The process failed.')}
          {describesTerminal(session.state) ? ' The host has not confirmed this state yet.' : ''}
        </div>
      ) : null}
      {showOverlay ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85 p-6">
          <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
              <AlertTriangle size={14} />
              Terminal unavailable
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {status.message ?? 'The terminal could not be synchronized.'}
            </p>
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-[11px] hover:bg-border/40"
              onClick={() => controllerRef.current?.retry()}
              data-testid="terminal-retry"
            >
              <RefreshCw size={12} />
              Reconnect
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
