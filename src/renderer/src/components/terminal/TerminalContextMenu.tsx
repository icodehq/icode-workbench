import ContextMenu, { type ContextMenuItem } from '../ContextMenu'
import { useT } from '../../i18n/use-i18n'
import { isMacPlatform, shortcutLabel } from '../../lib/platform'
import type { SplitSide } from '../../state/session-split'

export type TerminalMenuActions = {
  copy: () => void
  paste: () => void
  selectAll: () => void
  find: () => void
  copyContext: () => void
  copySessionId: () => void
  split: (side: SplitSide) => void
  toggleZoom: () => void
  clear: () => void
  reset: () => void
  close: () => void
}

type Props = {
  open: boolean
  x: number
  y: number
  hasSelection: boolean
  canSplit: boolean
  canClose: boolean
  canZoom: boolean
  onClose: () => void
  actions: TerminalMenuActions
}

/**
 * Pane-scoped terminal menu. Selection is read synchronously by the parent
 * before this opens, because ContextMenu moves focus to its first item.
 */
export default function TerminalContextMenu({
  open,
  x,
  y,
  hasSelection,
  canSplit,
  canClose,
  canZoom,
  onClose,
  actions
}: Props): React.JSX.Element | null {
  const t = useT()
  const mac = isMacPlatform()
  if (!open) return null

  const items: ContextMenuItem[] = [
    {
      id: 'copy',
      label: t('terminal.menu.copy'),
      shortcut: shortcutLabel('C', mac ? 'darwin' : 'linux'),
      disabled: !hasSelection,
      reason: t('terminal.menu.copyEmpty'),
      onSelect: actions.copy,
      testId: 'terminal-menu-copy'
    },
    {
      id: 'paste',
      label: t('terminal.menu.paste'),
      shortcut: shortcutLabel('V', mac ? 'darwin' : 'linux'),
      onSelect: actions.paste,
      testId: 'terminal-menu-paste'
    },
    {
      id: 'select-all',
      label: t('terminal.menu.selectAll'),
      onSelect: actions.selectAll,
      testId: 'terminal-menu-select-all'
    },
    {
      id: 'find',
      label: t('terminal.menu.find'),
      shortcut: shortcutLabel('F', mac ? 'darwin' : 'linux'),
      onSelect: actions.find,
      testId: 'terminal-menu-find'
    },
    {
      id: 'copy-context',
      label: t('terminal.menu.copyContext'),
      onSelect: actions.copyContext,
      testId: 'terminal-menu-copy-context',
      separatorBefore: true
    },
    {
      id: 'copy-session-id',
      label: t('terminal.menu.copySessionId'),
      onSelect: actions.copySessionId,
      testId: 'terminal-menu-copy-session-id'
    },
    {
      id: 'split-right',
      label: t('session.splitRight'),
      disabled: !canSplit,
      reason: canSplit ? undefined : t('terminal.menu.splitUnavailable'),
      onSelect: () => actions.split('right'),
      testId: 'terminal-menu-split-right',
      separatorBefore: true
    },
    {
      id: 'split-down',
      label: t('session.splitDown'),
      disabled: !canSplit,
      reason: canSplit ? undefined : t('terminal.menu.splitUnavailable'),
      onSelect: () => actions.split('down'),
      testId: 'terminal-menu-split-down'
    },
    {
      id: 'split-left',
      label: t('session.splitLeft'),
      disabled: !canSplit,
      reason: canSplit ? undefined : t('terminal.menu.splitUnavailable'),
      onSelect: () => actions.split('left'),
      testId: 'terminal-menu-split-left'
    },
    {
      id: 'split-up',
      label: t('session.splitUp'),
      disabled: !canSplit,
      reason: canSplit ? undefined : t('terminal.menu.splitUnavailable'),
      onSelect: () => actions.split('up'),
      testId: 'terminal-menu-split-up'
    },
    {
      id: 'toggle-zoom',
      label: t('session.zoom'),
      disabled: !canZoom,
      reason: canZoom ? undefined : t('terminal.menu.zoomUnavailable'),
      onSelect: actions.toggleZoom,
      testId: 'terminal-menu-toggle-zoom'
    },
    {
      id: 'clear',
      label: t('terminal.menu.clear'),
      onSelect: actions.clear,
      testId: 'terminal-menu-clear',
      separatorBefore: true
    },
    {
      id: 'reset',
      label: t('terminal.menu.reset'),
      onSelect: actions.reset,
      testId: 'terminal-menu-reset'
    },
    {
      id: 'close',
      label: t('terminal.menu.close'),
      disabled: !canClose,
      reason: canClose ? undefined : t('terminal.menu.closeUnavailable'),
      danger: true,
      onSelect: actions.close,
      testId: 'terminal-menu-close',
      separatorBefore: true
    }
  ]

  return (
    <ContextMenu
      items={items}
      x={x}
      y={y}
      width={236}
      ariaLabel={t('terminal.menu.label')}
      testId="terminal-context-menu"
      onClose={onClose}
    />
  )
}
