/**
 * Platform-aware modifier labels for visible shortcut hints.
 *
 * Behaviour still keys off the event's meta/ctrl flags; this module only makes
 * the label a Mac user reads match the key they actually press. Electron's
 * Chromium UA reports `Macintosh` on macOS, so hints are correct before the
 * runtime platform has loaded.
 */

export type RendererPlatform = 'darwin' | 'win32' | 'linux' | string

let runtimePlatform: RendererPlatform | null = null

/** Mirrors the runtime platform; used when the UA is not specific enough. */
export function setRendererPlatform(platform: string | null | undefined): void {
  runtimePlatform = platform && platform.length > 0 ? platform : null
}

export function detectedPlatform(): RendererPlatform {
  if (runtimePlatform !== null) return runtimePlatform
  if (typeof navigator !== 'undefined') {
    if (/mac/i.test(navigator.userAgent)) return 'darwin'
    if (/win/i.test(navigator.userAgent)) return 'win32'
  }
  return 'linux'
}

export function isMacPlatform(platform?: string | null): boolean {
  return (platform ?? detectedPlatform()) === 'darwin'
}

/** `Cmd` on macOS; `Ctrl` everywhere else. */
export function modifierLabel(platform?: string | null): 'Cmd' | 'Ctrl' {
  return isMacPlatform(platform) ? 'Cmd' : 'Ctrl'
}

/** A chord as it appears in menus and titles: `Cmd+K`, `Ctrl+K`. */
export function shortcutLabel(key: string, platform?: string | null): string {
  return `${modifierLabel(platform)}+${key}`
}

/** The palette/search style with a space: `Cmd K`, `Ctrl K`. */
export function shortcutHint(key: string, platform?: string | null): string {
  return `${modifierLabel(platform)} ${key}`
}

/**
 * Cmd+J on macOS, Ctrl+J elsewhere. The other modifier is deliberately
 * ignored, so a Mac user's Ctrl+J stays a shell binding.
 */
export function isFocusTerminalShortcut(
  event: {
    key: string
    metaKey: boolean
    ctrlKey: boolean
    altKey?: boolean
    shiftKey?: boolean
  },
  platform?: string | null
): boolean {
  if (event.key.toLowerCase() !== 'j') return false
  if (event.altKey === true || event.shiftKey === true) return false
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}
