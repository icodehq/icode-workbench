import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import type { AppError } from '../../../shared/domain/errors'
import { isMacPlatform } from '../lib/platform'
import { isResizeActive, subscribeResizeActivity } from '../lib/resize-activity'
import { installTerminalKeyRouter } from './interaction/key-router'
import { SessionTerminal, type TerminalStatus } from './session-terminal'
import { rememberTerminalSize } from './terminal-size'
import { applyTerminalTheme } from './terminal-theme'
import { applyTerminalOptions, terminalOptionsFor } from './terminal-options'
import {
  loadTerminalSettings,
  subscribeTerminalSettings,
  type TerminalSettings
} from './terminal-settings'
import { trimTerminalSelection } from './interaction/selection-text'
import { createOsc52Handler } from './interaction/osc52'
import {
  createTerminalMouseReportSuppressor,
  installTerminalRightButtonSuppression,
  type MouseReportSuppressor,
  type TerminalRightButtonSuppression
} from './interaction/mouse-report-suppressor'
import { shouldWithholdRightButton } from './interaction/right-click-policy'
import {
  TERMINAL_CLIPBOARD_MAX_CHARS,
  capClipboardText,
  readScreenText
} from './interaction/screen-text'
import type {
  TerminalFindDirection,
  TerminalFindOptions,
  TerminalInteractionHost,
  TerminalInteractionState,
  TerminalLinkRequest,
  TerminalMetadata,
  TerminalNotice,
  TerminalTranscriptOptions
} from './terminal-interaction-host'
import { installTerminalLinks, type TerminalLinks } from './links/terminal-links'
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
  /** App services; null keeps the instance usable in tests and previews. */
  host?: TerminalInteractionHost | null
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
  isMouseTrackingActive(): boolean
  subscribe(listener: () => void): () => void
  getStatus(): TerminalStatus
  notify(notice: TerminalNotice): void

  hasSelection(): boolean
  getSelectionText(): string
  copySelection(): Promise<boolean>
  copyScreenContent(): Promise<boolean>
  selectAll(): void
  clearSelection(): void
  /** Feeds text through xterm so bracketed-paste mode is honored. */
  paste(text: string): boolean | Promise<boolean>
  find(
    query: string,
    direction: TerminalFindDirection,
    options?: TerminalFindOptions
  ): boolean
  clearFind(): void
  clear(): void
  reset(): void
  getMetadata(): TerminalMetadata
  getTranscript(options?: TerminalTranscriptOptions): string
  onInteractionState(listener: (state: TerminalInteractionState) => void): () => void
  /** The view owns the find bar; the key router only requests it. */
  onFindRequest(listener: () => void): () => void
  /** A link click that should open the React action popover. */
  onLinkRequest(listener: (request: TerminalLinkRequest) => void): () => void
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
  private readonly searchAddon: SearchAddon
  private readonly controller: SessionTerminal
  private readonly wrapper: HTMLDivElement
  private readonly host: TerminalInteractionHost | null
  private readonly listeners = new Set<() => void>()
  private readonly interactionListeners = new Set<
    (state: TerminalInteractionState) => void
  >()
  private readonly findRequestListeners = new Set<() => void>()
  private readonly linkRequestListeners = new Set<(request: TerminalLinkRequest) => void>()
  private readonly keyRouter: { dispose(): void }
  private readonly osc52Disposable: { dispose(): void }
  private readonly mouseReportSuppressor: MouseReportSuppressor
  private readonly rightButtonSuppression: TerminalRightButtonSuppression
  private readonly links: TerminalLinks | null
  private readonly themeObserver: MutationObserver
  private readonly inputDisposable: { dispose(): void }
  private readonly resizeDisposable: { dispose(): void }
  private readonly selectionDisposable: { dispose(): void }
  private readonly unsubscribeSettings: () => void
  private settings: TerminalSettings
  private copyOnSelectTimer: ReturnType<typeof setTimeout> | null = null

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
    this.host = options.host ?? null
    this.settings = loadTerminalSettings()
    this.wrapper = document.createElement('div')
    this.wrapper.className = 'terminal-wrapper'
    this.wrapper.style.width = '100%'
    this.wrapper.style.height = '100%'

    this.term = new Terminal(terminalOptionsFor('interactive', this.settings))
    this.fitAddon = new FitAddon()
    this.searchAddon = new SearchAddon()
    this.term.loadAddon(this.fitAddon)
    this.term.loadAddon(this.searchAddon)
    this.term.open(this.wrapper)

    /*
     * Link clicks and the right-click menu both withhold pointer reports from
     * a mouse-aware program. They share one depth-counted suppressor so the
     * second owner never saves the already-true option.
     */
    this.mouseReportSuppressor = createTerminalMouseReportSuppressor(this.term)
    this.rightButtonSuppression = installTerminalRightButtonSuppression(
      this.term,
      this.mouseReportSuppressor,
      {
        shouldSuppress: (event) =>
          shouldWithholdRightButton({
            mouseTracking: this.term.modes.mouseTrackingMode !== 'none',
            ctrlKey: event.ctrlKey,
            altKey: event.altKey
          })
      }
    )

    this.inputDisposable = this.term.onData((data) => {
      void this.controller.write(data)
    })
    this.selectionDisposable = this.term.onSelectionChange(() => {
      this.emitInteractionState()
      this.scheduleCopyOnSelect()
    })
    this.keyRouter = installTerminalKeyRouter(this.term, {
      isMac: isMacPlatform(),
      hasSelection: () => this.term.hasSelection(),
      copySelection: () => {
        void this.copySelection()
      },
      openFind: () => {
        for (const listener of this.findRequestListeners) listener()
      }
    })
    this.osc52Disposable = this.term.parser.registerOscHandler(
      52,
      createOsc52Handler({
        allowWrite: () => !this.disposed && this.settings.osc52,
        write: (text) => this.writeClipboard(text),
        maxBase64Chars: this.settings.osc52MaxBytes
      })
    )
    this.links =
      this.host === null
        ? null
        : installTerminalLinks({
            term: this.term,
            host: this.host,
            isMac: isMacPlatform(),
            getSettings: () => this.settings,
            mouseReportSuppressor: this.mouseReportSuppressor,
            onRequest: (request) => {
              for (const listener of this.linkRequestListeners) listener(request)
            }
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

    this.unsubscribeSettings = subscribeTerminalSettings((next) => {
      if (this.disposed) return
      this.settings = next
      applyTerminalOptions(this.term, next, 'interactive')
      this.links?.update(next)
      this.scheduleFitNow()
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

  isMouseTrackingActive(): boolean {
    return !this.disposed && this.term.modes.mouseTrackingMode !== 'none'
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

  notify(notice: TerminalNotice): void {
    this.host?.notify(notice)
  }

  hasSelection(): boolean {
    return !this.disposed && this.term.hasSelection()
  }

  getSelectionText(): string {
    return this.disposed ? '' : this.term.getSelection()
  }

  async copySelection(): Promise<boolean> {
    if (this.disposed) return false
    const selected = this.term.getSelection()
    if (selected.length === 0) return false
    const text = this.settings.selectionTrim ? trimTerminalSelection(selected) : selected
    if (text.length === 0) return false
    return this.writeClipboard(text)
  }

  /** Copy only the visible viewport, independent of the TUI's own selection. */
  async copyScreenContent(): Promise<boolean> {
    if (this.disposed) return false
    const screen = readScreenText(this.term.buffer.active, this.term.rows)
    const text = this.settings.selectionTrim ? trimTerminalSelection(screen) : screen
    const capped = capClipboardText(text)
    if (capped.length === 0) return false
    return this.writeClipboard(capped)
  }

  selectAll(): void {
    if (!this.disposed) this.term.selectAll()
  }

  clearSelection(): void {
    if (!this.disposed) this.term.clearSelection()
  }

  /** xterm routes paste through its data path, so bracketed paste stays correct. */
  paste(text: string): boolean {
    if (this.disposed || text.length === 0) return false
    if (new TextEncoder().encode(text).length > this.settings.pasteMaxBytes) return false
    this.term.paste(text)
    return true
  }

  find(
    query: string,
    direction: TerminalFindDirection,
    options?: TerminalFindOptions
  ): boolean {
    if (this.disposed || query.length === 0) return false
    const searchOptions = {
      caseSensitive: options?.caseSensitive ?? false,
      regex: options?.regex ?? false,
      incremental: false
    }
    return direction === 'next'
      ? this.searchAddon.findNext(query, searchOptions)
      : this.searchAddon.findPrevious(query, searchOptions)
  }

  clearFind(): void {
    if (this.disposed) return
    this.searchAddon.clearDecorations()
    // The addon keeps the active match selected after decorations are cleared.
    this.searchAddon.findNext('')
  }

  clear(): void {
    if (!this.disposed) this.term.clear()
  }

  reset(): void {
    if (!this.disposed) this.term.reset()
  }

  getMetadata(): TerminalMetadata {
    return { cwd: null, title: null }
  }

  getTranscript(options?: TerminalTranscriptOptions): string {
    if (this.disposed) return ''
    const maxChars = options?.maxChars ?? TERMINAL_CLIPBOARD_MAX_CHARS
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    const text = lines.join('\n').replace(/\n+$/u, '')
    return text.length > maxChars ? text.slice(-maxChars) : text
  }

  onInteractionState(listener: (state: TerminalInteractionState) => void): () => void {
    if (this.disposed) return () => undefined
    this.interactionListeners.add(listener)
    listener(this.interactionState())
    return () => this.interactionListeners.delete(listener)
  }

  onFindRequest(listener: () => void): () => void {
    if (this.disposed) return () => undefined
    this.findRequestListeners.add(listener)
    return () => this.findRequestListeners.delete(listener)
  }

  onLinkRequest(listener: (request: TerminalLinkRequest) => void): () => void {
    if (this.disposed) return () => undefined
    this.linkRequestListeners.add(listener)
    return () => this.linkRequestListeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.interactionListeners.clear()
    this.findRequestListeners.clear()
    this.linkRequestListeners.clear()
    this.links?.dispose()
    this.rightButtonSuppression.dispose()
    this.mouseReportSuppressor.restore()
    if (this.copyOnSelectTimer !== null) {
      clearTimeout(this.copyOnSelectTimer)
      this.copyOnSelectTimer = null
    }
    this.keyRouter.dispose()
    this.osc52Disposable.dispose()
    if (this.fitFrame !== null) {
      window.cancelAnimationFrame(this.fitFrame)
      this.fitFrame = null
    }
    this.clearContainerFitTimer()
    this.unsubscribeLayoutResize()
    this.unsubscribeSettings()
    this.resizeHold.dispose()
    this.themeObserver.disconnect()
    this.inputDisposable.dispose()
    this.resizeDisposable.dispose()
    this.selectionDisposable.dispose()
    this.controller.dispose()
    this.term.dispose()
    this.wrapper.remove()
    this.attachedContainer = null
    this.attachment = null
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      if (this.host !== null) return await this.host.writeClipboard(text)
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  /**
   * Copy-on-select is debounced so a drag does not write the clipboard on every
   * intermediate selection update.
   */
  private scheduleCopyOnSelect(): void {
    if (this.disposed || !this.settings.copyOnSelect || !this.term.hasSelection()) return
    if (this.copyOnSelectTimer !== null) clearTimeout(this.copyOnSelectTimer)
    this.copyOnSelectTimer = setTimeout(() => {
      this.copyOnSelectTimer = null
      if (!this.disposed && this.settings.copyOnSelect && this.term.hasSelection()) {
        void this.copySelection()
      }
    }, 100)
  }

  private interactionState(): TerminalInteractionState {
    return { hasSelection: this.term.hasSelection() }
  }

  private emitInteractionState(): void {
    if (this.disposed) return
    const state = this.interactionState()
    for (const listener of this.interactionListeners) listener(state)
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
