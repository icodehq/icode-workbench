export const MEMORY_SCOPES = ['bot', 'project', 'team'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_STATUSES = ['proposed', 'active', 'archived'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const MEMORY_LIMITS = {
  maxEntries: 100,
  maxKeyLength: 120,
  maxValueLength: 2_000
} as const

/**
 * One durable fact.
 *
 * `bot` scope belongs to one bot; `project` and `team` scopes are shared, so
 * their `botId` is null and `proposedByBotId` records who suggested the entry.
 * `team` is the storage alias for a bot group and is labeled Group in the UI.
 */
export type MemoryEntry = {
  id: string
  scope: MemoryScope
  botId: string | null
  repoId: string | null
  teamId: string | null
  proposedByBotId: string | null
  key: string
  value: string
  status: MemoryStatus
  sourceTaskId: string | null
  createdAt: number
  updatedAt: number
}

export type MemoryTarget =
  | { scope: 'bot'; botId: string }
  | { scope: 'project'; repoId: string }
  | { scope: 'team'; teamId: string }
