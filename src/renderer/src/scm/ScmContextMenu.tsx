import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu'

export type ScmMenuItem = ContextMenuItem

type Props = {
  x: number
  y: number
  items: readonly ScmMenuItem[]
  ariaLabel?: string
  onClose: () => void
}

/**
 * Source Control's menu keeps its stable `scm-context-menu` selector while the
 * implementation is shared with Files.
 */
export default function ScmContextMenu(props: Props): React.JSX.Element {
  return <ContextMenu {...props} testId="scm-context-menu" />
}
