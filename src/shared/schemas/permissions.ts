import { z } from 'zod'
import { sessionIdSchema } from './primitives'

export const permissionDecisionSchema = z.discriminatedUnion('behavior', [
  z.strictObject({ behavior: z.literal('allow') }),
  z.strictObject({
    behavior: z.literal('deny'),
    message: z.string().trim().min(1).max(500)
  })
])

export const pendingPermissionSchema = z.strictObject({
  id: z.string().min(1).max(120),
  sessionId: sessionIdSchema,
  taskId: z.string().min(1).max(120),
  groupId: z.string().min(1).max(120),
  toolName: z.string().max(64).nullable(),
  input: z.string().max(4_000).nullable(),
  createdAt: z.number().int()
})

export const permissionsListInputSchema = z.strictObject({
  groupId: z.string().min(1).max(120).optional()
})

export const permissionsListResultSchema = z.array(pendingPermissionSchema)

export const permissionsRespondInputSchema = z.strictObject({
  id: z.string().min(1).max(120),
  decision: permissionDecisionSchema
})

export const permissionEventSchema = z.strictObject({
  type: z.literal('changed')
})

export type PermissionDecisionPayload = z.infer<typeof permissionDecisionSchema>
export type PendingPermissionPayload = z.infer<typeof pendingPermissionSchema>
export type PermissionsListInput = z.infer<typeof permissionsListInputSchema>
export type PermissionsRespondInput = z.infer<typeof permissionsRespondInputSchema>
