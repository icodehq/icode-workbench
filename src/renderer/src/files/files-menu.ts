export type FilesMenuEntryId =
  | 'open'
  | 'new-file'
  | 'new-folder'
  | 'paste'
  | 'cut'
  | 'copy'
  | 'duplicate'
  | 'copy-path'
  | 'copy-relative-path'
  | 'rename'
  | 'delete'
  | 'history'
  | 'select-all'
  | 'refresh'

export type FilesMenuReason =
  | 'busy'
  | 'other-session'
  | 'copy-first'
  | 'select-cut'
  | 'select-copy'
  | 'select-duplicate'
  | 'select-one-rename'
  | 'select-delete'

export type FilesMenuEntry = {
  id: FilesMenuEntryId
  separatorBefore: boolean
  disabled: boolean
  reason?: FilesMenuReason
}

export type FilesMenuInput = {
  targetKind: 'file' | 'directory' | 'root'
  pathCount: number
  canPaste: boolean
  /** The clipboard holds a cut/copy from another session. */
  clipboardElsewhere: boolean
  transferBusy: boolean
  canOpenHistory: boolean
}

const busyOr = (transferBusy: boolean, fallback: FilesMenuReason): FilesMenuReason =>
  transferBusy ? 'busy' : fallback

/** The availability half of the Files context menu; labels/actions stay in the panel. */
export function filesMenuEntries(input: FilesMenuInput): FilesMenuEntry[] {
  const entries: FilesMenuEntry[] = []
  const folder = input.targetKind !== 'file'

  if (input.targetKind === 'file') {
    entries.push({ id: 'open', separatorBefore: false, disabled: false })
  }
  if (folder) {
    entries.push({ id: 'new-file', separatorBefore: false, disabled: false })
    entries.push({ id: 'new-folder', separatorBefore: false, disabled: false })
    entries.push({
      id: 'paste',
      separatorBefore: false,
      disabled: !input.canPaste || input.transferBusy,
      ...(input.canPaste && !input.transferBusy
        ? {}
        : {
            reason: input.transferBusy
              ? 'busy'
              : input.clipboardElsewhere
                ? 'other-session'
                : 'copy-first'
          })
    })
  }

  entries.push(
    {
      id: 'cut',
      separatorBefore: true,
      disabled: input.pathCount === 0,
      ...(input.pathCount === 0 ? { reason: 'select-cut' } : {})
    },
    {
      id: 'copy',
      separatorBefore: false,
      disabled: input.pathCount === 0,
      ...(input.pathCount === 0 ? { reason: 'select-copy' } : {})
    },
    {
      id: 'duplicate',
      separatorBefore: false,
      disabled: input.pathCount === 0 || input.transferBusy,
      ...(input.pathCount === 0 || input.transferBusy
        ? { reason: busyOr(input.transferBusy, 'select-duplicate') }
        : {})
    },
    {
      id: 'copy-path',
      separatorBefore: false,
      disabled: input.pathCount === 0,
      ...(input.pathCount === 0 ? { reason: 'select-copy' } : {})
    },
    {
      id: 'copy-relative-path',
      separatorBefore: false,
      disabled: input.pathCount === 0,
      ...(input.pathCount === 0 ? { reason: 'select-copy' } : {})
    },
    {
      id: 'rename',
      separatorBefore: true,
      disabled: input.pathCount !== 1 || input.transferBusy,
      ...(input.pathCount !== 1 || input.transferBusy
        ? { reason: busyOr(input.transferBusy, 'select-one-rename') }
        : {})
    },
    {
      id: 'delete',
      separatorBefore: false,
      disabled: input.pathCount === 0 || input.transferBusy,
      ...(input.pathCount === 0 || input.transferBusy
        ? { reason: busyOr(input.transferBusy, 'select-delete') }
        : {})
    }
  )

  if (input.canOpenHistory) {
    entries.push({ id: 'history', separatorBefore: true, disabled: false })
  }
  if (input.targetKind === 'root') {
    entries.push(
      { id: 'select-all', separatorBefore: true, disabled: false },
      { id: 'refresh', separatorBefore: false, disabled: false }
    )
  }
  return entries
}
