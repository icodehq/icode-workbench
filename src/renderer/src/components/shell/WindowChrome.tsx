import { headerRightInset, usesCustomWindowControls } from './window-chrome'
import WindowControls from '../WindowControls'

type Props = {
  platform: string | null
}

/**
 * Absolute chrome layer at the top-right of the workspace. The wrapper ignores
 * pointer events so the drag surface underneath still works; only the controls
 * receive clicks.
 */
export default function WindowChrome({ platform }: Props): React.JSX.Element | null {
  if (!usesCustomWindowControls(platform)) return null
  return (
    <div
      className="pointer-events-none absolute right-0 top-0 z-50 flex h-10 items-stretch"
      style={{ paddingRight: 0 }}
      data-testid="window-chrome"
      data-inset={headerRightInset(platform)}
    >
      <div className="pointer-events-auto flex h-full items-stretch">
        <WindowControls platform={platform} />
      </div>
    </div>
  )
}
