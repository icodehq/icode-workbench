import { describe, expect, it } from 'vitest'
import { createMouseReportSuppressor } from './mouse-report-suppressor'

function setup(initial: boolean | undefined): {
  suppressor: ReturnType<typeof createMouseReportSuppressor>
  writes: (boolean | undefined)[]
  current: () => boolean | undefined
} {
  let value: boolean | undefined = initial
  const writes: (boolean | undefined)[] = []
  const suppressor = createMouseReportSuppressor({
    read: () => value,
    write: (next) => {
      value = next
      writes.push(next)
    }
  })
  return { suppressor, writes, current: () => value }
}

describe('createMouseReportSuppressor', () => {
  it('saves once and restores on the last release', () => {
    const { suppressor, writes, current } = setup(false)
    suppressor.suppress()
    expect(current()).toBe(true)
    expect(suppressor.isActive()).toBe(true)

    suppressor.release()
    expect(current()).toBe(false)
    expect(writes).toEqual([true, false])
    expect(suppressor.isActive()).toBe(false)
  })

  it('nests owners without saving the already-true value', () => {
    const { suppressor, writes, current } = setup(false)
    suppressor.suppress()
    suppressor.suppress()
    expect(writes).toEqual([true])

    suppressor.release()
    expect(current()).toBe(true)
    suppressor.release()
    expect(current()).toBe(false)
    expect(writes).toEqual([true, false])
  })

  it('ignores release without suppress', () => {
    const { suppressor, writes } = setup(true)
    suppressor.release()
    expect(writes).toEqual([])
    expect(suppressor.isActive()).toBe(false)
  })

  it('restores an originally undefined option', () => {
    const { suppressor, writes, current } = setup(undefined)
    suppressor.suppress()
    expect(current()).toBe(true)
    suppressor.release()
    expect(current()).toBeUndefined()
    expect(writes).toEqual([true, undefined])
  })

  it('force-restores every outstanding owner', () => {
    const { suppressor, writes, current } = setup(false)
    suppressor.suppress()
    suppressor.suppress()
    suppressor.restore()
    expect(current()).toBe(false)
    expect(suppressor.isActive()).toBe(false)
    suppressor.release()
    expect(writes).toEqual([true, false])
  })

  it('survives an overlapping left/right press in either release order', () => {
    const { suppressor, writes, current } = setup(false)
    suppressor.suppress() // link click
    suppressor.suppress() // right click
    suppressor.release()
    suppressor.release()
    expect(current()).toBe(false)
    expect(writes).toEqual([true, false])
  })
})
