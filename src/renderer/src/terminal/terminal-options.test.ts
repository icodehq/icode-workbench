import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalOptionsFor } from './terminal-options'

function stubTheme(): void {
  vi.stubGlobal('document', {
    documentElement: { dataset: { theme: 'dark' } }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminalOptionsFor', () => {
  it('keeps right-click selection under the pane policy on every profile', () => {
    stubTheme()
    expect(terminalOptionsFor('interactive').rightClickSelectsWord).toBe(false)
    expect(terminalOptionsFor('preview').rightClickSelectsWord).toBe(false)
  })
})
