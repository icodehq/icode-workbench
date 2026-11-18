import { z } from 'zod'

export const openCodeIntegrationInstallSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('installed'),
    configDir: z.string().min(1).max(4096),
    api: z.enum(['v1', 'v2']),
    tuiRegistered: z.boolean()
  }),
  z.strictObject({
    state: z.literal('not-installed'),
    configDir: z.string().min(1).max(4096)
  }),
  z.strictObject({
    state: z.literal('unsupported'),
    configDir: z.string().min(1).max(4096),
    detail: z.string().min(1).max(500)
  }),
  z.strictObject({
    state: z.literal('failed'),
    configDir: z.string().min(1).max(4096),
    detail: z.string().min(1).max(500)
  })
])

export const openCodeIntegrationStateSchema = z.strictObject({
  enabled: z.boolean(),
  api: z.enum(['v1', 'v2', 'unknown']),
  install: openCodeIntegrationInstallSchema
})

export const openCodeIntegrationSetEnabledInputSchema = z.strictObject({
  enabled: z.boolean()
})

export type OpenCodeIntegrationInstallPayload = z.infer<typeof openCodeIntegrationInstallSchema>
export type OpenCodeIntegrationStatePayload = z.infer<typeof openCodeIntegrationStateSchema>
export type OpenCodeIntegrationSetEnabledInput = z.infer<
  typeof openCodeIntegrationSetEnabledInputSchema
>
