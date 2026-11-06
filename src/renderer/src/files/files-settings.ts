/**
 * Persisted Files preferences.
 *
 * Renderer-only state, so localStorage is the persistence boundary. Defaults
 * keep the current tree honest: only `.DS_Store` and `Thumbs.db` are hidden on
 * top of the hardcoded `.git` guard, compact folders follow VS Code, and file
 * nesting is opt-in.
 */

import { useSyncExternalStore } from 'react'
import { z } from 'zod'

export const filesSettingsSchema = z.object({
  sortOrder: z.enum(['name', 'type', 'modified']).default('name'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
  compactFolders: z.boolean().default(true),
  fileNesting: z.boolean().default(false),
  /** Extra `parent -> child` lines; empty uses only the built-in rules. */
  nestingPatterns: z.array(z.string().max(400)).max(100).default([]),
  gitDecorations: z.boolean().default(true),
  autoReveal: z.boolean().default(true),
  exclude: z
    .array(z.string().min(1).max(400))
    .max(200)
    .default(['.DS_Store', 'Thumbs.db']),
  excludeGitIgnore: z.boolean().default(false),
  useTrash: z.boolean().default(true)
})

export type FilesSettings = z.infer<typeof filesSettingsSchema>

export const DEFAULT_FILES_SETTINGS: FilesSettings = filesSettingsSchema.parse({})

export const FILES_SETTINGS_STORAGE_KEY = 'icode.files.settings.v1'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

const listeners = new Set<(settings: FilesSettings) => void>()

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadFilesSettings(
  storage: ReadableStorage | null = browserStorage()
): FilesSettings {
  if (storage === null) return DEFAULT_FILES_SETTINGS
  let raw: string | null
  try {
    raw = storage.getItem(FILES_SETTINGS_STORAGE_KEY)
  } catch {
    return DEFAULT_FILES_SETTINGS
  }
  if (raw === null) return DEFAULT_FILES_SETTINGS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_FILES_SETTINGS
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_FILES_SETTINGS
  }
  const result = filesSettingsSchema.safeParse({ ...DEFAULT_FILES_SETTINGS, ...parsed })
  return result.success ? result.data : DEFAULT_FILES_SETTINGS
}

export function saveFilesSettings(
  settings: FilesSettings,
  storage: WritableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(FILES_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    return false
  }
  snapshot = settings
  for (const listener of listeners) listener(settings)
  return true
}

export function subscribeFilesSettings(
  listener: (settings: FilesSettings) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updateFilesSettings(
  current: FilesSettings,
  patch: Partial<FilesSettings>,
  storage: WritableStorage | null = browserStorage()
): FilesSettings {
  const next = filesSettingsSchema.parse({ ...current, ...patch })
  saveFilesSettings(next, storage)
  return next
}

let snapshot: FilesSettings | null = null

function getSnapshot(): FilesSettings {
  snapshot ??= loadFilesSettings()
  return snapshot
}

function subscribe(listener: () => void): () => void {
  return subscribeFilesSettings((settings) => {
    snapshot = settings
    listener()
  })
}

export function useFilesSettings(): FilesSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
