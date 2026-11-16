import type { ITheme, Terminal } from '@xterm/xterm'

/**
 * Terminal palette.
 *
 * The terminal follows the app appearance. Light mode is drawn for the light
 * canvas rather than inverted from the dark palette: a light theme has to look
 * like a light theme, with ANSI hues deepened until they read on paper.
 *
 * ANSI white and bright white are ink, not paper (Termio learned this the hard
 * way — agents such as Claude Code print the version, cwd and shortcut hints in
 * SGR 37, which disappears at 1.07:1 on a white ground). Slots 7 and 15 are
 * therefore mapped to #4D4D4D and #262626, as Termio maps them in its light
 * default.
 *
 * Every ANSI colour below clears 4.5:1 against `#FAFAFA`; `terminal-theme.test`
 * enforces it. Keep the dark palette as the afterglow surface the shell uses.
 */
export const TERMINAL_THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#FAFAFA',
    foreground: '#383A42',
    cursor: '#2F62D8',
    cursorAccent: '#FAFAFA',
    selectionBackground: 'rgba(47, 98, 216, 0.16)',
    selectionInactiveBackground: 'rgba(47, 98, 216, 0.08)',
    black: '#383A42',
    red: '#CF222E',
    green: '#116329',
    yellow: '#9A6700',
    blue: '#0969DA',
    magenta: '#8250DF',
    cyan: '#1B7C83',
    white: '#4D4D4D',
    brightBlack: '#57606A',
    brightRed: '#A40E26',
    brightGreen: '#1A7F37',
    brightYellow: '#633C01',
    brightBlue: '#0550AE',
    brightMagenta: '#6639BA',
    brightCyan: '#0A6C74',
    brightWhite: '#262626'
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
 * xterm's dynamic contrast floor. Light themes get a floor because programs can
 * set colours at runtime (OSC 4) that the palette above cannot protect against;
 * dark themes keep xterm's default of 1 because their intentionally dim slots
 * are part of the design. Termio uses 1.5 for light themes; xterm adjusts the
 * foreground instead of snapping it to black or white, so the same floor only
 * rescues genuinely invisible text here.
 */
export const TERMINAL_MINIMUM_CONTRAST: Record<'light' | 'dark', number> = {
  light: 1.5,
  dark: 1
}

/**
 * The appearance the document is currently in.
 *
 * `main.tsx` resolves the theme before React renders, so the attribute is
 * always present here; the fallback only guards against a pane being rendered
 * outside that entry point (tests, storybook-style harnesses).
 */
export function currentThemeName(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * The xterm options for the current appearance. A fresh theme object is
 * required: xterm compares the option by reference, and that is what makes a
 * live appearance switch repaint open terminals.
 */
export function terminalThemeOptions(): {
  theme: ITheme
  minimumContrastRatio: number
} {
  const appearance = currentThemeName()
  return {
    theme: { ...TERMINAL_THEMES[appearance] },
    minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST[appearance]
  }
}

/** Re-themes an open terminal without touching its buffer or PTY. */
export function applyTerminalTheme(term: Terminal): void {
  const { theme, minimumContrastRatio } = terminalThemeOptions()
  // The contrast floor goes first so the repaint the theme setter triggers
  // already resolves every cell against the new value.
  term.options.minimumContrastRatio = minimumContrastRatio
  term.options.theme = theme
}
