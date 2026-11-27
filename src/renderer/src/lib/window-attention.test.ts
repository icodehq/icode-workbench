import { describe, expect, it } from 'vitest'
import { windowIsAttended } from './window-attention'

const doc = (visibilityState: DocumentVisibilityState, focused: boolean) =>
  ({ visibilityState, hasFocus: () => focused }) as Pick<Document, 'visibilityState' | 'hasFocus'>

describe('window attention', () => {
  it('requires a visible document and a focused window', () => {
    expect(windowIsAttended(doc('visible', true))).toBe(true)
    expect(windowIsAttended(doc('visible', false))).toBe(false)
    expect(windowIsAttended(doc('hidden', true))).toBe(false)
    expect(windowIsAttended(doc('hidden', false))).toBe(false)
  })
})
