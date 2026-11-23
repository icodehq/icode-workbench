import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Durable record of the last install attempt.
 *
 * electron-updater spawns the installer and quits without waiting for its exit
 * code. A failed installer would otherwise leave no trace: the user reopens the
 * old version and sees only "update failed". The journal lets the next launch
 * compare `app.getVersion()` with the target and report an interrupted install.
 */

export const UPDATE_JOURNAL_VERSION = 1
const JOURNAL_FILE = 'last-install.json'

export type UpdateJournalEntry = {
  version: number
  fromVersion: string
  toVersion: string
  startedAt: number
  installerPath: string | null
}

export type UpdateJournal = {
  read(): UpdateJournalEntry | null
  begin(entry: UpdateJournalEntry): void
  clear(): void
}

function parseEntry(raw: unknown): UpdateJournalEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.version !== UPDATE_JOURNAL_VERSION) return null
  if (typeof record.fromVersion !== 'string' || record.fromVersion.length === 0) return null
  if (typeof record.toVersion !== 'string' || record.toVersion.length === 0) return null
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) return null
  if (
    record.installerPath !== null &&
    (typeof record.installerPath !== 'string' || record.installerPath.length === 0)
  ) {
    return null
  }
  return {
    version: UPDATE_JOURNAL_VERSION,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    startedAt: record.startedAt,
    installerPath: record.installerPath as string | null
  }
}

export function createUpdateJournal(directory: string): UpdateJournal {
  const file = join(directory, JOURNAL_FILE)
  return {
    read() {
      try {
        return parseEntry(JSON.parse(readFileSync(file, 'utf8')))
      } catch {
        return null
      }
    },
    begin(entry) {
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        const temp = `${file}.tmp-${process.pid}`
        writeFileSync(temp, JSON.stringify(entry, null, 2), { mode: 0o600 })
        renameSync(temp, file)
      } catch {
        // Diagnostics must never block an install. The version comparison on
        // the next launch simply has no record.
      }
    },
    clear() {
      try {
        if (existsSync(file)) rmSync(file, { force: true })
      } catch {
        // Best-effort: a stale journal only shows one extra notice.
      }
    }
  }
}
