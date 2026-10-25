/**
 * Durable Guest Host records, one file per distro registration.
 *
 * Keyed by `distroId` rather than by name: a renamed distro keeps its Host, and
 * a reimported distro under the old name must not inherit one.
 *
 * A record that cannot be parsed is treated as absent, but the file is left in
 * place — deleting it would destroy the only evidence a later diagnostic has.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WslGuestHostRecord } from './records'
import { parseWslGuestHostRecord } from './records'

export type GuestHostStore = {
  read(distroId: string): WslGuestHostRecord | null
  write(record: WslGuestHostRecord): void
  remove(distroId: string): void
}

export function guestHostRecordPath(directory: string, distroId: string): string {
  return join(directory, `${encodeURIComponent(distroId.trim().toLowerCase())}.json`)
}

export function createGuestHostStore(directory: string): GuestHostStore {
  return {
    read(distroId) {
      try {
        return parseWslGuestHostRecord(readFileSync(guestHostRecordPath(directory, distroId), 'utf8'))
      } catch {
        return null
      }
    },
    write(record) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const target = guestHostRecordPath(directory, record.distroId)
      const temp = `${target}.tmp-${process.pid}`
      writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
      renameSync(temp, target)
    },
    remove(distroId) {
      rmSync(guestHostRecordPath(directory, distroId), { force: true })
    }
  }
}
