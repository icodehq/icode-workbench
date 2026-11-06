export type MenuAnchor = {
  top: number
  bottom: number
  left: number
  right: number
}

export type MenuPlacement = 'above' | 'below'

export type MenuPositionInput = {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  anchor?: MenuAnchor
  align?: 'start' | 'end'
  margin?: number
  gap?: number
}

export type MenuPosition = {
  left: number
  top: number
  placement: MenuPlacement
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Positions an anchored menu within the viewport.
 *
 * Cursor mode uses `x/y` as the top-left corner. Anchor mode starts below the
 * trigger, flips above when there is no room below, and clamps to the margin so
 * a menu near an edge never leaves the window.
 */
export function menuPosition(input: MenuPositionInput): MenuPosition {
  const margin = input.margin ?? 8
  const gap = input.gap ?? 4
  const maxLeft = Math.max(margin, input.viewportWidth - input.width - margin)
  const maxTop = Math.max(margin, input.viewportHeight - input.height - margin)

  if (input.anchor === undefined) {
    return {
      left: clamp(input.x, margin, maxLeft),
      top: clamp(input.y, margin, maxTop),
      placement: 'below'
    }
  }

  const anchor = input.anchor
  const left = input.align === 'end' ? anchor.right - input.width : anchor.left
  const below = anchor.bottom + gap
  const above = anchor.top - input.height - gap
  const fitsBelow = below + input.height <= input.viewportHeight - margin
  const fitsAbove = above >= margin
  const placement: MenuPlacement = fitsBelow || !fitsAbove ? 'below' : 'above'
  const top = placement === 'above' ? above : below

  return {
    left: clamp(left, margin, maxLeft),
    top: clamp(top, margin, maxTop),
    placement
  }
}
