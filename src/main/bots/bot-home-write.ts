import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Replaces a file whole or not at all, so a crash mid-write leaves the old one. */
export function replaceTextFileSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, path)
}
