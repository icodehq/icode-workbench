import { useT, useTp } from '../i18n/use-i18n'
import {
  cancelUpdateInstall,
  confirmUpdateInstall,
  useUpdateRestartPrompt
} from './updates-store'

export default function UpdateRestartDialog(): React.JSX.Element | null {
  const t = useT()
  const tp = useTp()
  const prompt = useUpdateRestartPrompt()

  if (prompt === null) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('updates.restart.title', { version: prompt.version })}
      data-testid="update-restart-dialog"
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <h2 className="text-[16px] font-semibold">
          {t('updates.restart.title', { version: prompt.version })}
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {t('updates.restart.body')}
        </p>
        <p className="mt-2 text-[12px] font-medium text-signal">
          {tp('updates.restart.sessions', prompt.liveSessions.length)}
        </p>
        <ul className="mt-2 max-h-40 overflow-y-auto rounded border border-border bg-background/40 p-2 text-[11.5px]">
          {prompt.liveSessions.map((session) => (
            <li key={session.id} className="truncate py-0.5" title={session.title}>
              {session.title}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-8 rounded-md border border-border px-3 text-[11.5px] hover:bg-muted"
            onClick={cancelUpdateInstall}
            data-testid="update-restart-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="h-8 rounded-md bg-accent px-3 text-[11.5px] text-accent-ink hover:opacity-90"
            onClick={() => void confirmUpdateInstall()}
            data-testid="update-restart-confirm"
          >
            {t('updates.restart.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
