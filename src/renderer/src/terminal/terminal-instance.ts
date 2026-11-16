import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { AppError } from '../../../shared/domain/errors'
import { isResizeActive, subscribeResizeActivity } from '../lib/resize-activity'
import { SessionTerminal, type TerminalStatus } from './session-terminal'
import { rememberTerminalSize } from './terminal-size'
import { applyTerminalTheme, terminalThemeOptions } from './terminal-theme'
import { PanePtyResizeHold } from './pane-pty-resize-hold'

/**
 * A renderer-owned terminal: xterm, its controller, status, and the wrapper
 * element that views adopt.
 *
 * The instance outlives the React view that displays it. Mounting and moving a
 * pane only appends `wrapper` to another container; the xterm buffer and the
 * host attachment are untouched. This is the same split VS Code uses between a
 * terminal instance and its view.
 */

export type TerminalInstanceOptions = {
  /** Stable identity from the registry: `sessionId:incarnation`. */
  key: string
  sessionId: string
  onError: (error: AppError) => void
}

export type TerminalInstanceLike = {
  readonly key: string
  /** Returns an attachment generation; pass it to `detach` from this view. */
  attachToElement(container: HTMLElement): number
  detach(attachment?: number | null): void
  setActive(active: boolean): void
  fit(): void
  /** Coalesced container-fit request; throttled while a panel drag is active. */
  scheduleFit(): void
  focus(): void
  retry(): void
  dispose(): void
  isAttached(): boolean
  isDisposed(): boolean
  subscribe(listener: () => void): () => void
  getStatus(): TerminalStatus
}

const INITIAL_STATUS: TerminalStatus = {
  phase: 'connecting',
  message: null,
  incarnationId: null,
  exitCode: null,
  error: null
}

/** Ordinary coalescing window for xterm grid changes. */
const PTY_RESIZE_DEBOUNCE_MS = 50
/** Drag cadence for visual fits; Orca and Termio settle on the same order. */
const PANEL_DRAG_FIT_INTERVAL_MS = 150

export class TerminalInstance implements TerminalInstanceLike {
  readonly key: string

  private readonly term: Terminal
  private readonly fitAddon: FitAddon
  private readonly controller: SessionTerminal
  private readonly wrapper: HTMLDivElement
  private readonly listeners = new Set<() => void>()
  private readonly themeObserver: MutationObserver
  private readonly inputDisposable: { dispose(): void }
  private readonly resizeDisposable: { dispose(): void }

  private status: TerminalStatus = INITIAL_STATUS
  private attachedContainer: HTMLElement | null = null
  private attachment: number | null = null
  private nextAttachment = 0
  private active = false
  private disposed = false
  private fitFrame: number | null = null
  private containerFitTimer: ReturnType<typeof setTimeout> | null = null
  private layoutResizeHeld = false
  private flushPtyAfterFit = false
  private readonly resizeHold: PanePtyResizeHold
  private readonly unsubscribeLayoutResize: () => void

  constructor(options: TerminalInstanceOptions) {
    this.key = options.key
    this.wrapper = document.createElement('div')
    this.wrapper.className = 'terminal-wrapper'
    this.wrapper.style.width = '100%'
    this.wrapper.style.height = '100%'

    this.term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: false,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      ...terminalThemeOptions()
    })
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
    this.term.open(this.wrapper)

    this.inputDisposable = this.term.onData((data) => {
      void this.controller.write(data)
    })

    /*
     * Grid changes never go straight to the host. Outside a drag the hold
     * coalesces them for one short interval; during a panel drag it keeps the
     * newest grid and sends only the settled final size on release. Hidden
     * views never resize the PTY.
     */
    this.resizeHold = new PanePtyResizeHold({
      send: ({ cols, rows }) => {
        if (this.active && !this.disposed && this.isAttached()) {
          this.controller.resize(cols, rows)
        }
      },
      delayMs: PTY_RESIZE_DEBOUNCE_MS
    })

    this.resizeDisposable = this.term.onResize(({ cols, rows }) => {
      if (this.disposed) return
      this.resizeHold.noteGrid({ cols, rows })
    })

    this.controller = new SessionTerminal({
      sessionId: options.sessionId,
      api: window.icode,
      sink: {
        reset: () => this.term.reset(),
        write: (data) => this.term.write(data),
        resize: (cols, rows) => {
          if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows)
        }
      },
      onStatus: (status) => this.setStatus(status),
      onAttached: () => this.scheduleFitNow(),
      onError: options.onError
    })
    this.controller.start()

    this.unsubscribeLayoutResize = subscribeResizeActivity((active) =>
      this.handleLayoutResizeActivity(active)
    )
    // An instance created while a seam is already moving starts held; its
    // attach fit still runs, and the release flushes the settled grid.
    if (isResizeActive()) {
      this.layoutResizeHeld = true
      this.resizeHold.begin()
    }

    // xterm compares the theme option by reference, so a fresh object is
    // required. `applyTerminalTheme` also carries the light-only contrast floor
    // with the palette; buffers and the PTY are untouched.
    this.themeObserver = new MutationObserver(() => {
      applyTerminalTheme(this.term)
    })
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    // The first fit can use fallback glyph metrics; fit again once the font arrives.
    if (document.fonts !== undefined) {
      void document.fonts.ready
        .then(() => {
          if (!this.disposed) this.scheduleFitNow()
        })
        .catch(() => undefined)
    }
  }

  attachToElement(container: HTMLElement): number {
    if (this.disposed) return -1
    const attachment = ++this.nextAttachment
    this.attachment = attachment
    if (this.attachedContainer === container) {
      this.scheduleFitNow()
      return attachment
    }
    this.attachedContainer = container
    container.replaceChildren(this.wrapper)
    /*
     * A detached/reparented xterm must re-open on its own element so the
     * renderer picks up the new window. This does not recreate the terminal or
     * touch the host attachment.
     */
    const element = this.term.element
    if (element !== undefined) {
      try {
        this.term.open(element)
      } catch {
        // Reparenting still works through the wrapper; the next fit corrects size.
      }
    }
    this.scheduleFitNow()
    this.term.refresh(0, Math.max(0, this.term.rows - 1))
    return attachment
  }

  detach(attachment?: number | null): void {
    if (
      attachment !== undefined &&
      attachment !== null &&
      this.attachment !== attachment
    ) {
      // React may have handed the instance to a newer view (often the same
      // reused container); a stale view must not remove that view's wrapper.
      return
    }
    this.attachment = null
    const attached = this.attachedContainer
    this.attachedContainer = null
    if (attached !== null && this.wrapper.parentElement === attached) {
      this.wrapper.remove()
    }
  }

  isAttached(): boolean {
    return this.attachedContainer !== null
  }

  isDisposed(): boolean {
    return this.disposed
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (!active) return
    this.scheduleFitNow()
    this.term.focus()
  }

  fit(): void {
    this.fitNow()
  }

  focus(): void {
    if (!this.disposed && this.attachedContainer !== null) this.term.focus()
  }

  retry(): void {
    if (!this.disposed) this.controller.retry()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getStatus(): TerminalStatus {
    return this.status
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    if (this.fitFrame !== null) {
      window.cancelAnimationFrame(this.fitFrame)
      this.fitFrame = null
    }
    this.clearContainerFitTimer()
    this.unsubscribeLayoutResize()
    this.resizeHold.dispose()
    this.themeObserver.disconnect()
    this.inputDisposable.dispose()
    this.resizeDisposable.dispose()
    this.controller.dispose()
    this.term.dispose()
    this.wrapper.remove()
    this.attachedContainer = null
    this.attachment = null
  }

  private setStatus(status: TerminalStatus): void {
    if (this.disposed) return
    this.status = status
    for (const listener of this.listeners) listener()
  }

  /** Measures and applies a fit. False means the container could not measure. */
  private fitNow(): boolean {
    if (this.disposed || this.attachedContainer === null) return false
    const container = this.attachedContainer
    if (container.clientWidth === 0 || container.clientHeight === 0) return false
    try {
      const proposed = this.fitAddon.proposeDimensions()
      if (proposed === undefined) return false
      if (this.term.cols !== proposed.cols || this.term.rows !== proposed.rows) {
        this.fitAddon.fit()
      }
      if (this.active) {
        rememberTerminalSize({ cols: this.term.cols, rows: this.term.rows })
      }
      return true
    } catch {
      // A hidden or detached container is not an error; the next activation fits.
      return false
    }
  }

  /** Coalesce lifecycle fits into one animation frame. */
  private scheduleFitNow(): void {
    if (this.disposed || this.fitFrame !== null) return
    this.fitFrame = window.requestAnimationFrame(() => {
      this.fitFrame = null
      const measured = this.fitNow()
      if (!this.flushPtyAfterFit) return
      this.flushPtyAfterFit = false
      if (measured) {
        this.resizeHold.finish({ cols: this.term.cols, rows: this.term.rows })
      } else {
        this.resizeHold.finish(null)
      }
    })
  }

  /**
   * Container-driven fits. Immediate normally; throttled while a seam drags so
   * scrollback reflow stays out of the pointer frame path.
   */
  scheduleFit(): void {
    if (this.disposed) return
    if (!this.layoutResizeHeld) {
      this.scheduleFitNow()
      return
    }
    if (this.containerFitTimer !== null || this.fitFrame !== null) return
    this.containerFitTimer = setTimeout(() => {
      this.containerFitTimer = null
      this.scheduleFitNow()
    }, PANEL_DRAG_FIT_INTERVAL_MS)
  }

  private handleLayoutResizeActivity(active: boolean): void {
    if (this.disposed) return
    this.layoutResizeHeld = active
    if (active) {
      this.flushPtyAfterFit = false
      this.resizeHold.begin()
      this.clearContainerFitTimer()
      this.scheduleFitNow()
      return
    }
    this.clearContainerFitTimer()
    // The final fit reads the settled grid and sends it exactly once.
    this.flushPtyAfterFit = true
    this.scheduleFitNow()
  }

  private clearContainerFitTimer(): void {
    if (this.containerFitTimer !== null) {
      clearTimeout(this.containerFitTimer)
      this.containerFitTimer = null
    }
  }
}
