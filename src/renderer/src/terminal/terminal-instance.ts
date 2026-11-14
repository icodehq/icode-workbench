import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { AppError } from '../../../shared/domain/errors'
import { SessionTerminal, type TerminalStatus } from './session-terminal'
import { rememberTerminalSize } from './terminal-size'
import { TERMINAL_THEMES, currentThemeName } from './terminal-theme'

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
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingResize: { cols: number; rows: number } | null = null

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
      theme: { ...TERMINAL_THEMES[currentThemeName()] }
    })
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
    this.term.open(this.wrapper)

    this.inputDisposable = this.term.onData((data) => {
      void this.controller.write(data)
    })

    /*
     * A window drag can produce a resize event on every frame. Sending each one
     * across the host made the shell redraw constantly; coalesce for one short
     * interval and send only the final grid. Hidden views never resize the PTY.
     */
    this.resizeDisposable = this.term.onResize(({ cols, rows }) => {
      if (this.disposed) return
      this.pendingResize = { cols, rows }
      if (this.resizeTimer !== null) clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null
        const next = this.pendingResize
        this.pendingResize = null
        if (next !== null && this.active) this.controller.resize(next.cols, next.rows)
      }, 50)
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
      onAttached: () => this.scheduleFit(),
      onError: options.onError
    })
    this.controller.start()

    // xterm compares the theme option by reference, so a fresh object is
    // required. This updates colours only; buffers and the PTY are untouched.
    this.themeObserver = new MutationObserver(() => {
      this.term.options.theme = { ...TERMINAL_THEMES[currentThemeName()] }
    })
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    // The first fit can use fallback glyph metrics; fit again once the font arrives.
    if (document.fonts !== undefined) {
      void document.fonts.ready
        .then(() => {
          if (!this.disposed) this.scheduleFit()
        })
        .catch(() => undefined)
    }
  }

  attachToElement(container: HTMLElement): number {
    if (this.disposed) return -1
    const attachment = ++this.nextAttachment
    this.attachment = attachment
    if (this.attachedContainer === container) {
      this.scheduleFit()
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
    this.scheduleFit()
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
    this.scheduleFit()
    this.term.focus()
  }

  fit(): void {
    if (this.disposed || this.attachedContainer === null) return
    const container = this.attachedContainer
    if (container.clientWidth === 0 || container.clientHeight === 0) return
    try {
      const proposed = this.fitAddon.proposeDimensions()
      if (proposed === undefined) return
      if (this.term.cols !== proposed.cols || this.term.rows !== proposed.rows) {
        this.fitAddon.fit()
      }
      if (this.active) {
        rememberTerminalSize({ cols: this.term.cols, rows: this.term.rows })
      }
    } catch {
      // A hidden or detached container is not an error; the next activation fits.
    }
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
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = null
    }
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

  /** Coalesce observer/activation fits into one animation frame. */
  private scheduleFit(): void {
    if (this.disposed || this.fitFrame !== null) return
    this.fitFrame = window.requestAnimationFrame(() => {
      this.fitFrame = null
      this.fit()
    })
  }
}
