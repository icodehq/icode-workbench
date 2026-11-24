import type { ComponentProps } from 'react'
import ContextMenu from '../ContextMenu'
import ProjectMaintenanceDialog from '../sessions/ProjectMaintenanceDialog'
import RemoveRepositoryDialog from '../RemoveRepositoryDialog'
import RepositorySettingsDialog from '../RepositorySettingsDialog'
import SessionDetailsDrawer from '../SessionDetailsDrawer'
import SleepSessionDialog from '../SleepSessionDialog'
import SessionRemoveConfirm from './SessionRemoveConfirm'

type Props = {
  projectMenu: ComponentProps<typeof ContextMenu> | null
  checkoutMenu: ComponentProps<typeof ContextMenu> | null
  taskMenu: ComponentProps<typeof ContextMenu> | null
  sessionMenu: ComponentProps<typeof ContextMenu> | null
  newMenu: ComponentProps<typeof ContextMenu> | null
  maintenance: ComponentProps<typeof ProjectMaintenanceDialog> | null
  repositorySettings: ComponentProps<typeof RepositorySettingsDialog> | null
  removeRepository: ComponentProps<typeof RemoveRepositoryDialog> | null
  details: ComponentProps<typeof SessionDetailsDrawer> | null
  sleep: ComponentProps<typeof SleepSessionDialog> | null
  removeSession: ComponentProps<typeof SessionRemoveConfirm> | null
}

/** The sidebar's menus and dialogs, mounted in the same order as before. */
export default function WorkspaceSidebarDialogs({
  projectMenu,
  checkoutMenu,
  taskMenu,
  sessionMenu,
  newMenu,
  maintenance,
  repositorySettings,
  removeRepository,
  details,
  sleep,
  removeSession
}: Props): React.JSX.Element {
  return (
    <>
      {projectMenu !== null ? <ContextMenu {...projectMenu} /> : null}
      {checkoutMenu !== null ? <ContextMenu {...checkoutMenu} /> : null}
      {taskMenu !== null ? <ContextMenu {...taskMenu} /> : null}
      {sessionMenu !== null ? <ContextMenu {...sessionMenu} /> : null}
      {newMenu !== null ? <ContextMenu {...newMenu} /> : null}
      {maintenance !== null ? <ProjectMaintenanceDialog {...maintenance} /> : null}
      {repositorySettings !== null ? (
        <RepositorySettingsDialog {...repositorySettings} />
      ) : null}
      {removeRepository !== null ? (
        <RemoveRepositoryDialog {...removeRepository} />
      ) : null}
      {details !== null ? <SessionDetailsDrawer {...details} /> : null}
      {sleep !== null ? <SleepSessionDialog {...sleep} /> : null}
      {removeSession !== null ? <SessionRemoveConfirm {...removeSession} /> : null}
    </>
  )
}
