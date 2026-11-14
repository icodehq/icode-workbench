import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import { SessionTerminal, type TerminalStatus } from '../terminal/session-terminal'
import { rememberTerminalSize } from '../terminal/terminal-size'
import { useT } from '../i18n/use-i18n'

/**
 * Terminal palette.
 *
 * The terminal keeps a dark, neutral ground in both appearances, matching the
 * product’s “terminal stays dark” rule. The shell around it follows the
 * Workbench palette; ANSI output keeps a stable afterglow palette.
 */
export const TERMINAL_THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#212121',
    foreground: '#E6E6E8',
    cursor: '#7D8CFF',
    cursorAccent: '#212121',
    selectionBackground: 'rgba(125, 140, 255, 0.28)',
    selectionInactiveBackground: 'rgba(125, 140, 255, 0.14)',
    black: '#212121',
    red: '#F85149',
    green: '#3FB950',
    yellow: '#D29922',
    blue: '#7D8CFF',
    magenta: '#C678DD',
    cyan: '#56B6C2',
    white: '#E6E6E8',
    brightBlack: '#94949B',
    brightRed: '#FF7B72',
    brightGreen: '#56D364',
    brightYellow: '#E3B341',
    brightBlue: '#A5C8FF',
    brightMagenta: '#E2C5FF',
    brightCyan: '#76E3EA',
    brightWhite: '#F5F5F7'
  },
  dark: {
    background: '#212121',
    foreground: '#E6E6E8',
    cursor: '#7D8CFF',
    cursorAccent: '#212121',
    selectionBackground: 'rgba(125, 140, 255, 0.28)',
    selectionInactiveBackground: 'rgba(125, 140, 255, 0.14)',
    black: '#212121',
    red: '#F85149',
    green: '#3FB950',
    yellow: '#D29922',
    blue: '#7D8CFF',
    magenta: '#C678DD',
    cyan: '#56B6C2',
    white: '#E6E6E8',
    brightBlack: '#94949B',
    brightRed: '#FF7B72',
    brightGreen: '#56D364',
    brightYellow: '#E3B341',
    brightBlue: '#A5C8FF',
    brightMagenta: '#E2C5FF',
    brightCyan: '#76E3EA',
    brightWhite: '#F5F5F7'
  }
}

/**
 * The appearance the document is currently in.
 *
 * `main.tsx` resolves the theme before React renders, so the attribute is
 * always present here; the fallback only guards against the pane being rendered
 * outside that entry point (tests, storybook-style harnesses).
 */
function currentThemeName(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

type Props = {
  session: SessionSummary
  active: boolean
  onError: (error: AppError) => void
  /** A read-only preview: no focus, no resize back to the PTY. */
  preview?: boolean
}

function describesTerminal(state: SessionSummary['state']): boolean {
  return state === 'starting' || state === 'live'
}

export default function TerminalPane({ session, active, onError, preview = false }: Props): React.JSX.Element {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fitFrameRef = useRef<number | null>(null)
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
      const proposed = fitAddon.proposeDimensions()
      if (proposed === undefined) return
      if (term.cols !== proposed.cols || term.rows !== proposed.rows) {
        fitAddon.fit()
      }
      if (!preview && activeRef.current) {
        // Persist only the fitted grid. Writing it from the attach snapshot
        // would overwrite the remembered size with the host's old dimensions.
        rememberTerminalSize({ cols: term.cols, rows: term.rows })
      }
    } catch {
      // A hidden or detached container is not an error; the next activation fits.
    }
  }, [preview])

  /** Coalesce observer/font/activation fits into one animation frame. */
  const scheduleFit = useCallback((): void => {
    if (fitFrameRef.current !== null) return
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null
      fit()
    })
  }, [fit])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: !preview,
      disableStdin: preview,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, monospace",
      fontSize: preview ? 10 : 12,
      lineHeight: 1.2,
      scrollback: preview ? 1000 : 5000,
      theme: { ...TERMINAL_THEMES[currentThemeName()] }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term
    fitRef.current = fitAddon

    const inputDisposable = preview
      ? { dispose: (): void => {} }
      : term.onData((data) => {
          void controllerRef.current?.write(data)
        })
    /*
     * A window drag can produce a resize event on every frame. Sending each one
     * across the host made the shell redraw constantly; coalesce for one short
     * interval and send only the final grid.
     */
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let pendingResize: { cols: number; rows: number } | null = null
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (preview) return
      pendingResize = { cols, rows }
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        const next = pendingResize
        pendingResize = null
        if (next !== null) controllerRef.current?.resize(next.cols, next.rows)
      }, 50)
    })

    const controller = new SessionTerminal({
      sessionId: session.id,
      api: window.icode,
      readOnly: preview,
      sink: {
        reset: () => term.reset(),
        write: (data) => term.write(data),
        resize: (cols, rows) => {
          if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
        }
      },
      onStatus: setStatus,
      onAttached: () => {
        scheduleFit()
        window.requestAnimationFrame(() => {
          if (preview) {
            term.scrollToBottom()
            return
          }
          if (activeRef.current) term.focus()
        })
      },
      onError
    })
    controllerRef.current = controller
    controller.start()

    const observer = new ResizeObserver(() => {
      if (!preview && !activeRef.current) return
      scheduleFit()
    })
    observer.observe(container)

    /*
     * `font-display: swap` means the first fit can use fallback glyph metrics
     * and then change when JetBrains Mono arrives. Fit again once the document
     * fonts are ready; this is a layout correction, not a second terminal.
     */
    let disposed = false
    if (document.fonts !== undefined) {
      void document.fonts.ready
        .then(() => {
          if (!disposed) scheduleFit()
        })
        .catch(() => undefined)
    }
    scheduleFit()

    // xterm compares the `theme` option by reference, so a fresh object is
    // required for the update to be applied. Assigning the option only rewrites
    // xterm's colour cache and repaints: the buffer, scrollback, cursor position
    // and the PTY are untouched, which is why the theme is updated in place
    // rather than by re-creating the terminal.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = { ...TERMINAL_THEMES[currentThemeName()] }
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      disposed = true
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      themeObserver.disconnect()
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
  }, [session.id, preview])

  useEffect(() => {
    if (!active || preview) return
    scheduleFit()
    termRef.current?.focus()
  }, [active, preview, scheduleFit])

  const showOverlay = status.phase === 'error'
  const busy = status.phase === 'connecting' || status.phase === 'resyncing'
  const finished =
    status.phase === 'exited' || status.phase === 'failed' || status.phase === 'unavailable'

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-background ${
        preview ? 'wall-terminal pointer-events-none' : active ? '' : 'hidden'
      }`}
      data-testid={`terminal-pane-${session.id}`}
      data-preview={preview ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      data-phase={status.phase}
    >
      <div
        ref={containerRef}
        className={`terminal-host absolute inset-0 ${preview ? 'px-1.5 py-1' : 'px-2 py-1'}`}
        data-testid={`terminal-${session.id}`}
        onClick={preview ? undefined : () => termRef.current?.focus()}
      />
      {busy && !preview ? (
        <div className="pointer-events-none absolute left-3 top-2 z-10 flex items-center gap-2 rounded-md border border-border bg-card/95 px-2 py-1 text-[10px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          {status.phase === 'connecting'
            ? t('terminal.connecting')
            : t('terminal.synchronizing')}
        </div>
      ) : null}
      {finished && !preview ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 border-t border-border bg-card/95 px-3 py-1.5 text-[10px] text-muted-foreground">
          {session.sleeping === true
            ? t('terminal.sleeping')
            : status.phase === 'exited'
              ? status.exitCode === null
                ? t('terminal.exitedFinalNoCode')
                : t('terminal.exitedFinal', { code: status.exitCode })
              : status.phase === 'unavailable'
                ? (status.message ?? t('terminal.noLongerOwned'))
                : (status.message ?? t('terminal.processFailed'))}
          {session.sleeping !== true && describesTerminal(session.state)
            ? ` ${t('terminal.hostUnconfirmed')}`
            : ''}
        </div>
      ) : null}
      {showOverlay ? (
        preview ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/90 px-2 text-center text-[9px] text-muted-foreground">
            {t('terminal.previewUnavailable')}
          </div>
        ) : (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85 p-6">
            <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-4">
              <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
                <AlertTriangle size={14} />
                {t('terminal.unavailableTitle')}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {status.message ?? t('terminal.couldNotSync')}
              </p>
              <button
                type="button"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-[11px] hover:bg-border/40"
                onClick={() => controllerRef.current?.retry()}
                data-testid="terminal-retry"
              >
                <RefreshCw size={12} />
                {t('terminal.reconnect')}
              </button>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}
