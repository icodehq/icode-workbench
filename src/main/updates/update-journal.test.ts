import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUpdateJournal, UPDATE_JOURNAL_VERSION } from './update-journal'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'icode-update-journal-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true })
  }
})

describe('update journal', () => {
  it('round-trips the last install attempt and clears it', () => {
    const journal = createUpdateJournal(tempDirectory())
    const entry = {
      version: UPDATE_JOURNAL_VERSION,
      fromVersion: '0.23.1',
      toVersion: '0.24.0',
      startedAt: 1_000,
      installerPath: 'C:\\Users\\dev\\AppData\\Local\\icode-updater\\pending\\setup.exe'
    }
    journal.begin(entry)
    expect(journal.read()).toEqual(entry)
    journal.clear()
    expect(journal.read()).toBeNull()
  })

  it('ignores a malformed or foreign journal', () => {
    const directory = tempDirectory()
    writeFileSync(join(directory, 'last-install.json'), '{not json')
    expect(createUpdateJournal(directory).read()).toBeNull()

    writeFileSync(
      join(directory, 'last-install.json'),
      JSON.stringify({ version: 99, fromVersion: 'a', toVersion: 'b', startedAt: 1 })
    )
    expect(createUpdateJournal(directory).read()).toBeNull()
  })
})
