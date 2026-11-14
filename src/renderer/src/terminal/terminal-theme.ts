import type { ITheme } from '@xterm/xterm'

/**
 * Terminal palette.
 *
 * The terminal keeps a dark, neutral ground in both appearances, matching the
 * product's "terminal stays dark" rule. The shell around it follows the
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
 * always present here; the fallback only guards against a pane being rendered
 * outside that entry point (tests, storybook-style harnesses).
 */
export function currentThemeName(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}
