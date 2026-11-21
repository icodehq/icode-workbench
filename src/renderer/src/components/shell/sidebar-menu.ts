import type { WorktreeSummary } from '../../../../shared/schemas/ipc'

export type SidebarMenuEntry<Id extends string> = {
  id: Id
  separatorBefore: boolean
  disabled: boolean
  /** Already-translated reason supplied by the caller. */
  reason?: string
}

export type ProjectMenuEntryId =
  | 'retry'
  | 'new-session'
  | 'new-default-session'
  | 'queue-task'
  | 'pin'
  | 'copy-path'
  | 'repository-settings'
  | 'maintenance'
  | 'remove'

export type WorktreeMenuEntryId = 'new-session' | 'copy-path' | 'toggle' | 'recover'

export type NewMenuEntryId = 'new-session' | 'queue-task' | 'add-project' | 'schedules'

export type SidebarPreparation = {
  kind: 'preparing' | 'failed'
  label: string
} | null

export function projectMenuEntries(input: {
  preparation: SidebarPreparation
  hostUnreachable: boolean
  hostUnreachableReason: string
}): SidebarMenuEntry<ProjectMenuEntryId>[] {
  const entries: SidebarMenuEntry<ProjectMenuEntryId>[] = []
  // The one action that unblocks a failed project leads the menu.
  if (input.preparation?.kind === 'failed') {
    entries.push({ id: 'retry', separatorBefore: false, disabled: false })
  }
  const preparationReason = input.preparation?.label
  entries.push({
    id: 'new-session',
    separatorBefore: false,
    disabled: input.hostUnreachable || input.preparation !== null,
    ...(input.hostUnreachable
      ? { reason: input.hostUnreachableReason }
      : preparationReason === undefined
        ? {}
        : { reason: preparationReason })
  })
  // A default-checkout session needs no baseline, so preparation does not block it.
  entries.push({
    id: 'new-default-session',
    separatorBefore: false,
    disabled: input.hostUnreachable,
    ...(input.hostUnreachable ? { reason: input.hostUnreachableReason } : {})
  })
  entries.push({
    id: 'queue-task',
    separatorBefore: false,
    disabled: input.preparation !== null,
    ...(preparationReason === undefined ? {} : { reason: preparationReason })
  })
  // Navigation is not repeated here: the row click opens the project's sessions.
  entries.push({ id: 'pin', separatorBefore: true, disabled: false })
  entries.push({ id: 'copy-path', separatorBefore: false, disabled: false })
  entries.push({ id: 'repository-settings', separatorBefore: false, disabled: false })
  entries.push({ id: 'maintenance', separatorBefore: false, disabled: false })
  entries.push({ id: 'remove', separatorBefore: true, disabled: false })
  return entries
}

export function worktreeMenuEntries(input: {
  status: WorktreeSummary['status'] | null
  hasSession: boolean
  unavailableReason: string
}): SidebarMenuEntry<WorktreeMenuEntryId>[] {
  // A checkout Git cannot hand to a PTY must not offer a session.
  const canAdd = input.status === 'ready-to-start' || input.status === 'active'
  const entries: SidebarMenuEntry<WorktreeMenuEntryId>[] = [
    {
      id: 'new-session',
      separatorBefore: false,
      disabled: !canAdd,
      ...(canAdd ? {} : { reason: input.unavailableReason })
    },
    { id: 'copy-path', separatorBefore: false, disabled: false },
    { id: 'toggle', separatorBefore: true, disabled: false }
  ]
  if (input.status === 'missing' && input.hasSession) {
    entries.push({ id: 'recover', separatorBefore: true, disabled: false })
  }
  return entries
}

export function newMenuEntries(input: {
  hostUnreachable: boolean
  hostUnreachableReason: string
}): SidebarMenuEntry<NewMenuEntryId>[] {
  return [
    {
      id: 'new-session',
      separatorBefore: false,
      disabled: input.hostUnreachable,
      ...(input.hostUnreachable ? { reason: input.hostUnreachableReason } : {})
    },
    { id: 'queue-task', separatorBefore: false, disabled: false },
    { id: 'add-project', separatorBefore: true, disabled: false },
    { id: 'schedules', separatorBefore: false, disabled: false }
  ]
}
