import { useState } from 'react'
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type LocalePreference
} from '../../../shared/i18n'
import { setLocalePreference } from '../i18n/i18n-store'
import { useLocaleState, useT } from '../i18n/use-i18n'
import SettingsCard from './SettingsCard'

/**
 * Language is stored in main so the native menu, dialogs, and notifications can
 * change with the renderer. The select shows both the stored preference and the
 * locale currently in force under System.
 */
export default function LanguageSettingsCard(): React.JSX.Element {
  const t = useT()
  const localeState = useLocaleState()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = async (preference: LocalePreference): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await setLocalePreference(preference)
    if (!result.ok) setError(result.error.message)
    setSaving(false)
  }

  return (
    <SettingsCard title={t('settings.language.title')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <label
            className="text-[12px] font-medium text-foreground"
            htmlFor="settings-language"
          >
            {t('settings.language.title')}
          </label>
          <p className="mt-0.5 max-w-lg text-[10.5px] leading-relaxed text-muted-foreground">
            {t('settings.language.description')}
          </p>
        </div>
        <select
          id="settings-language"
          className="h-8 max-w-full rounded-md border border-border bg-muted/40 px-2 text-[11.5px] text-foreground"
          value={localeState.preference}
          onChange={(event) => void change(event.target.value as LocalePreference)}
          disabled={saving}
          data-testid="settings-language"
        >
          <option value="system">
            {t('settings.language.system')} · {LOCALE_LABELS[localeState.systemLocale]}
          </option>
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_LABELS[locale]}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('settings.language.systemHelp')}
      </p>
      <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('settings.language.current', { language: LOCALE_LABELS[localeState.locale] })}
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
        {t('settings.language.review')}
      </p>
      {error !== null ? (
        <p className="mt-2 text-[10.5px] text-signal" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  )
}
