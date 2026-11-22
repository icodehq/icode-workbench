import type { IDisposable, Terminal } from '@xterm/xterm'
import { translate } from '../../i18n/i18n-store'
import type { TerminalSettings } from '../terminal-settings'
import type {
  TerminalInteractionHost,
  TerminalLinkRequest
} from '../terminal-interaction-host'
import {
  findTerminalHttpLinkAtPosition,
  terminalBufferPositionForMouseEvent
} from './link-hit-testing'
import {
  installTerminalLinkPointerGesture,
  isLinkModifierClick
} from './link-gesture'
import { createUrlLinkProvider } from './url-link-provider'
import { classifyExternalUrl } from './url-routing'

type TerminalLinksOptions = {
  term: Terminal
  host: TerminalInteractionHost
  isMac: boolean
  getSettings: () => TerminalSettings
  onRequest: (request: TerminalLinkRequest) => void
}

export type TerminalLinks = IDisposable & {
  update: (settings: TerminalSettings) => void
}

/**
 * Installs URL text links and OSC 8 handling on one terminal.
 *
 * Plain click opens the React action popover; the platform modifier opens
 * directly. In a mouse-aware TUI the click is withheld from the PTY so the
 * program cannot act on it as well.
 */
export function installTerminalLinks(options: TerminalLinksOptions): TerminalLinks {
  let settings = options.getSettings()
  let disposed = false
  const hasLinkUnderPointer = (event: MouseEvent): boolean => {
    // xterm decorates its screen with this class while an OSC 8 or text link is
    // hovered; the class is the only signal for OSC 8 links whose text is not a URL.
    const screen = options.term.element?.querySelector('.xterm-screen')
    if (screen?.classList.contains('xterm-cursor-pointer') === true) return true
    const position = terminalBufferPositionForMouseEvent(options.term, event)
    return (
      position !== null && findTerminalHttpLinkAtPosition(options.term, position) !== null
    )
  }
  const gesture = installTerminalLinkPointerGesture(options.term, {
    shouldSuppressMouseReport: (event) => {
      // Shift extends a selection, and a plain click is a no-op when the user
      // opted into modifier-only links; neither is a TUI click we should eat.
      if (event.shiftKey) return false
      if (!isLinkModifierClick(event, options.isMac) && settings.openLinksWithModifier) {
        return false
      }
      return hasLinkUnderPointer(event)
    }
  })

  const openUrl = (url: string): void => {
    if (disposed) return
    void options.host.openExternal(url)
  }
  const copyUrl = (url: string): void => {
    if (disposed) return
    void options.host.writeClipboard(url)
  }
  const notifyBlocked = (): void => {
    options.host.notify({ tone: 'error', message: translate('terminal.linkBlocked') })
  }

  const activate = (event: MouseEvent, rawUrl: string): void => {
    if (disposed) return
    const decision = classifyExternalUrl(rawUrl)
    if (decision.kind !== 'http') {
      notifyBlocked()
      return
    }
    if (!gesture.canActivate(event)) return

    if (isLinkModifierClick(event, options.isMac)) {
      openUrl(decision.url)
      return
    }
    if (settings.openLinksWithModifier) return
    options.onRequest({
      url: decision.url,
      x: event.clientX,
      y: event.clientY,
      open: () => openUrl(decision.url),
      copy: () => copyUrl(decision.url)
    })
  }

  /*
   * xterm registers its OSC 8 provider before this one and drops lower-priority
   * links that intersect a higher-priority range, so an OSC-linked cell is never
   * duplicated by text URL detection.
   */
  const providerDisposable = options.term.registerLinkProvider(
    createUrlLinkProvider({
      term: options.term,
      activate,
      isDisposed: () => disposed
    })
  )
  options.term.options.linkHandler = {
    allowNonHttpProtocols: false,
    activate: (event, text) => activate(event, text),
    hover: () => undefined,
    leave: () => undefined
  }

  return {
    update: (next) => {
      settings = next
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      providerDisposable.dispose()
      gesture.dispose()
      options.term.options.linkHandler = null
    }
  }
}
