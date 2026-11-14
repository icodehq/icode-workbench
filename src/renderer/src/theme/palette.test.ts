/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')

function token(name: string): string | null {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
  return match?.[1]?.trim() ?? null
}

describe('Workbench palette contract', () => {
  it('uses the approved afterglow surface and accent values', () => {
    expect(token('--icode-canvas')).toBe('#212121')
    expect(token('--icode-panel')).toBe('#2A2A2C')
    expect(token('--icode-raised')).toBe('#303032')
    expect(token('--icode-overlay')).toBe('#333335')
    expect(token('--icode-ink-1')).toBe('#E6E6E8')
    expect(token('--icode-accent')).toBe('#7D8CFF')
    expect(token('--icode-focus')).toBe('#7D8CFF')
  })

  it('keeps green as a status and brand color', () => {
    expect(token('--icode-brand')).toBe('#3FB950')
    expect(token('--icode-add')).toBe('#3FB950')
    expect(token('--icode-accent')).not.toBe('#3FB950')
  })

  it('uses the prototype light canvas and accent', () => {
    const light = css.slice(css.indexOf(":root[data-theme='light']"))
    expect(light).toContain('--icode-canvas: #FAFAFA;')
    expect(light).toContain('--icode-accent: #2F62D8;')
  })
})
