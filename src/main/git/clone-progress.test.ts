import { describe, expect, it } from 'vitest'
import { createCloneProgressReader, parseCloneProgressLine } from './clone-progress'

describe('parseCloneProgressLine', () => {
  it('maps the clone phases', () => {
    expect(parseCloneProgressLine("Cloning into 'repo'...")?.phase).toBe('starting')
    expect(parseCloneProgressLine('remote: Enumerating objects: 120, done.')?.phase).toBe(
      'enumerating'
    )
    expect(parseCloneProgressLine('remote: Counting objects:  45% (54/120)')?.phase).toBe(
      'counting'
    )
    expect(parseCloneProgressLine('remote: Compressing objects:  12% (3/25)')?.phase).toBe(
      'compressing'
    )
    expect(parseCloneProgressLine('Receiving objects:  67% (80/120)')?.phase).toBe('receiving')
    expect(parseCloneProgressLine('Resolving deltas:  50% (10/20)')?.phase).toBe('resolving')
    expect(parseCloneProgressLine('Updating files:  80% (800/1000)')?.phase).toBe('checking-out')
    expect(parseCloneProgressLine('Checking out files:  80% (800/1000)')?.phase).toBe(
      'checking-out'
    )
  })

  it('reports the percentage and object counts', () => {
    const progress = parseCloneProgressLine('Receiving objects:  67% (80/120), 1.2 MiB')
    expect(progress).toMatchObject({
      percent: 67,
      objectsDone: 80,
      objectsTotal: 120
    })
  })

  it('ignores banners and unrecognized text', () => {
    expect(parseCloneProgressLine('Welcome to Ubuntu!')).toBeNull()
    expect(parseCloneProgressLine('')).toBeNull()
    expect(parseCloneProgressLine('remote: Total 120 (delta 3)')).toBeNull()
  })

  it('redacts credentials before a detail is shown', () => {
    const progress = parseCloneProgressLine(
      "Cloning into 'repo' from https://alice:ghp_secret@github.com/o/r.git"
    )
    expect(progress?.detail).not.toContain('ghp_secret')
    expect(progress?.detail).toContain('https://***@github.com')
  })
})

describe('createCloneProgressReader', () => {
  it('assembles CR-delimited progress updates', () => {
    const seen: string[] = []
    const reader = createCloneProgressReader((progress) => seen.push(progress.phase))
    reader.push(Buffer.from('Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\r'))
    expect(seen).toEqual(['receiving', 'receiving'])
  })

  it('handles chunk boundaries and CRLF', () => {
    const percents: Array<number | null> = []
    const reader = createCloneProgressReader((progress) => percents.push(progress.percent))
    const text = 'Receiving objects:  42% (42/100)\r\nResolving deltas: 100% (10/10)\r\n'
    for (let index = 0; index < text.length; index += 3) {
      reader.push(Buffer.from(text.slice(index, index + 3)))
    }
    reader.flush()
    expect(percents).toEqual([42, 100])
  })

  it('decodes split multi-byte characters', () => {
    const details: string[] = []
    const reader = createCloneProgressReader((progress) => details.push(progress.detail))
    const bytes = Buffer.from('Cloning into “仓库”...\n', 'utf8')
    reader.push(bytes.subarray(0, bytes.length - 2))
    reader.push(bytes.subarray(bytes.length - 2))
    reader.flush()
    expect(details[0]).toContain('仓库')
  })

  it('does not grow without bound on an endless line', () => {
    const seen: string[] = []
    const reader = createCloneProgressReader((progress) => seen.push(progress.detail))
    reader.push(Buffer.from('x'.repeat(20_000)))
    reader.push(Buffer.from('\nReceiving objects:  10% (1/10)\n'))
    reader.flush()
    expect(seen.length).toBeLessThanOrEqual(1)
    expect(seen.every((detail) => detail.length <= 300)).toBe(true)
  })
})
