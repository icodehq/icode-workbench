import { Copy, Minus, Square, X } from 'lucide-react'
import { isMacPlatform } from '../lib/platform'
import { useT } from '../i18n/use-i18n'
import { useWindowMaximized } from './shell/use-window-maximized'

type Props = {
  /** Host platform; macOS keeps its native traffic lights. */
  platform: string | null
}

/**
 * Windows/Linux frameless-window controls.
 *
 * The surrounding chrome layer owns positioning; this component owns only the
 * three controls and their maximize contract. It renders nothing on macOS,
 * where the native traffic lights are the controls.
 */
export default function WindowControls({ platform }: Props): React.JSX.Element | null {
  const t = useT()
  const [maximized, toggleMaximize] = useWindowMaximized()
  if (isMacPlatform(platform)) return null
  return (
    <div
      className="flex h-full shrink-0 items-stretch [-webkit-app-region:no-drag]"
      role="group"
      aria-label={t('topbar.windowControls')}
      data-testid="window-controls"
    >
      <button
        type="button"
        className="flex w-[42px] items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground [-webkit-app-region:no-drag] min-[900px]:w-[46px]"
        onClick={() => {
          void window.icode.window.minimize()
        }}
        aria-label={t('topbar.minimize')}
        title={t('topbar.minimize')}
        data-testid="window-minimize"
      >
        <Minus size={12} />
      </button>
      <button
        type="button"
        className="flex w-[42px] items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground [-webkit-app-region:no-drag] min-[900px]:w-[46px]"
        onClick={toggleMaximize}
        aria-label={maximized ? t('topbar.restore') : t('topbar.maximize')}
        aria-pressed={maximized}
        title={maximized ? t('topbar.restore') : t('topbar.maximize')}
        data-testid="window-toggle"
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="flex w-[42px] items-center justify-center text-muted-foreground hover:bg-destructive hover:text-white [-webkit-app-region:no-drag] min-[900px]:w-[46px]"
        onClick={() => {
          void window.icode.window.close()
        }}
        aria-label={t('topbar.close')}
        title={t('topbar.close')}
        data-testid="window-close"
      >
        <X size={13} />
      </button>
    </div>
  )
}
