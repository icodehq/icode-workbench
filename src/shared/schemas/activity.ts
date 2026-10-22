import { z } from 'zod'
import {
  ACTIVITY_EVENTS,
  ACTIVITY_MAX_PAYLOAD_BYTES,
  ACTIVITY_OUTCOMES,
  ACTIVITY_STATES
} from '../domain/activity'
import { appErrorSchema } from './domain'
import {
  absolutePathSchema,
  incarnationIdSchema,
  sessionIdSchema,
  timestampSchema,
  wireIdSchema
} from './primitives'

/**
 * Hook ingress contract. The script sends exactly these fields; anything else,
 * anything oversized, or anything malformed is dropped by the reader before it
 * can reach the activity service.
 */
export const activityHookPayloadSchema = z.strictObject({
  event: z.enum(ACTIVITY_EVENTS),
  sessionId: z.string().min(1).max(128),
  incarnationId: z.string().min(1).max(64),
  claudeSessionId: z.string().min(1).max(128).nullable(),
  promptId: z.string().min(1).max(128).nullable(),
  toolName: z.string().min(1).max(64).nullable(),
  sentAt: timestampSchema
})

export const activitySummarySchema = z.strictObject({
  state: z.enum(ACTIVITY_STATES),
  toolName: z.string().min(1).max(64).nullable(),
  unread: z.boolean(),
  outcome: z.enum(ACTIVITY_OUTCOMES).nullable(),
  since: timestampSchema
})

export const activitySnapshotSchema = z.strictObject({
  sessionId: sessionIdSchema,
  activity: activitySummarySchema
})

export const activityListSchema = z.array(activitySnapshotSchema).max(2000)

export const clearActivityUnreadInputSchema = z.strictObject({
  sessionId: sessionIdSchema
})

export const activityEventSchema = z.strictObject({
  type: z.literal('activity'),
  sessionId: sessionIdSchema,
  activity: activitySummarySchema
})

export type ActivityHookPayload = z.infer<typeof activityHookPayloadSchema>
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>
export type ClearActivityUnreadInput = z.infer<typeof clearActivityUnreadInputSchema>
export type ActivityEvent = z.infer<typeof activityEventSchema>

export { ACTIVITY_MAX_PAYLOAD_BYTES, absolutePathSchema, incarnationIdSchema, wireIdSchema, appErrorSchema }
