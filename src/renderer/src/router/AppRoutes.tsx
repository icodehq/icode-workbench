import type { ReactNode } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { BootPhase } from '../state/workspace'
import type { Surface } from './routes'
import { useT } from '../i18n/use-i18n'

export type AppRoutesProps = {
  boot: BootPhase
  bootError: string | null
  onRetryBoot: () => void
  surface: Surface
  pages: Record<Surface, ReactNode>
}

/**
 * The application's route boundary.
 *
 * Boot gating happens before surface selection so a failed workspace never
 * renders a page. The page registry is supplied by the composition root; this
 * component owns no navigation state and performs no application work.
 */
export default function AppRoutes({
  boot,
  bootError,
  onRetryBoot,
  surface,
  pages
}: AppRoutesProps): React.JSX.Element {
  const t = useT()
  if (boot === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {t('appRoutes.loading')}
        </div>
      </div>
    )
  }
  if (boot === 'failed') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
            <AlertTriangle size={14} />
            {t('appRoutes.loadFailed')}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{bootError}</p>
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
            onClick={onRetryBoot}
            data-testid="boot-retry"
          >
            <RefreshCw size={12} />
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }
  return <>{pages[surface]}</>
}
