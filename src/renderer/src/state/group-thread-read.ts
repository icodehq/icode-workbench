import type { GroupThreadPayload } from '../../../shared/schemas/groups'

/**
 * Combines a thread payload with a read this window already sent. A refresh
 * that left before the read can otherwise raise the unread count again.
 * `lastReadSeq + unread` is the newest sequence the server knew when it
 * answered; anything at or below the local read is already read.
 */
export function mergeLocalRead(
  thread: GroupThreadPayload,
  localRead: number | undefined
): GroupThreadPayload {
  if (localRead === undefined) return thread
  const lastReadSeq = Math.max(thread.lastReadSeq, localRead)
  const unread = Math.max(0, thread.lastReadSeq + thread.unread - lastReadSeq)
  return lastReadSeq === thread.lastReadSeq && unread === thread.unread
    ? thread
    : { ...thread, lastReadSeq, unread }
}
