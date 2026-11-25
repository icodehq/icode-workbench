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

export type WorktreeMenuEntryId = 'new-session' | 'copy-path' | 'toggle' | 'remove'

/** The actions shared by the default checkout and a worktree row. */
export type DefaultCheckoutMenuEntryId = 'new-session' | 'copy-path' | 'toggle'

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

/**
 * Both checkout row types share one plan so a change to the row actions cannot
 * land on one of them and miss the other. Recovery is automatic, so neither
 * row offers a repair action.
 */
function checkoutEntries(input: {
  canStart: boolean
  unavailableReason: string
}): SidebarMenuEntry<DefaultCheckoutMenuEntryId>[] {
  // A checkout Git cannot hand to a PTY must not offer a session.
  return [
    {
      id: 'new-session',
      separatorBefore: false,
      disabled: !input.canStart,
      ...(input.canStart ? {} : { reason: input.unavailableReason })
    },
    { id: 'copy-path', separatorBefore: false, disabled: false },
    { id: 'toggle', separatorBefore: true, disabled: false }
  ]
}

export function defaultCheckoutMenuEntries(input: {
  canStart: boolean
  unavailableReason: string
}): SidebarMenuEntry<DefaultCheckoutMenuEntryId>[] {
  return checkoutEntries(input)
}

export function worktreeMenuEntries(input: {
  status: WorktreeSummary['status'] | null
  unavailableReason: string
  creatingReason: string
  hostUnreachable: boolean
  hostUnreachableReason: string
}): SidebarMenuEntry<WorktreeMenuEntryId>[] {
  const canStart = input.status === 'ready-to-start' || input.status === 'active'
  const creating = input.status === 'creating'
  return [
    ...checkoutEntries({
      canStart,
      unavailableReason: input.unavailableReason
    }),
    {
      id: 'remove',
      separatorBefore: true,
      disabled: input.hostUnreachable || creating,
      ...(input.hostUnreachable
        ? { reason: input.hostUnreachableReason }
        : creating
          ? { reason: input.creatingReason }
          : {})
    }
  ]
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
