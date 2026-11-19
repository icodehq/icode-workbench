import { harnessLabel } from '../../../shared/domain/harness'
import {
  PROVIDER_HARNESSES,
  type ProviderHarness
} from '../../../shared/schemas/provider'
import { useT } from '../i18n/use-i18n'

/**
 * The provider card holds one harness at a time. A selector scales to the
 * documented harness set without turning Settings into twenty stacked forms.
 */
export default function ProviderHarnessPicker({
  value,
  onChange
}: {
  value: ProviderHarness
  onChange: (harness: ProviderHarness) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label className="mt-3 block text-[10.5px] text-muted-foreground">
      {t('settings.providers.harness')}
      <select
        className="mt-1 h-8 w-full rounded-md border border-border bg-muted/40 px-2 text-[11.5px] text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value as ProviderHarness)}
        data-testid="provider-harness-picker"
      >
        {PROVIDER_HARNESSES.map((harness) => (
          <option key={harness} value={harness}>
            {harnessLabel(harness)}
          </option>
        ))}
      </select>
    </label>
  )
}
