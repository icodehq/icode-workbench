import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SCROLLBACK_MAX,
  type TerminalSettings
} from './terminal-settings'
import { terminalThemeOptions } from './terminal-theme'

/**
 * One option set for every xterm we create.
 *
 * The interactive pane and the read-only preview differ only in input, cursor,
 * type size, and retained history. Keeping the shared values here prevents the
 * two constructors from drifting as terminal settings are added.
 */

export const TERMINAL_FONT_FAMILY = DEFAULT_TERMINAL_FONT_FAMILY

/** The host emulator retains the same history, so snapshots cannot restore more. */
export const TERMINAL_SCROLLBACK_LINES = TERMINAL_SCROLLBACK_MAX

const PREVIEW_FONT_SIZE_MAX = 10
const PREVIEW_SCROLLBACK_LINES_MAX = 1000

export type TerminalOptionProfile = 'interactive' | 'preview'

function fontSizeFor(profile: TerminalOptionProfile, settings: TerminalSettings): number {
  return profile === 'preview'
    ? Math.min(settings.fontSize, PREVIEW_FONT_SIZE_MAX)
    : settings.fontSize
}

function scrollbackFor(profile: TerminalOptionProfile, settings: TerminalSettings): number {
  return profile === 'preview'
    ? Math.min(settings.scrollback, PREVIEW_SCROLLBACK_LINES_MAX)
    : settings.scrollback
}

export function terminalOptionsFor(
  profile: TerminalOptionProfile,
  settings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS
): ITerminalOptions {
  const preview = profile === 'preview'
  return {
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: preview ? false : settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    disableStdin: preview,
    fontFamily: settings.fontFamily,
    fontSize: fontSizeFor(profile, settings),
    lineHeight: settings.lineHeight,
    scrollback: scrollbackFor(profile, settings),
    ...terminalThemeOptions()
  }
}

/** Applies live settings without recreating the terminal or touching its buffer. */
export function applyTerminalOptions(
  term: Terminal,
  settings: TerminalSettings,
  profile: TerminalOptionProfile
): void {
  const preview = profile === 'preview'
  term.options.cursorBlink = preview ? false : settings.cursorBlink
  term.options.cursorStyle = settings.cursorStyle
  term.options.fontFamily = settings.fontFamily
  term.options.fontSize = fontSizeFor(profile, settings)
  term.options.lineHeight = settings.lineHeight
  term.options.scrollback = scrollbackFor(profile, settings)
}
