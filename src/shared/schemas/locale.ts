import { z } from 'zod'
import { SUPPORTED_LOCALES } from '../i18n/locales'

export const localeSchema = z.enum(SUPPORTED_LOCALES)

export const localePreferenceSchema = z.union([z.literal('system'), localeSchema])

export const localeStateSchema = z.strictObject({
  preference: localePreferenceSchema,
  locale: localeSchema,
  systemLocale: localeSchema
})

export const localeSetInputSchema = z.strictObject({
  preference: localePreferenceSchema
})

export type LocaleState = z.infer<typeof localeStateSchema>
export type LocaleSetInput = z.infer<typeof localeSetInputSchema>
