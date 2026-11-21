import { z } from 'zod'
import { newProviderId, PROVIDER_ID_RE, type ProviderId } from '../domain/ids'
import {
  PROVIDER_AUTH_STYLES,
  PROVIDER_HARNESSES,
  PROVIDER_RECIPES,
  type ProviderAuthStyle,
  type ProviderHarness
} from '../domain/provider-recipes'

/**
 * A coding-agent harness that can run against a user-configured provider.
 *
 * This is the endpoint-injection subset, not the full launch catalog. Shell is
 * deliberately absent: it has no model endpoint to point anywhere. The catalog
 * contains many more launchable CLIs that do not share these env/argv recipes.
 *
 * The list, the auth styles, and the per-harness recipes live in
 * `domain/provider-recipes.ts`; this module re-exports them so existing
 * renderer/main imports keep one surface.
 */
export { PROVIDER_AUTH_STYLES, PROVIDER_HARNESSES }
export type { ProviderAuthStyle, ProviderHarness }

/**
 * How an Anthropic-protocol harness authenticates against a non-official
 * endpoint.
 *
 * - `auth_token` → ANTHROPIC_AUTH_TOKEN (Bearer; most relays)
 * - `api_key`    → ANTHROPIC_API_KEY (x-api-key; Anthropic-compatible APIs)
 *
 * Recipes without auth choices store null here.
 */

export const providerHarnessSchema = z.enum(PROVIDER_HARNESSES)
export const providerAuthStyleSchema = z.enum(PROVIDER_AUTH_STYLES)
export const providerIdSchema = z
  .string()
  .regex(PROVIDER_ID_RE, 'must be a prv_<uuid> identifier')

/** Endpoint of an LLM API. HTTP is allowed for local gateways. */
const endpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => !/\s/u.test(value), 'must not contain whitespace')
  .refine((value) => {
    try {
      const url = new URL(value)
      // Local gateways are legitimate; credentials in a URL are not.
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === ''
      )
    } catch {
      return false
    }
  }, 'must be an http(s) URL without embedded credentials')

const providerNameSchema = z.string().trim().min(1).max(80)
const providerKeySchema = z.string().min(1).max(4096)
const providerModelSchema = z.string().trim().min(1).max(200)

export const providerViewSchema = z.strictObject({
  id: providerIdSchema,
  harness: providerHarnessSchema,
  name: providerNameSchema,
  baseUrl: endpointSchema,
  model: providerModelSchema,
  authStyle: providerAuthStyleSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

export const providerSecretBackendSchema = z.enum([
  'safe_storage',
  'basic_text',
  'unavailable'
])

export const providerSecretStorageSchema = z.strictObject({
  backend: providerSecretBackendSchema,
  /** False for `basic_text` and `unavailable`. */
  secure: z.boolean()
})

const providerCreateShape = z.strictObject({
  harness: providerHarnessSchema,
  name: providerNameSchema,
  baseUrl: endpointSchema,
  model: providerModelSchema,
  apiKey: providerKeySchema,
  authStyle: providerAuthStyleSchema.nullable().optional()
})

/**
 * The recipe decides whether a harness accepts an authentication style at all
 * and which styles it offers. The store applies the same rule on write; this
 * refinement keeps the IPC boundary from accepting an impossible shape.
 */
export const providerCreateInputSchema = providerCreateShape
  .superRefine((value, context) => {
    const recipe = PROVIDER_RECIPES[value.harness]
    if (recipe.authStyles.length === 0) {
      if (value.authStyle !== undefined && value.authStyle !== null) {
        context.addIssue({
          code: 'custom',
          path: ['authStyle'],
          message: 'This harness does not accept an authentication style.'
        })
      }
      return
    }
    if (
      value.authStyle !== undefined &&
      value.authStyle !== null &&
      !recipe.authStyles.includes(value.authStyle)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authStyle'],
        message: 'This authentication style is not supported by this harness.'
      })
    }
  })
  .transform((value) => {
    const recipe = PROVIDER_RECIPES[value.harness]
    return {
      ...value,
      authStyle:
        recipe.authStyles.length > 0
          ? (value.authStyle ?? recipe.authStyles[0]!)
          : null
    }
  })

/**
 * Editing keeps the harness immutable. A blank `apiKey` keeps the stored
 * secret; a blank `authStyle` keeps the stored style (Claude only).
 */
export const providerUpdateInputSchema = z.strictObject({
  id: providerIdSchema,
  harness: providerHarnessSchema,
  name: providerNameSchema,
  baseUrl: endpointSchema,
  model: providerModelSchema,
  apiKey: providerKeySchema.optional(),
  authStyle: providerAuthStyleSchema.nullable().optional()
})

export const providerSelectInputSchema = z.strictObject({
  harness: providerHarnessSchema,
  /** `null` restores the harness's native configuration. */
  providerId: providerIdSchema.nullable()
})

export const providerRemoveInputSchema = z.strictObject({
  providerId: providerIdSchema
})

export const providerTestInputSchema = z.strictObject({
  providerId: providerIdSchema
})

export const providerSelectionSchema = z.strictObject({
  harness: providerHarnessSchema,
  providerId: providerIdSchema.nullable()
})

export const providerTestCodeSchema = z.enum([
  'ok',
  'auth_failed',
  'model_or_endpoint',
  'unreachable',
  'proxy_auth_required',
  'proxy_unreachable',
  'timeout',
  'invalid_response',
  'internal'
])

export const providerTestResultSchema = z.strictObject({
  ok: z.boolean(),
  code: providerTestCodeSchema,
  status: z.number().int().min(100).max(599).nullable(),
  latencyMs: z.number().int().nonnegative(),
  /** Sanitized; never contains the key, headers, or raw provider bodies. */
  message: z.string().max(500)
})

export const providerListResultSchema = z.strictObject({
  providers: z.array(providerViewSchema),
  selections: z.array(providerSelectionSchema),
  secretStorage: providerSecretStorageSchema
})

export type ProviderViewPayload = z.infer<typeof providerViewSchema>
export type ProviderCreateInput = z.infer<typeof providerCreateInputSchema>
export type ProviderUpdateInput = z.infer<typeof providerUpdateInputSchema>
export type ProviderSelectInput = z.infer<typeof providerSelectInputSchema>
export type ProviderSelectionPayload = z.infer<typeof providerSelectionSchema>
export type ProviderTestInput = z.infer<typeof providerTestInputSchema>
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>
export type ProviderTestCode = z.infer<typeof providerTestCodeSchema>
export type ProviderListPayload = z.infer<typeof providerListResultSchema>
export type ProviderSecretBackend = z.infer<typeof providerSecretBackendSchema>
export type ProviderSecretStorage = z.infer<typeof providerSecretStorageSchema>

/** Generates the ID for a provider row. Kept here so tests can assert the shape. */
export function newProviderRowId(): ProviderId {
  return newProviderId()
}
