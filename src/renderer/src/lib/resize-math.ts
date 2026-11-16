/**
 * Geometry for live panel drags, kept free of DOM and React so it can be unit
 * tested. Callers read the starting value and scale once when the drag begins;
 * every frame only supplies the current pointer coordinate.
 */

export type PointerValueInput = {
  startValue: number
  startPointer: number
  pointer: number
  /** 1 for a seam that grows with the pointer, -1 for a right-hand seam. */
  direction?: 1 | -1
  /** Value units per pointer pixel. Split drags pass 1 / span. */
  scale?: number
}

export function valueFromPointer(input: PointerValueInput): number {
  const { startValue, startPointer, pointer, direction = 1, scale = 1 } = input
  if (
    !Number.isFinite(startValue) ||
    !Number.isFinite(startPointer) ||
    !Number.isFinite(pointer) ||
    !Number.isFinite(scale)
  ) {
    return startValue
  }
  return startValue + (pointer - startPointer) * direction * scale
}

/**
 * Pointer position as a 0–1 ratio of a container. Returns null for a
 * collapsed container so the caller can abort instead of dividing by zero.
 */
export function ratioFromRect(
  rect: { left: number; top: number; width: number; height: number },
  horizontal: boolean,
  clientX: number,
  clientY: number
): number | null {
  const span = horizontal ? rect.width : rect.height
  if (!Number.isFinite(span) || span <= 0) return null
  const offset = horizontal ? clientX - rect.left : clientY - rect.top
  if (!Number.isFinite(offset)) return null
  return offset / span
}
