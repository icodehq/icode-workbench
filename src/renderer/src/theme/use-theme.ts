import { useCallback, useSyncExternalStore } from 'react'
import {
  getResolvedTheme,
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemeName,
  type ThemePreference
} from './apply-theme'

export type ThemeState = {
  preference: ThemePreference
  resolved: ThemeName
  setPreference: (preference: ThemePreference) => void
}

/**
 * Subscribes the shell to both the stored preference and the applied theme.
 *
 * The resolved theme is read from the document attribute rather than recomputed
 * from the media query: `initTheme` already resolved it before React mounted,
 * and the media listener notifies this hook when the OS changes under System.
 */
export function useThemePreference(): ThemeState {
  const preference = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    () => 'light' as const
  )
  const resolved = useSyncExternalStore(
    subscribeTheme,
    getResolvedTheme,
    () => 'dark' as const
  )
  const setPreference = useCallback((next: ThemePreference) => {
    setThemePreference(next)
  }, [])
  return { preference, resolved, setPreference }
}
