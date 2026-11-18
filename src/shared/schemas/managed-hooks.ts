import { z } from 'zod'

export const MANAGED_HOOK_PROVIDER_IDS = [
  'gemini',
  'qwen-code',
  'cursor',
  'copilot',
  'grok',
  'kimi',
  'amp',
  'droid',
  'openclaude',
  'qoder',
  'qoder-cn',
  'codebuddy',
  'antigravity',
  'command-code',
  'devin',
  'muse',
  'zcode',
  'kiro',
  'dsh',
  'jcode',
  'hermes'
] as const
export const managedHookProviderSchema = z.enum(MANAGED_HOOK_PROVIDER_IDS)

export const managedHookProviderStateSchema = z.enum([
  'installed',
  'partial',
  'not-installed',
  'cli-not-found',
  'disabled',
  'failed'
])

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
