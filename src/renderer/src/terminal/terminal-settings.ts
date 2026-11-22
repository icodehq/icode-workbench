/**
 * Persisted terminal interaction preferences.
 *
 * Everything here affects the renderer only, so localStorage is the boundary,
 * matching the Files and Source Control settings. The host still owns the
 * scrollback cap; a larger renderer value cannot restore more history.
 */

import { useSyncExternalStore } from 'react'
import { z } from 'zod'

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, monospace"

export const TERMINAL_PASTE_DEFAULT_MAX_BYTES = 1024 * 1024
export const TERMINAL_OSC52_DEFAULT_MAX_BYTES = 128 * 1024
export const TERMINAL_SCROLLBACK_MAX = 5000

const quickCommandSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  command: z.string().min(1).max(20_000),
  appendEnter: z.boolean().default(true),
  /** Absent means the command is global. */
  repoId: z.string().min(1).max(128).optional()
})

export const terminalSettingsSchema = z.object({
  fontSize: z.number().int().min(8).max(32).default(12),
  fontFamily: z.string().min(1).max(400).default(DEFAULT_TERMINAL_FONT_FAMILY),
  lineHeight: z.number().min(0.8).max(2).default(1.2),
  cursorStyle: z.enum(['block', 'underline', 'bar']).default('block'),
  cursorBlink: z.boolean().default(true),
  scrollback: z.number().int().min(0).max(TERMINAL_SCROLLBACK_MAX).default(5000),
  copyOnSelect: z.boolean().default(false),
  rightClickPaste: z.boolean().default(false),
  middleClickPaste: z.boolean().default(false),
  pasteImage: z.boolean().default(true),
  pasteFile: z.boolean().default(true),
  pasteMaxBytes: z
    .number()
    .int()
    .min(1024)
    .max(4 * 1024 * 1024)
    .default(TERMINAL_PASTE_DEFAULT_MAX_BYTES),
  osc52: z.boolean().default(true),
  osc52MaxBytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024)
    .default(TERMINAL_OSC52_DEFAULT_MAX_BYTES),
  hideWhileTyping: z.boolean().default(false),
  focusFollowsMouse: z.boolean().default(false),
  webgl: z.boolean().default(false),
  unicode11: z.boolean().default(false),
  ligatures: z.boolean().default(false),
  findCaseSensitive: z.boolean().default(false),
  findRegex: z.boolean().default(false),
  openLinksWithModifier: z.boolean().default(false),
  selectionTrim: z.boolean().default(true),
  quickCommands: z.array(quickCommandSchema).max(100).default([])
})

export type TerminalSettings = z.infer<typeof terminalSettingsSchema>
export type TerminalQuickCommand = z.infer<typeof quickCommandSchema>

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = terminalSettingsSchema.parse({})

export const TERMINAL_SETTINGS_STORAGE_KEY = 'icode.terminal.settings.v1'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

const listeners = new Set<(settings: TerminalSettings) => void>()

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadTerminalSettings(
  storage: ReadableStorage | null = browserStorage()
): TerminalSettings {
  if (storage === null) return DEFAULT_TERMINAL_SETTINGS
  let raw: string | null
  try {
    raw = storage.getItem(TERMINAL_SETTINGS_STORAGE_KEY)
  } catch {
    return DEFAULT_TERMINAL_SETTINGS
  }
  if (raw === null) return DEFAULT_TERMINAL_SETTINGS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_TERMINAL_SETTINGS
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_TERMINAL_SETTINGS
  }
  const result = terminalSettingsSchema.safeParse({ ...DEFAULT_TERMINAL_SETTINGS, ...parsed })
  return result.success ? result.data : DEFAULT_TERMINAL_SETTINGS
}

export function saveTerminalSettings(
  settings: TerminalSettings,
  storage: WritableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    return false
  }
  snapshot = settings
  for (const listener of listeners) listener(settings)
  return true
}

export function subscribeTerminalSettings(
  listener: (settings: TerminalSettings) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updateTerminalSettings(
  current: TerminalSettings,
  patch: Partial<TerminalSettings>,
  storage: WritableStorage | null = browserStorage()
): TerminalSettings {
  const next = terminalSettingsSchema.parse({ ...current, ...patch })
  saveTerminalSettings(next, storage)
  return next
}

let snapshot: TerminalSettings | null = null

function getSnapshot(): TerminalSettings {
  snapshot ??= loadTerminalSettings()
  return snapshot
}

function subscribe(listener: () => void): () => void {
  return subscribeTerminalSettings((settings) => {
    snapshot = settings
    listener()
  })
}

export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
