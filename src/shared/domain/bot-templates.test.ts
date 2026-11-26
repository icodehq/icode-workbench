import { describe, expect, it } from 'vitest'
import { BOT_TEMPLATE_CATEGORIES, BOT_TEMPLATES } from './bot-templates'

describe('official bot templates', () => {
  it('ships 25 unique templates across all categories', () => {
    expect(BOT_TEMPLATES).toHaveLength(25)
    expect(new Set(BOT_TEMPLATES.map((template) => template.id)).size).toBe(25)
    expect(new Set(BOT_TEMPLATES.map((template) => template.name)).size).toBe(25)
    expect(new Set(BOT_TEMPLATES.map((template) => template.category))).toEqual(
      new Set(BOT_TEMPLATE_CATEGORIES)
    )
  })

  it('gives every template a usable role, instructions and starting memory', () => {
    for (const template of BOT_TEMPLATES) {
      expect(template.role.trim().length).toBeGreaterThan(0)
      expect(template.instructions.trim().length).toBeGreaterThan(80)
      expect(template.seedMemory.trim().length).toBeGreaterThan(0)
      expect(template.mascot.length).toBeGreaterThan(0)
      expect(template.outfit.length).toBeGreaterThan(0)
    }
  })
})
