import type {
  AssistantConversationPayload,
  AssistantMessagePayload
} from '../../../shared/schemas/assistant'

export const MESSAGE_PAGE_SIZE = 50
export const NOTIFICATION_FEED_LIMIT = 10

const RESET_REASON_LABEL: Record<
  NonNullable<AssistantConversationPayload['resetReason']>,
  string
> = {
  user: 'new conversation',
  'harness-changed': 'harness changed',
  'target-changed': 'target changed',
  'resume-failed': 'resume failed',
  'resume-unsupported': 'resume unsupported'
}

export function isNotificationMessage(message: AssistantMessagePayload): boolean {
  return message.kind === 'notification' || message.notificationKind !== null
}

/** Notifications live in the drawer; only a focused deep-link target stays inline. */
export function visibleMessages(
  messages: AssistantMessagePayload[],
  focusedId: string | null
): AssistantMessagePayload[] {
  return messages.filter(
    (message) => !isNotificationMessage(message) || message.id === focusedId
  )
}

/** The active conversation, or the highest-start segment when none is active. */
export function defaultConversationId(
  conversations: AssistantConversationPayload[]
): string | null {
  if (conversations.length === 0) return null
  const active = conversations.find((conversation) => conversation.state === 'active')
  if (active !== undefined) return active.id
  return conversations.reduce((latest, conversation) =>
    conversation.startSeq > latest.startSeq ? conversation : latest
  ).id
}

function sortedUnion(
  current: AssistantMessagePayload[],
  incoming: AssistantMessagePayload[]
): { messages: AssistantMessagePayload[]; changed: boolean } {
  const byId = new Map(current.map((message) => [message.id, message]))
  let changed = false
  for (const message of incoming) {
    const existing = byId.get(message.id)
    if (existing === undefined || existing !== message) {
      byId.set(message.id, message)
      changed = true
    }
  }
  if (!changed) return { messages: current, changed: false }
  return {
    messages: [...byId.values()].sort((left, right) => left.seq - right.seq),
    changed: true
  }
}

/**
 * Refresh with the newest page. When the page is adjacent or overlapping the
 * loaded window, merge it; when there is a gap, render the page alone and let
 * the user load earlier messages again.
 */
export function mergeNewest(
  current: AssistantMessagePayload[],
  page: AssistantMessagePayload[]
): AssistantMessagePayload[] {
  if (page.length === 0) return current
  if (current.length === 0) return page
  const currentLast = current[current.length - 1]!
  const pageFirst = page[0]!
  if (pageFirst.seq > currentLast.seq + 1) return page
  return sortedUnion(current, page).messages
}

export function prependOlder(
  current: AssistantMessagePayload[],
  page: AssistantMessagePayload[]
): AssistantMessagePayload[] {
  if (page.length === 0) return current
  return sortedUnion(current, page).messages
}

export function computeHasMore(
  messages: AssistantMessagePayload[],
  conversation: AssistantConversationPayload | null,
  pageWasFull: boolean
): boolean {
  if (!pageWasFull || messages.length === 0) return false
  const start = conversation?.startSeq ?? 1
  return messages[0]!.seq > start
}

export function conversationLabel(
  conversation: AssistantConversationPayload,
  isLatest: boolean
): string {
  const when = new Date(conversation.createdAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  const target =
    conversation.targetKind === 'wsl'
      ? `wsl:${conversation.targetDistro ?? 'unknown'}`
      : 'local'
  if (isLatest) {
    return `${
      conversation.state === 'active' ? 'Current conversation' : 'Latest conversation'
    } · ${when}`
  }
  const reason =
    conversation.resetReason === null
      ? ''
      : ` · ${RESET_REASON_LABEL[conversation.resetReason]}`
  return `Earlier · ${when} · ${conversation.harness}/${target}${reason}`
}
