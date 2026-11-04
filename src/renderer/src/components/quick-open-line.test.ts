import { describe, expect, it } from 'vitest'
import { splitLineSuffix } from '../components/QuickOpen'

/**
 * `path:line` is accepted by Orca's palette and is how a search hit or a compiler
 * message is usually pasted. The parser must not turn an ordinary name into a
 * jump, so only a trailing positive integer counts.
 */
describe('quick open line suffix', () => {
  it('splits a path and a line', () => {
    expect(splitLineSuffix('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 })
    expect(splitLineSuffix('a.ts:1')).toEqual({ path: 'a.ts', line: 1 })
  })

  it('leaves a plain path alone', () => {
    expect(splitLineSuffix('src/app.ts')).toEqual({ path: 'src/app.ts', line: null })
    expect(splitLineSuffix('a:1/b.ts')).toEqual({ path: 'a:1/b.ts', line: null })
    expect(splitLineSuffix('notes:')).toEqual({ path: 'notes:', line: null })
  })

  it('rejects a line that is not a positive integer', () => {
    expect(splitLineSuffix('app.ts:0')).toEqual({ path: 'app.ts:0', line: null })
    expect(splitLineSuffix('app.ts:-3')).toEqual({ path: 'app.ts:-3', line: null })
    expect(splitLineSuffix('app.ts:abc')).toEqual({ path: 'app.ts:abc', line: null })
  })

  it('trims surrounding whitespace', () => {
    expect(splitLineSuffix('  src/app.ts:7  ')).toEqual({ path: 'src/app.ts', line: 7 })
  })
})
