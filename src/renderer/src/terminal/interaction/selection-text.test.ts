import { describe, expect, it } from 'vitest'
import { trimTerminalSelection } from './selection-text'

describe('trimTerminalSelection', () => {
  it('drops trailing blanks from every line', () => {
    expect(trimTerminalSelection('one   \ntwo\t\n')).toBe('one\ntwo')
  })

  it('removes only the indent every non-empty line shares', () => {
    expect(trimTerminalSelection('    one\n      two\n    three')).toBe('one\n  two\nthree')
  })

  it('leaves a single indented line untouched beyond trailing blanks', () => {
    expect(trimTerminalSelection('    one   ')).toBe('    one')
  })

  it('does not invent an indent when lines disagree', () => {
    expect(trimTerminalSelection('  one\nzero')).toBe('  one\nzero')
  })
})
