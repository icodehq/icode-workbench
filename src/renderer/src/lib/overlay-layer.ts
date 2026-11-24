/**
 * Tracks transient overlays (context menus and anchored popovers) that sit
 * above the current view.
 *
 * View-level Escape shortcuts listen on `window` in the capture phase, so they
 * run before any overlay handler and can swallow the key. Panes that dismiss
 * themselves with Escape consult this registry and yield while an overlay is
 * open, leaving one Escape to close only the topmost layer.
 */
let openOverlays = 0

export function isOverlayOpen(): boolean {
  return openOverlays > 0
}

/** Marks an overlay open until the returned release runs. */
export function holdOverlay(): () => void {
  openOverlays += 1
  let released = false
  return () => {
    if (released) return
    released = true
    openOverlays -= 1
  }
}

/** Test hook: forget any overlay left behind between cases. */
export function resetOverlayLayers(): void {
  openOverlays = 0
}
