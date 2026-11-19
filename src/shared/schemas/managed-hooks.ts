import { z } from 'zod'
import {
  MANAGED_HOOK_PROVIDER_IDS,
  MANAGED_HOOK_PROVIDER_STATES
} from '../domain/managed-hook-providers'

export { MANAGED_HOOK_PROVIDER_IDS }
export const managedHookProviderSchema = z.enum(MANAGED_HOOK_PROVIDER_IDS)
export const managedHookProviderStateSchema = z.enum(MANAGED_HOOK_PROVIDER_STATES)

export const managedHookProviderStatusSchema = z.strictObject({
  provider: managedHookProviderSchema,
  label: z.string().min(1).max(80),
  state: managedHookProviderStateSchema,
  configPath: z.string().max(4096),
  detail: z.string().min(1).max(500).nullable()
})

export const managedHooksStateSchema = z.strictObject({
  enabled: z.boolean(),
  providers: z.array(managedHookProviderStatusSchema).max(32)
})

export const managedHooksSetEnabledInputSchema = z.strictObject({
  enabled: z.boolean()
})

export type ManagedHookProviderPayload = z.infer<typeof managedHookProviderSchema>
export type ManagedHookProviderStatusPayload = z.infer<
  typeof managedHookProviderStatusSchema
>
export type ManagedHooksStatePayload = z.infer<typeof managedHooksStateSchema>
export type ManagedHooksSetEnabledInput = z.infer<
  typeof managedHooksSetEnabledInputSchema
>
