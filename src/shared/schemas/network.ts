import { z } from 'zod'
import {
  NO_PROXY_MAX_LENGTH,
  PROXY_MODES,
  PROXY_URL_MAX_LENGTH,
  validateNetworkProxySettings
} from '../domain/network'

/**
 * Strict proxy settings at the IPC boundary. The settings card validates first
 * so it can point at the offending field; this schema is the backstop for every
 * other caller.
 */
export const networkProxySettingsSchema = z
  .strictObject({
    mode: z.enum(PROXY_MODES),
    httpProxyUrl: z.string().max(PROXY_URL_MAX_LENGTH),
    httpsProxyUrl: z.string().max(PROXY_URL_MAX_LENGTH),
    noProxy: z.string().max(NO_PROXY_MAX_LENGTH)
  })
  .superRefine((value, context) => {
    const issues = validateNetworkProxySettings({
      mode: value.mode,
      httpProxyUrl: value.httpProxyUrl.trim(),
      httpsProxyUrl: value.httpsProxyUrl.trim(),
      noProxy: value.noProxy.trim()
    })
    for (const issue of issues) {
      context.addIssue({
        code: 'custom',
        path: [issue.field],
        message: issue.reason
      })
    }
  })

export const networkSetSettingsInputSchema = z.strictObject({
  settings: networkProxySettingsSchema
})

export type NetworkProxySettingsPayload = z.infer<typeof networkProxySettingsSchema>
export type NetworkSetSettingsInput = z.infer<typeof networkSetSettingsInputSchema>
