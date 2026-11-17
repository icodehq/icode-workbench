import type { TaskRecordPayload } from '../../../../shared/icode-api'
import { taskCanCancel } from '../task-status'

export type TaskMenuEntryId =
  | 'continue'
  | 'retry'
  | 'archive'
  | 'unarchive'
  | 'pin'
  | 'cancel'

export type TaskMenuEntry = {
  id: TaskMenuEntryId
  /** Draw a divider above this entry. */
  separatorBefore: boolean
}

/**
 * The row-menu plan for one task, in rendering order: recovery, management,
 * destructive.
 *
 * Availability comes from the server's capability flags, so the row menu and
 * the task view cannot disagree about what the task allows. Review decisions
 * are deliberately absent: they need the proposal and diff on screen.
 */
export function taskMenuEntries(task: TaskRecordPayload): TaskMenuEntry[] {
  const entries: TaskMenuEntry[] = []
  if (task.canResume === true) entries.push({ id: 'continue', separatorBefore: false })
  if (task.canRetry === true) entries.push({ id: 'retry', separatorBefore: false })

  const hasRecovery = entries.length > 0
  const archive =
    task.canArchive === true ? 'archive' : task.canUnarchive === true ? 'unarchive' : null
  if (archive !== null) entries.push({ id: archive, separatorBefore: hasRecovery })

  entries.push({ id: 'pin', separatorBefore: hasRecovery && archive === null })
  if (taskCanCancel(task)) entries.push({ id: 'cancel', separatorBefore: true })
  return entries
}
