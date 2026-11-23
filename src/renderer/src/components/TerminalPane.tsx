import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import { SessionTerminal, type TerminalStatus } from '../terminal/session-terminal'
import { rememberTerminalSize } from '../terminal/terminal-size'
import { applyTerminalTheme } from '../terminal/terminal-theme'
import { terminalOptionsFor } from '../terminal/terminal-options'
import {
  loadTerminalSettings,
  useTerminalSettings
} from '../terminal/terminal-settings'
import type { TerminalFindDirection } from '../terminal/terminal-interaction-host'
import type { TerminalInstanceLike } from '../terminal/terminal-instance'
import { terminalRightClickIntent } from '../terminal/interaction/right-click-policy'
import { useTerminalRegistry } from '../terminal/terminal-provider'
import { useSessionPaneActions } from './sessions/SessionPaneActions'
import TerminalContextMenu, { type TerminalMenuActions } from './terminal/TerminalContextMenu'
import TerminalFindBar from './terminal/TerminalFindBar'
import TerminalLinkPopover from './terminal/TerminalLinkPopover'
import type { TerminalLinkRequest } from '../terminal/terminal-interaction-host'
import type { SplitSide } from '../state/session-split'
import { useT } from '../i18n/use-i18n'

type Props = {
  session: SessionSummary
  active: boolean
  onError: (error: AppError) => void
  /** A read-only preview: no focus, no resize back to the PTY. */
  preview?: boolean
}

const INITIAL_STATUS: TerminalStatus = {
  phase: 'connecting',
  message: null,
  incarnationId: null,
  exitCode: null,
  error: null
}

/** Menu state is a snapshot: xterm has no mouse-mode change event. */
type TerminalMenuPoint = {
  x: number
  y: number
  hasSelection: boolean
  mouseTracking: boolean
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined
const getInitialStatus = (): TerminalStatus => INITIAL_STATUS

function describesTerminal(state: SessionSummary['state']): boolean {
  return state === 'starting' || state === 'live'
}

type FrameProps = {
  session: SessionSummary
  active: boolean
  preview: boolean
  status: TerminalStatus
  containerRef: React.RefObject<HTMLDivElement | null>
  onActivate: () => void
  onRetry: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void
  children?: React.ReactNode
}

/**
 * The pane chrome shared by both terminal implementations: host container,
 * connecting/synchronizing badge, final-state footer, and error overlay.
 */
function TerminalPaneFrame({
  session,
  active,
  preview,
  status,
  containerRef,
  onActivate,
  onRetry,
  onContextMenu,
  children
}: FrameProps): React.JSX.Element {
  const t = useT()
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
        onMouseDown={
          preview
            ? undefined
            : (event) => {
                // Focus on press, before mouseup. A link click opens its action
                // popover on mouseup; focusing on click would steal focus back
                // from the popover and leak Escape to the shell.
                if (event.button === 0) onActivate()
              }
        }
        onContextMenu={preview ? undefined : onContextMenu}
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
                onClick={onRetry}
                data-testid="terminal-retry"
              >
                <RefreshCw size={12} />
                {t('terminal.reconnect')}
              </button>
            </div>
          </div>
        )
      ) : null}
      {children}
    </div>
  )
}

/**
 * View for a registered instance.
 *
 * It never creates an xterm or calls attach. The registry owns both; this host
 * only moves the instance's wrapper into its container and observes size.
 */
function RegistryTerminalPane({
  session,
  active,
  onError
}: Omit<Props, 'preview'>): React.JSX.Element {
  const registry = useTerminalRegistry()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const errorRef = useRef(onError)
  errorRef.current = onError
  const attachmentRef = useRef<number | null>(null)
  const [instance, setInstance] = useState<TerminalInstanceLike | null>(() =>
    registry.peek(session.id, session.incarnationId)
  )

  useEffect(() => {
    const acquired = registry.acquire({
      sessionId: session.id,
      incarnationId: session.incarnationId,
      onError: (error) => errorRef.current(error)
    })
    setInstance(acquired)
    return () => registry.release(acquired, attachmentRef.current)
  }, [registry, session.id, session.incarnationId])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (instance === null || container === null) return
    const attachment = instance.attachToElement(container)
    attachmentRef.current = attachment
    return () => instance.detach(attachment)
  }, [instance])

  useEffect(() => {
    if (instance === null) return
    instance.setActive(active)
  }, [instance, active])

  useEffect(() => {
    if (instance === null) return
    const container = containerRef.current
    if (container === null) return
    const observer = new ResizeObserver(() => instance.scheduleFit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [instance])

  const subscribe = useCallback(
    (listener: () => void) =>
      instance === null ? NO_SUBSCRIBE() : instance.subscribe(listener),
    [instance]
  )
  const getSnapshot = useCallback(
    () => (instance === null ? getInitialStatus() : instance.getStatus()),
    [instance]
  )
  const status = useSyncExternalStore(subscribe, getSnapshot)
  const paneActions = useSessionPaneActions()
  const terminalSettings = useTerminalSettings()
  const t = useT()
  const [findOpen, setFindOpen] = useState(false)
  const [menu, setMenu] = useState<TerminalMenuPoint | null>(null)
  const [linkRequest, setLinkRequest] = useState<TerminalLinkRequest | null>(null)

  useEffect(() => {
    if (instance === null) return
    return instance.onFindRequest(() => setFindOpen(true))
  }, [instance])

  useEffect(() => {
    if (instance === null) return
    const unsubscribe = instance.onLinkRequest((request) => setLinkRequest(request))
    return () => {
      unsubscribe()
      setLinkRequest(null)
    }
  }, [instance])

  const find = useCallback(
    (
      query: string,
      direction: TerminalFindDirection,
      options: { caseSensitive: boolean; regex: boolean }
    ) => instance?.find(query, direction, options) ?? false,
    [instance]
  )
  const clearFind = useCallback(() => instance?.clearFind(), [instance])
  const closeFind = useCallback(() => {
    setFindOpen(false)
    instance?.focus()
  }, [instance])
  const copySelectionWithNotice = useCallback(async (): Promise<boolean> => {
    if (instance === null) return false
    const ok = await instance.copySelection()
    instance.notify({
      tone: ok ? 'success' : 'error',
      message: t(ok ? 'terminal.copiedSelection' : 'terminal.copyFailed')
    })
    return ok
  }, [instance, t])
  const copy = useCallback(() => {
    void copySelectionWithNotice()
  }, [copySelectionWithNotice])
  const copyScreenContent = useCallback(() => {
    if (instance === null) return
    void instance.copyScreenContent().then((ok) => {
      instance.notify({
        tone: ok ? 'success' : 'error',
        message: t(ok ? 'terminal.copiedScreen' : 'terminal.copyFailed')
      })
    })
  }, [instance, t])
  const paste = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        instance?.paste(text)
      })
      .catch(() => undefined)
  }, [instance])
  const selectAll = useCallback(() => instance?.selectAll(), [instance])
  const copyContext = useCallback(() => {
    const text = instance?.getTranscript()
    if (text !== undefined && text.length > 0) {
      void navigator.clipboard.writeText(text).catch(() => undefined)
    }
  }, [instance])
  const copySessionId = useCallback(() => {
    void navigator.clipboard.writeText(session.id).catch(() => undefined)
  }, [session.id])
  const menuActions = useMemo<TerminalMenuActions>(
    () => ({
      copy,
      copyScreenContent,
      paste,
      selectAll,
      find: () => setFindOpen(true),
      copyContext,
      copySessionId,
      split: (side: SplitSide) => paneActions?.split(side),
      toggleZoom: () => paneActions?.toggleZoom(),
      clear: () => instance?.clear(),
      reset: () => instance?.reset(),
      close: () => paneActions?.close()
    }),
    [copy, copyScreenContent, copyContext, copySessionId, instance, paneActions, paste, selectAll]
  )

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const target = instance
      if (target === null) return
      const x = event.clientX
      const y = event.clientY
      const mouseTracking = target.isMouseTrackingActive()
      const hasSelection = target.hasSelection()
      const intent = terminalRightClickIntent({
        button: event.button,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        mouseTracking,
        hasSelection,
        rightClickPaste: terminalSettings.rightClickPaste
      })
      if (intent === 'passthrough') return
      if (intent === 'copy') {
        void copySelectionWithNotice().then((ok) => {
          if (ok) return
          setMenu({ x, y, hasSelection: target.hasSelection(), mouseTracking })
        })
        return
      }
      if (intent === 'paste') {
        paste()
        return
      }
      setMenu({ x, y, hasSelection, mouseTracking })
    },
    [copySelectionWithNotice, instance, paste, terminalSettings.rightClickPaste]
  )

  return (
    <TerminalPaneFrame
      session={session}
      active={active}
      preview={false}
      status={status}
      containerRef={containerRef}
      onActivate={() => instance?.focus()}
      onRetry={() => instance?.retry()}
      onContextMenu={handleContextMenu}
    >
      <TerminalFindBar
        open={findOpen}
        onClose={closeFind}
        find={find}
        clearFind={clearFind}
        initialCaseSensitive={terminalSettings.findCaseSensitive}
        initialRegex={terminalSettings.findRegex}
      />
      <TerminalLinkPopover request={linkRequest} onClose={() => setLinkRequest(null)} />
      <TerminalContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        hasSelection={menu?.hasSelection ?? false}
        mouseTracking={menu?.mouseTracking ?? false}
        canSplit={paneActions?.canSplit ?? false}
        canClose={paneActions?.canClose ?? false}
        canZoom={paneActions?.canZoom ?? false}
        onClose={() => {
          setMenu(null)
          instance?.focus()
        }}
        actions={menuActions}
      />
    </TerminalPaneFrame>
  )
}

/**
 * Standalone terminal used by read-only wall previews. It owns its xterm
 * because previews are not shared with the interactive pane.
 */
function StandaloneTerminalPane({ session, active, onError, preview = false }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const controllerRef = useRef<SessionTerminal | null>(null)
  const activeRef = useRef(active)
  const [status, setStatus] = useState<TerminalStatus>(INITIAL_STATUS)

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
        rememberTerminalSize({ cols: term.cols, rows: term.rows })
      }
    } catch {
      // A hidden or detached container is not an error; the next activation fits.
    }
  }, [preview])

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

    const term = new Terminal(
      terminalOptionsFor(preview ? 'preview' : 'interactive', loadTerminalSettings())
    )
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

    let disposed = false
    if (document.fonts !== undefined) {
      void document.fonts.ready
        .then(() => {
          if (!disposed) scheduleFit()
        })
        .catch(() => undefined)
    }
    scheduleFit()

    const themeObserver = new MutationObserver(() => {
      applyTerminalTheme(term)
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

  return (
    <TerminalPaneFrame
      session={session}
      active={active}
      preview={preview}
      status={status}
      containerRef={containerRef}
      onActivate={() => termRef.current?.focus()}
      onRetry={() => controllerRef.current?.retry()}
    />
  )
}

export default function TerminalPane(props: Props): React.JSX.Element {
  if (props.preview === true) return <StandaloneTerminalPane {...props} />
  return <RegistryTerminalPane {...props} />
}
