export type TaskActionRequest =
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'retry'
  | 'resume'
  | 'archive'
  | 'unarchive'

/**
 * One place that maps a surface's task action to the typed task IPC.
 *
 * Assistant cards and the task workbench expose different action sets
 * (`continue` vs `resume`, plus archive), so they keep their own labels and
 * notices; only the request itself is shared.
 */
export function requestTaskAction(taskId: string, action: TaskActionRequest) {
  switch (action) {
    case 'approve':
      return window.icode.tasks.approve({ taskId })
    case 'reject':
      return window.icode.tasks.reject({ taskId })
    case 'cancel':
      return window.icode.tasks.cancel({ taskId })
    case 'retry':
      return window.icode.tasks.retry({ taskId })
    case 'resume':
      return window.icode.tasks.resume({ taskId })
    case 'archive':
      return window.icode.tasks.archive({ taskId })
    case 'unarchive':
      return window.icode.tasks.unarchive({ taskId })
  }
}
