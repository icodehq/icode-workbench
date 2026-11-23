import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUpdateLogger } from './update-log'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'icode-update-log-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true })
  }
})

describe('update log', () => {
  it('writes timestamped lines', () => {
    const file = join(tempDirectory(), 'logs', 'update.log')
    const logger = createUpdateLogger(file, { now: () => 1_000 })
    logger.info('checking', 1)
    logger.error(new Error('boom'))
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('1970-01-01T00:00:01.000Z INFO checking 1')
    expect(text).toContain('ERROR Error: boom')
  })

  it('rotates once the file reaches the bound', () => {
    const directory = tempDirectory()
    const file = join(directory, 'update.log')
    const logger = createUpdateLogger(file, { maxBytes: 40, now: () => 1_000 })
    logger.info('first line that is long enough to exceed the bound')
    const rotated = `${file}.1`
    const first = readFileSync(file, 'utf8')
    logger.info('second')
    expect(existsSync(rotated)).toBe(true)
    expect(readFileSync(rotated, 'utf8')).toBe(first)
    expect(readFileSync(file, 'utf8')).toContain('second')
  })
})
