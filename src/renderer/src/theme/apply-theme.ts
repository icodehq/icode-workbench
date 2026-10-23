/**
 * Resolves and applies the Instrument A2 appearance.
 *
 * There is no theme setting and no persisted override: the operating system
 * decides, exactly as A2 assumes. `main.css` holds the dark palette on `:root`
 * and the light palette under `[data-theme='light']`, so this module's only job
 * is to keep that one attribute in step with `prefers-color-scheme`.
 *
 * `main.tsx` calls `initTheme()` once, before React renders, because the page is
 * served with `script-src 'self'` and therefore cannot carry an inline
 * bootstrap script that would run earlier.
 */

export type ThemeName = 'dark' | 'light'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

/** The one decision this module makes. Kept pure so it can be checked directly. */
export function resolveTheme(prefersLight: boolean): ThemeName {
  return prefersLight ? 'light' : 'dark'
}

/** Writes the attribute the stylesheet switches on. */
export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme
}

let dispose: (() => void) | null = null

/**
 * Applies the current preference and follows later changes.
 *
 * Returns a disposer for symmetry with React effects, but the renderer keeps
 * this for the lifetime of the window. Repeating the call does not add a second
 * listener.
 */
export function initTheme(): () => void {
  if (dispose !== null) return dispose

  const query = window.matchMedia(LIGHT_QUERY)
  const sync = (): void => {
    applyTheme(resolveTheme(query.matches))
  }

  sync()
  query.addEventListener('change', sync)

  dispose = () => {
    query.removeEventListener('change', sync)
    dispose = null
  }
  return dispose
}
