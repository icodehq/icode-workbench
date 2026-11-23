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
 * therefore mapped to #383A42 and #1F2328, as Termio maps them in its light
 * default.
 *
 * The light slots lean darker than the usual One Light values: default text is
 * near-black and every ANSI colour clears 4.5:1 against `#FAFAFA`;
 * `terminal-theme.test` enforces it. Keep the dark palette as the afterglow
 * surface the shell uses.
 */
export const TERMINAL_THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#FAFAFA',
    foreground: '#1F2328',
    cursor: '#2F62D8',
    cursorAccent: '#FAFAFA',
    selectionBackground: 'rgba(47, 98, 216, 0.22)',
    selectionInactiveBackground: 'rgba(47, 98, 216, 0.1)',
    black: '#1F2328',
    red: '#B9372A',
    green: '#116329',
    yellow: '#7A4F00',
    blue: '#0550AE',
    magenta: '#8250DF',
    cyan: '#1B7C83',
    white: '#383A42',
    brightBlack: '#4A4F57',
    brightRed: '#A40E26',
    brightGreen: '#1A7F37',
    brightYellow: '#633C01',
    brightBlue: '#0550AE',
    brightMagenta: '#6639BA',
    brightCyan: '#0A6C74',
    brightWhite: '#1F2328'
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
 * set colours at runtime (OSC 4, 256-colour and truecolour output) that the
 * palette above cannot protect against. The light floor is 4.5 so every cell
 * clears the normal-text requirement; dark themes keep xterm's default of 1
 * because their intentionally dim slots are part of the design. xterm adjusts
 * the foreground instead of snapping it to black or white, so the floor only
 * darkens text that would otherwise be hard to read on paper.
 */
export const TERMINAL_MINIMUM_CONTRAST: Record<'light' | 'dark', number> = {
  light: 4.5,
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
