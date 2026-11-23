import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_MINIMUM_CONTRAST,
  TERMINAL_THEMES,
  applyTerminalTheme,
  currentThemeName,
  terminalThemeOptions
} from './terminal-theme'

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255
  )
  const [red, green, blue] = channels as [number, number, number]
  const linear = (channel: number): number =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground)
  const second = luminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

function stubAppearance(theme: 'light' | 'dark' | null): void {
  vi.stubGlobal('document', {
    documentElement: { dataset: theme === null ? {} : { theme } }
  })
}

describe('terminal palette', () => {
  it('draws the light terminal on the light canvas and keeps the dark ground', () => {
    expect(TERMINAL_THEMES.light.background).toBe('#FAFAFA')
    expect(TERMINAL_THEMES.light.foreground).toBe('#1F2328')
    expect(TERMINAL_THEMES.dark.background).toBe('#212121')
    expect(TERMINAL_THEMES.dark.foreground).toBe('#E6E6E8')
  })

  it('keeps the default light text well above body-text contrast', () => {
    const light = TERMINAL_THEMES.light
    const background = light.background as string
    expect(contrast(light.foreground as string, background)).toBeGreaterThanOrEqual(10)
  })

  it('keeps every ANSI colour at 4.5:1 or better on the light canvas', () => {
    const light = TERMINAL_THEMES.light
    const background = light.background as string
    for (const key of ANSI_KEYS) {
      const colour = light[key]
      expect(colour, key).toBeTypeOf('string')
      expect(contrast(colour as string, background), key).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('maps ANSI white and bright white to ink on the light canvas', () => {
    const light = TERMINAL_THEMES.light
    const background = light.background as string
    expect(contrast(light.white as string, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light.brightWhite as string, background)).toBeGreaterThanOrEqual(4.5)
  })

  it('gives light themes a contrast floor and leaves dark themes alone', () => {
    expect(TERMINAL_MINIMUM_CONTRAST).toEqual({ light: 4.5, dark: 1 })
  })
})

describe('terminal theme resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the palette and floor from the applied appearance', () => {
    stubAppearance('light')
    expect(currentThemeName()).toBe('light')
    const light = terminalThemeOptions()
    expect(light.theme.background).toBe('#FAFAFA')
    expect(light.minimumContrastRatio).toBe(4.5)
    // xterm compares themes by reference; a fresh object is what repaints.
    expect(light.theme).not.toBe(TERMINAL_THEMES.light)

    stubAppearance('dark')
    expect(currentThemeName()).toBe('dark')
    const dark = terminalThemeOptions()
    expect(dark.theme.background).toBe('#212121')
    expect(dark.minimumContrastRatio).toBe(1)
  })

  it('falls back to the dark palette when no appearance is stamped', () => {
    stubAppearance(null)
    expect(currentThemeName()).toBe('dark')
  })

  it('updates both options on an open terminal', () => {
    stubAppearance('light')
    const term = {
      options: {} as { theme?: unknown; minimumContrastRatio?: number }
    } as unknown as Parameters<typeof applyTerminalTheme>[0]
    applyTerminalTheme(term)
    expect(term.options.minimumContrastRatio).toBe(4.5)
    expect(term.options.theme).toMatchObject({ background: '#FAFAFA' })
  })
})
