import type { GroupNamedBot, GroupRoom } from './group'
import { groupRoomMemberIds } from './group'

/**
 * Mention addressing for bot groups. Names are matched longest-first,
 * code/quotes/file references are data, and a leading unknown `@word` is an
 * error rather than an address.
 */

const EVERYONE = '@everyone'
const MENTION_START = /(^|[^\p{L}\p{N}_.@])@/gu
const MENTION_END = /^(?:$|[\s,:;!?)]|\.(?:\s|$))/u
const LEADING_GAP = /^[\s,:!?]*$/u
// A member's reply addresses `@Name` wherever the name is not run into more word characters.
const REPLY_MENTION_END = /^(?![\p{L}\p{N}_])/u
const QUOTED_ROOM_HISTORY = /<quoted_room_history>[\s\S]*?(?:<\/quoted_room_history>|(?![\s\S]))/gu
const QUOTED_STRINGS = /“[^”]*”|"[^"\n]*"/gu
// Code and quoted prose is data, never an address; blanked to keep every offset in place.
const UNADDRESSED_PROSE =
  /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$|“[^”]*”|"[^"\n]*"/gmu
// A file's `@path`, as drops and attachments write it, is data too: quoted, rooted,
// or a relative path/name with a slash or an extension.
const FILE_REFERENCE =
  /@"[^"\n]*"|@'[^'\n]*'|@(?:[\\/~]|[a-z]:[\\/])\S*|@[^\s@]*[\\/][^\s]*|@[^\s@]*\.[a-z0-9]+/giu

export type GroupMention = {
  start: number
  end: number
  /** Part of the address list the text opens with. */
  leading: boolean
  match: 'member' | 'everyone' | 'ambiguous' | 'none'
  ids: readonly string[]
}

export type GroupMentionErrorCode =
  | 'GROUP_MENTION_AMBIGUOUS'
  | 'GROUP_MENTION_UNAVAILABLE'
  | 'GROUP_REPLIER_NOT_MEMBER'

export class GroupMentionError extends Error {
  constructor(readonly code: GroupMentionErrorCode) {
    super(code)
    this.name = 'GroupMentionError'
  }
}

const blank = (value: string): string => ' '.repeat(value.length)

/** Every `@` in `text` that could address someone: the longest member name it spells,
 *  `@everyone`, or `none` with the unmatched `@word`. */
export function groupMentions(
  text: string,
  members: readonly GroupNamedBot[],
  everyone: readonly string[],
  nameEnd = MENTION_END
): GroupMention[] {
  const mentions: GroupMention[] = []
  let leadingEnd: number | null = 0
  for (const found of text.matchAll(MENTION_START)) {
    const start = found.index + (found[1] ?? '').length
    // Matches never overlap: an `@` inside a name already matched is part of that name.
    if (start < (mentions.at(-1)?.end ?? 0)) continue
    const rest = text.slice(start)
    const leading: boolean =
      leadingEnd !== null && LEADING_GAP.test(text.slice(leadingEnd, start))
    const named = members.filter(
      (bot) =>
        rest.slice(1, 1 + bot.name.length).toLocaleLowerCase() === bot.name.toLocaleLowerCase() &&
        nameEnd.test(rest.slice(1 + bot.name.length))
    )
    const longest = Math.max(0, ...named.map((bot) => bot.name.length))
    const best = named.filter((bot) => bot.name.length === longest)
    const broadcast =
      /^@everyone/iu.test(rest) && nameEnd.test(rest.slice(EVERYONE.length))
    const mention: GroupMention =
      broadcast && best.length === 0
        ? { start, end: start + EVERYONE.length, leading, match: 'everyone', ids: everyone }
        : best.length > 0
          ? {
              start,
              end: start + 1 + longest,
              leading,
              match: best.length > 1 ? 'ambiguous' : 'member',
              ids: best.map((bot) => bot.id)
            }
          : {
              start,
              // Up to the next `@`, so an unknown name never swallows a mention right after it.
              end: start + (/^@[^\s@]*/u.exec(rest)?.[0].length ?? 1),
              leading,
              match: 'none',
              ids: []
            }
    mentions.push(mention)
    leadingEnd = leading ? mention.end : null
  }
  return mentions
}

/** Mask Markdown code, block quotes and quoted prose in place, so offsets stay stable. */
export function blankGroupMarkdown(text: string): string {
  return text.replace(UNADDRESSED_PROSE, blank)
}

function roomNamed(room: GroupRoom, bots: readonly GroupNamedBot[]): GroupNamedBot[] {
  return bots.filter((bot) => room.members.some((member) => member.botId === bot.id))
}

function roomMentions(
  text: string,
  room: GroupRoom,
  bots: readonly GroupNamedBot[],
  nameEnd?: RegExp,
  unaddressed = UNADDRESSED_PROSE
): GroupMention[] {
  const masked = text.replace(FILE_REFERENCE, blank).replace(unaddressed, blank)
  return groupMentions(masked, roomNamed(room, bots), groupRoomMemberIds(room), nameEnd)
}

/** The other members a member's reply hands off to, each with where it is first named. */
export function groupReplyMentions(
  prose: string,
  room: GroupRoom,
  bots: readonly GroupNamedBot[],
  speakerId: string
): { id: string; start: number }[] {
  const unquoted = prose.replace(QUOTED_ROOM_HISTORY, blank)
  const named = new Map<string, number>()
  for (const mention of roomMentions(
    blankGroupMarkdown(unquoted),
    room,
    bots,
    REPLY_MENTION_END,
    QUOTED_STRINGS
  )) {
    const [id] = mention.ids
    if (
      mention.match === 'member' &&
      id !== undefined &&
      id !== speakerId &&
      !named.has(id)
    ) {
      named.set(id, mention.start)
    }
  }
  return [...named].map(([id, start]) => ({ id, start }))
}

/** Who the room's reply mode reaches when no one is mentioned. */
function replyModeAudience(room: GroupRoom): string[] {
  const members = groupRoomMemberIds(room)
  return room.replyMode.kind === 'all'
    ? members
    : room.replyMode.kind === 'bot' && members.includes(room.replyMode.botId)
      ? [room.replyMode.botId]
      : []
}

const unique = (mentions: readonly GroupMention[]): string[] => [
  ...new Set(mentions.flatMap((mention) => mention.ids))
]

/** Who an owner's message reaches: explicit mentions win, otherwise the reply mode. */
export function groupAudience(
  text: string,
  room: GroupRoom,
  bots: readonly GroupNamedBot[]
): string[] {
  const mentions = roomMentions(text, room, bots)
  if (mentions.some((mention) => mention.match === 'ambiguous')) {
    throw new GroupMentionError('GROUP_MENTION_AMBIGUOUS')
  }
  if (mentions.some((mention) => mention.leading && mention.match === 'none')) {
    throw new GroupMentionError('GROUP_MENTION_UNAVAILABLE')
  }
  const targets = unique(mentions)
  if (targets.length > 0) return targets
  const fallback = replyModeAudience(room)
  if (room.replyMode.kind === 'bot' && fallback.length === 0) {
    throw new GroupMentionError('GROUP_REPLIER_NOT_MEMBER')
  }
  return fallback
}

/** Who a draft reaches; `addressed` once it mentions someone. A mention still being typed at the
 *  end reaches no one yet. */
export function groupDraftAudience(
  draft: string,
  room: GroupRoom,
  bots: readonly GroupNamedBot[]
): { ids: string[]; addressed: boolean } | 'invalid' {
  const mentions = roomMentions(draft, room, bots).filter(
    (mention) => !(mention.match === 'none' && mention.end === draft.length)
  )
  if (
    mentions.some(
      (mention) => mention.match === 'ambiguous' || (mention.leading && mention.match === 'none')
    )
  ) {
    return 'invalid'
  }
  const ids = unique(mentions)
  return ids.length > 0
    ? { ids, addressed: true }
    : { ids: replyModeAudience(room), addressed: false }
}

/** `draft` prefixed to address `botId` by its current name; unchanged once it left the room. */
export function groupReplyDraft(
  botId: string,
  draft: string,
  room: GroupRoom,
  bots: readonly GroupNamedBot[]
): string {
  const bot = room.members.some((member) => member.botId === botId)
    ? bots.find((candidate) => candidate.id === botId)
    : undefined
  return bot === undefined ? draft : `@${bot.name} ${draft}`
}

export type GroupMentionSegment = { text: string; mention: boolean }

/** Splits text at the `@Name` / `@everyone` mentions sending would read. */
export function groupMentionSegments(
  text: string,
  names: readonly string[],
  everyone = true
): GroupMentionSegment[] {
  const named = names.filter((name) => name.length > 0).map((name) => ({ id: name, name }))
  const segments: GroupMentionSegment[] = []
  let cursor = 0
  for (const { start, end, match } of groupMentions(text, named, [])) {
    if (match === 'none' || (match === 'everyone' && !everyone)) continue
    if (start > cursor) segments.push({ text: text.slice(cursor, start), mention: false })
    segments.push({ text: text.slice(start, end), mention: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false })
  return segments
}
