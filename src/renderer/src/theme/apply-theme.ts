/**
 * iCode appearance resolution.
 *
 * The renderer starts before React, so this module applies the stored preference
 * (or the OS preference when none is stored) before the first application paint.
 * The same module owns the in-app System / Dark / Light switch.
 *
 * `main.css` keeps the dark palette on `:root` and the light palette under
 * `[data-theme='light']`. Explicit dark is also written as the attribute so the
 * switch wins over a light OS setting.
 */

export type ThemeName = 'dark' | 'light'
export type ThemePreference = 'system' | ThemeName

const LIGHT_QUERY = '(prefers-color-scheme: light)'
const STORAGE_KEY = 'ade.themePreference'

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** The one decision this module makes. Kept pure so it can be checked directly. */
export function resolveTheme(
  prefersLight: boolean,
  preference: ThemePreference = 'system'
): ThemeName {
  if (preference === 'system') return prefersLight ? 'light' : 'dark'
  return preference
}

/** Reads the user's choice without requiring a browser in tests. */
export function getThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'dark' || value === 'light' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** The attribute currently applied to the document. */
export function getResolvedTheme(
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement
): ThemeName {
  return root?.dataset.theme === 'light' ? 'light' : 'dark'
}

/** Writes the attribute the stylesheet switches on. */
export function applyTheme(
  theme: ThemeName,
  root: HTMLElement = document.documentElement
): void {
  const changed = root.dataset.theme !== theme
  root.dataset.theme = theme
  if (changed) notify()
}

/**
 * Writes the preference and applies the resulting theme immediately.
 *
 * `notify` is called even when the resolved appearance does not change: the
 * Settings segmented control still needs to show that the *preference* changed
 * (for example System dark → explicit Dark).
 */
export function setThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // A disabled storage backend must not block the toggle.
  }
  const query = window.matchMedia(LIGHT_QUERY)
  applyTheme(resolveTheme(query.matches, preference))
  notify()
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let dispose: (() => void) | null = null

/**
 * Applies the current preference and follows later OS changes while the
 * preference is System. Repeating the call does not add a second listener.
 */
export function initTheme(): () => void {
  if (dispose !== null) return dispose

  const query = window.matchMedia(LIGHT_QUERY)
  const sync = (): void => {
    applyTheme(resolveTheme(query.matches, getThemePreference()))
  }

  sync()
  query.addEventListener('change', sync)

  dispose = () => {
    query.removeEventListener('change', sync)
    dispose = null
  }
  return dispose
}
