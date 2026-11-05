import { describe, expect, it } from 'vitest'
import { peekUndo, popUndo, pushUndo, undoLabel, type FileUndoEntry } from './undo-stack'

const create = (path: string, at = 1): FileUndoEntry => ({
  kind: 'create',
  path,
  etag: null,
  at
})

describe('Files undo stack', () => {
  it('pushes newest first and caps the history', () => {
    let stack: FileUndoEntry[] = []
    for (let index = 0; index < 25; index += 1) {
      stack = pushUndo(stack, create(`f${String(index)}.ts`, index))
    }
    expect(stack).toHaveLength(20)
    expect(peekUndo(stack)).toMatchObject({ path: 'f24.ts' })
    expect(stack[19]).toMatchObject({ path: 'f5.ts' })
  })

  it('returns a new stack when peeking and popping', () => {
    const original = [create('a.ts'), create('b.ts')]
    const peeked = peekUndo(original)
    expect(peeked).toMatchObject({ path: 'a.ts' })
    expect(peekUndo([])).toBeNull()
    const popped = popUndo(original)
    expect(popped).toHaveLength(1)
    expect(original).toHaveLength(2)
    expect(peekUndo(popped)).toMatchObject({ path: 'b.ts' })
  })

  it('labels each operation for the notice and toolbar', () => {
    expect(undoLabel(null)).toBe('Nothing to undo')
    expect(undoLabel(create('a.ts'))).toBe('Undo create a.ts')
    expect(
      undoLabel({ kind: 'delete', opId: 'op', paths: ['a', 'b'], at: 1 })
    ).toBe('Undo delete of 2 items')
    expect(
      undoLabel({
        kind: 'move',
        pairs: [{ from: 'a', to: 'b' }],
        at: 1
      })
    ).toBe('Undo move of 1 item')
  })
})
