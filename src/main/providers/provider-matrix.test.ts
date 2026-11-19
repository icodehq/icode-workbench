import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PROVIDER_HARNESSES,
  PROVIDER_RECIPE_HARNESSES
} from '../../shared/domain/provider-recipes'

type MatrixEntry = { status: string; cliVersion: string | null }
type Matrix = {
  checkedAt: string | null
  harnesses: Record<string, MatrixEntry>
}

const matrix = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../tests/verification/providers/matrix.json',
        import.meta.url
      )
    ),
    'utf8'
  )
) as Matrix

describe('provider verification matrix', () => {
  it('has a row for every implemented recipe', () => {
    for (const harness of PROVIDER_RECIPE_HARNESSES) {
      expect(matrix.harnesses[harness], `${harness} has no matrix row`).toBeDefined()
    }
  })

  it('never ships a recipe without a passing or existing row', () => {
    for (const harness of PROVIDER_HARNESSES) {
      expect(
        ['existing', 'pass'],
        `${harness} is shipped without a verified matrix row`
      ).toContain(matrix.harnesses[harness]?.status)
    }
  })

  it('uses only the documented statuses', () => {
    for (const [harness, entry] of Object.entries(matrix.harnesses)) {
      expect(
        ['existing', 'pass', 'fail', 'pending'],
        `${harness} has an unknown status`
      ).toContain(entry.status)
    }
  })
})
