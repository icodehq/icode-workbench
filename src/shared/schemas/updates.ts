import { z } from 'zod'
import { UPDATE_MODES, UPDATE_PHASES } from '../domain/update'
import { appErrorSchema } from './domain'

export const updateProgressSchema = z.strictObject({
  percent: z.number().min(0).max(100),
  transferred: z.number().nonnegative(),
  total: z.number().nonnegative(),
  bytesPerSecond: z.number().nonnegative()
})

export const updateStateSchema = z.strictObject({
  mode: z.enum(UPDATE_MODES),
  phase: z.enum(UPDATE_PHASES),
  currentVersion: z.string(),
  availableVersion: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  progress: updateProgressSchema.nullable(),
  autoCheck: z.boolean(),
  skippedVersion: z.string().nullable(),
  checkedAt: z.number().int().nonnegative().nullable(),
  error: appErrorSchema.nullable(),
  unsupportedReason: z.enum(['not-packaged', 'unsupported-platform']).nullable()
})

export type UpdateState = z.infer<typeof updateStateSchema>
export type UpdateProgress = z.infer<typeof updateProgressSchema>

export const updateSkipInputSchema = z.strictObject({
  version: z.string().trim().min(1).max(64).nullable()
})

export const updateSetAutoCheckInputSchema = z.strictObject({
  enabled: z.boolean()
})

export const updateInstallInputSchema = z.strictObject({
  stopLiveSessions: z.boolean().optional()
})

export const updateLiveSessionSchema = z.strictObject({
  id: z.string(),
  title: z.string()
})

export const updateInstallOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('restarting') }),
  z.strictObject({
    status: z.literal('confirmation-required'),
    version: z.string(),
    liveSessions: z.array(updateLiveSessionSchema)
  }),
  z.strictObject({ status: z.literal('blocked'), error: appErrorSchema })
])

export type UpdateInstallOutcome = z.infer<typeof updateInstallOutcomeSchema>
export type UpdateLiveSession = z.infer<typeof updateLiveSessionSchema>
export type UpdateSkipInput = z.infer<typeof updateSkipInputSchema>
export type UpdateSetAutoCheckInput = z.infer<typeof updateSetAutoCheckInputSchema>
export type UpdateInstallInput = z.infer<typeof updateInstallInputSchema>
