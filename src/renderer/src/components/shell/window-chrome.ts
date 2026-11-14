import { isMacPlatform } from '../../lib/platform'

/** Space reserved for macOS traffic lights inside the sidebar brand row. */
export const MAC_TRAFFIC_LIGHT_INSET = 78

/** Space reserved for Windows/Linux controls at the right edge of a header. */
export const WINDOW_CONTROLS_INSET = 138

export function usesCustomWindowControls(platform: string | null): boolean {
  return !isMacPlatform(platform)
}

export function sidebarBrandInset(platform: string | null): number {
  return isMacPlatform(platform) ? MAC_TRAFFIC_LIGHT_INSET : 0
}

export function headerRightInset(platform: string | null): number {
  return usesCustomWindowControls(platform) ? WINDOW_CONTROLS_INSET : 0
}

/**
 * The frameless window is usable down to 760px. Controls stay visible at that
 * width; the sidebar becomes a drawer separately.
 */
export function windowControlsVisible(width: number): boolean {
  return width >= 760
}
