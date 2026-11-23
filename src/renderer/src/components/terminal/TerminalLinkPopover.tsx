import AnchoredPopover from '../AnchoredPopover'
import { useT } from '../../i18n/use-i18n'
import type { TerminalLinkRequest } from '../../terminal/terminal-interaction-host'

type Props = {
  request: TerminalLinkRequest | null
  onClose: () => void
}

/** Compact actions for a terminal URL click. */
export default function TerminalLinkPopover({
  request,
  onClose
}: Props): React.JSX.Element | null {
  const t = useT()
  if (request === null) return null

  const run = (action: () => void): void => {
    action()
    onClose()
  }

  return (
    <AnchoredPopover
      anchor={{ top: request.y, bottom: request.y, left: request.x, right: request.x }}
      ariaLabel={t('terminal.link.title')}
      testId="terminal-link-popover"
      width={340}
      onClose={onClose}
    >
      <div className="border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('terminal.link.title')}
        </p>
        <p className="mt-1 truncate font-mono text-[11px] text-foreground" title={request.url}>
          {request.url}
        </p>
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        <button
          type="button"
          className="rounded px-2 py-1.5 text-left text-[11px] hover:bg-menu-hover"
          onClick={() => run(request.open)}
          data-testid="terminal-link-open"
        >
          {t('terminal.link.open')}
        </button>
        <button
          type="button"
          className="rounded px-2 py-1.5 text-left text-[11px] hover:bg-menu-hover"
          onClick={() => run(request.copy)}
          data-testid="terminal-link-copy"
        >
          {t('terminal.link.copy')}
        </button>
      </div>
    </AnchoredPopover>
  )
}
