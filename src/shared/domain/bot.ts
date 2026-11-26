import type { AssistantSettings, AssistantStatus } from './assistant'

export const BOT_LIMITS = {
  maxNameLength: 40,
  maxRoleLength: 80,
  maxInstructionsLength: 4_000
} as const

/**
 * A bot is a persistent teammate, not a session role.
 *
 * It owns a durable assistant thread and a small profile. Its work is ordinary
 * iCode tasks; the bot never bypasses the task queue, approvals or review.
 */
export type BotRecord = {
  id: string
  name: string
  role: string
  avatarColor: string
  /** Optional uploaded picture data URL; null uses the color-and-initial avatar. */
  avatarImage: string | null
  /** An emoji/glyph used when no picture is set. */
  avatarMascot: string | null
  /** A named ring color around the avatar. */
  avatarOutfit: string | null
  instructions: string
  /** Per-bot assistant settings. Null means "use the global Mira settings". */
  settings: AssistantSettings | null
  archivedAt: number | null
  /** Set while the owner has paused this bot; group sends skip it. */
  pausedAt: number | null
  createdAt: number
  updatedAt: number
}

/** The subset a prompt needs. */
export type BotProfile = Pick<
  BotRecord,
  'id' | 'name' | 'role' | 'avatarColor' | 'avatarImage' | 'avatarMascot' | 'avatarOutfit' | 'instructions'
>

export type BotStatus = AssistantStatus

/** Renderer-facing summary for the Bots roster and Work panel. */
export type BotSummary = BotProfile & {
  status: BotStatus
  unread: number
  activeTaskCount: number
  reviewCount: number
  /** Groups this bot currently belongs to. */
  groupIds: string[]
  threadId: string | null
  /** First preferred chat/task harness, for the task composer default. */
  harness: string | null
  archivedAt: number | null
  pausedAt: number | null
  /** Newest home message, group message, or task change; null when never active. */
  lastActivityAt: number | null
  notificationsEnabled: boolean
}
