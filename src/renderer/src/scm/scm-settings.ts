/**
 * Persisted Source Control preferences.
 *
 * All consumers are renderer-side, so localStorage is the persistence boundary;
 * no Git setting goes to main except as part of a command. Defaults preserve
 * the current product behaviour (explicit staging, no background network,
 * separate untracked group), and malformed storage falls back to those defaults
 * instead of leaving the UI half-configured.
 */

import { z } from 'zod'

export const scmSettingsSchema = z.object({
  smartCommit: z.enum(['off', 'all', 'tracked']).default('off'),
  untrackedMode: z.enum(['mixed', 'separate', 'hidden']).default('separate'),
  viewMode: z.enum(['list', 'tree']).default('list'),
  /** SCM sidebar width in CSS pixels; dragging the divider persists it. */
  sidebarWidth: z.number().int().min(240).max(560).default(320),
  sort: z.enum(['name', 'path', 'status']).default('path'),
  compactFolders: z.boolean().default(true),
  autoReveal: z.boolean().default(true),
  alwaysShowActions: z.boolean().default(false),
  showCommitInput: z.boolean().default(true),
  showActionButton: z.boolean().default(true),
  countBadge: z.enum(['all', 'focused', 'off']).default('all'),
  statusLimit: z.number().int().min(100).max(100_000).default(10_000),
  diffDecorations: z.enum(['all', 'gutter', 'overview', 'minimap', 'none']).default('all'),
  inlineBlame: z.boolean().default(true),
  quickDiffIgnoreWhitespace: z.boolean().default(false),
  diffView: z.enum(['sideBySide', 'inline']).default('sideBySide'),
  wordWrap: z.boolean().default(false),
  commitInputMinLines: z.number().int().min(1).max(20).default(1),
  commitInputMaxLines: z.number().int().min(2).max(30).default(8),
  pullRebase: z.boolean().default(false),
  autoStash: z.boolean().default(false),
  pullBeforeCheckout: z.boolean().default(false),
  confirmSync: z.boolean().default(true),
  confirmEmptyCommit: z.boolean().default(true),
  enableCommitSigning: z.boolean().default(false),
  alwaysSignOff: z.boolean().default(false),
  branchProtection: z.array(z.string().min(1).max(200)).max(100).default([]),
  defaultBranchName: z.string().min(1).max(200).default('main'),
  autoRefresh: z.boolean().default(true)
})

export type ScmSettings = z.infer<typeof scmSettingsSchema>

export const DEFAULT_SCM_SETTINGS: ScmSettings = scmSettingsSchema.parse({})

export const SCM_SETTINGS_STORAGE_KEY = 'icode.scm.settings.v1'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

const listeners = new Set<(settings: ScmSettings) => void>()

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadScmSettings(storage: ReadableStorage | null = browserStorage()): ScmSettings {
  if (storage === null) return DEFAULT_SCM_SETTINGS
  let raw: string | null
  try {
    raw = storage.getItem(SCM_SETTINGS_STORAGE_KEY)
  } catch {
    return DEFAULT_SCM_SETTINGS
  }
  if (raw === null) return DEFAULT_SCM_SETTINGS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_SCM_SETTINGS
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_SCM_SETTINGS
  }
  const result = scmSettingsSchema.safeParse({ ...DEFAULT_SCM_SETTINGS, ...parsed })
  return result.success ? result.data : DEFAULT_SCM_SETTINGS
}

export function saveScmSettings(
  settings: ScmSettings,
  storage: WritableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(SCM_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    return false
  }
  for (const listener of listeners) listener(settings)
  return true
}

/** Subscribe to same-window saves; SettingsPage and the SCM controller share it. */
export function subscribeScmSettings(listener: (settings: ScmSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updateScmSettings(
  current: ScmSettings,
  patch: Partial<ScmSettings>,
  storage: WritableStorage | null = browserStorage()
): ScmSettings {
  const next = scmSettingsSchema.parse({ ...current, ...patch })
  saveScmSettings(next, storage)
  return next
}
