import { AlertTriangle, FolderOpen, Save, Trash2, X } from 'lucide-react'

type ShellProps = {
  label: string
  title: string
  children: React.ReactNode
  onClose?: () => void
  testId: string
}

function DialogShell({ label, title, children, onClose, testId }: ShellProps): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-signal" />
            <h2 className="text-[16px] font-semibold">{title}</h2>
          </div>
          {onClose ? (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  )
}

type UnsavedFilesDialogProps = {
  path: string
  multiple: boolean
  busy?: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** Save / Discard / Cancel when closing one tab or all tabs. */
export function UnsavedFilesDialog({
  path,
  multiple,
  busy = false,
  onSave,
  onDiscard,
  onCancel
}: UnsavedFilesDialogProps): React.JSX.Element {
  return (
    <DialogShell
      label="Unsaved file changes"
      title={multiple ? 'Save all changes?' : 'Save changes?'}
      onClose={busy ? undefined : onCancel}
      testId="files-unsaved-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {multiple
          ? 'Some open files have unsaved changes.'
          : `“${path}” has unsaved changes.`}{' '}
        Your changes will be lost if you don’t save them.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-unsaved-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-destructive hover:bg-destructive/10"
          onClick={onDiscard}
          disabled={busy}
          data-testid="files-unsaved-discard"
        >
          <Trash2 size={12} />
          {multiple ? 'Discard all' : 'Discard'}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onSave}
          disabled={busy}
          data-testid="files-unsaved-save"
        >
          <Save size={12} />
          {busy ? 'Saving…' : multiple ? 'Save all' : 'Save'}
        </button>
      </div>
    </DialogShell>
  )
}

type SaveConflictDialogProps = {
  path: string
  /** Backend detail, which distinguishes changed from deleted when known. */
  detail?: string
  busy?: boolean
  onOverwrite: () => void
  onReload: () => void
  onCancel: () => void
}

/** The file changed between the read and the save. */
export function SaveConflictDialog({
  path,
  detail,
  busy = false,
  onOverwrite,
  onReload,
  onCancel
}: SaveConflictDialogProps): React.JSX.Element {
  return (
    <DialogShell
      label="File changed on disk"
      title="The file changed on disk"
      onClose={busy ? undefined : onCancel}
      testId="files-conflict-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        “{path}” changed on disk while you were editing it. Overwrite the disk
        version with your text, or reload it and discard your changes.
        {detail ? <span className="mt-1 block text-[11px] text-signal">{detail}</span> : null}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-conflict-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onReload}
          disabled={busy}
          data-testid="files-conflict-reload"
        >
          Reload from disk
        </button>
        <button
          type="button"
          className="h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-black hover:opacity-90"
          onClick={onOverwrite}
          disabled={busy}
          data-testid="files-conflict-overwrite"
        >
          {busy ? 'Saving…' : 'Overwrite'}
        </button>
      </div>
    </DialogShell>
  )
}

type DeleteFilesDialogProps = {
  paths: readonly string[]
  dirtyCount: number
  useTrash: boolean
  busy?: boolean
  onConfirm: () => void
  onConfirmPermanent: () => void
  onCancel: () => void
}

/** One confirmation for a single file or a batch. */
export function DeleteFilesDialog({
  paths,
  dirtyCount,
  useTrash,
  busy = false,
  onConfirm,
  onConfirmPermanent,
  onCancel
}: DeleteFilesDialogProps): React.JSX.Element {
  const names = paths.slice(0, 10)
  return (
    <DialogShell
      label="Delete files"
      title={paths.length === 1 ? 'Delete this item?' : `Delete ${String(paths.length)} items?`}
      onClose={busy ? undefined : onCancel}
      testId="files-delete-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {useTrash
          ? 'Deleted items move to the session Trash and can be restored for seven days.'
          : 'This deletes from the session worktree and cannot be undone.'}{' '}
        Git history is unchanged.
      </p>
      <ul className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
        {names.map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
        {paths.length > names.length ? (
          <li className="text-muted-foreground">+{paths.length - names.length} more</li>
        ) : null}
      </ul>
      {dirtyCount > 0 ? (
        <p className="mt-2 rounded border border-signal/40 bg-signal-weak px-2 py-1.5 text-[11px] text-signal">
          {dirtyCount} unsaved Files tab{dirtyCount === 1 ? '' : 's'} will be lost.
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-delete-cancel"
        >
          Cancel
        </button>
        {useTrash ? (
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] text-destructive hover:bg-destructive/10"
            onClick={onConfirmPermanent}
            disabled={busy}
            data-testid="files-delete-permanent"
          >
            Delete permanently
          </button>
        ) : null}
        <button
          type="button"
          className="h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-black hover:opacity-90"
          onClick={onConfirm}
          disabled={busy}
          data-testid="files-delete-confirm"
        >
          {busy
            ? 'Deleting…'
            : useTrash
              ? 'Move to Trash'
              : paths.length === 1
                ? 'Delete'
                : `Delete ${String(paths.length)} items`}
        </button>
      </div>
    </DialogShell>
  )
}

type ReplaceFilesDialogProps = {
  matches: number
  files: number
  paths: readonly string[]
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** One confirmation before literal Replace all writes to disk. */
export function ReplaceFilesDialog({
  matches,
  files,
  paths,
  busy = false,
  onConfirm,
  onCancel
}: ReplaceFilesDialogProps): React.JSX.Element {
  const names = paths.slice(0, 10)
  return (
    <DialogShell
      label="Replace in files"
      title={`Replace ${String(matches)} match${matches === 1 ? '' : 'es'}?`}
      onClose={busy ? undefined : onCancel}
      testId="files-replace-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        This writes to {files} file{files === 1 ? '' : 's'} in the session worktree.
        Open files with unsaved edits are not overwritten in the editor; they will
        show “Changed on disk” instead.
      </p>
      <ul className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
        {names.map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
        {paths.length > names.length ? (
          <li className="text-muted-foreground">+{paths.length - names.length} more</li>
        ) : null}
      </ul>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Files that changed since the search was run are skipped. This action cannot
        be undone here.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-replace-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="h-9 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onConfirm}
          disabled={busy}
          data-testid="files-replace-confirm"
        >
          {busy ? 'Replacing…' : 'Replace all'}
        </button>
      </div>
    </DialogShell>
  )
}

type MoveFilesDialogProps = {
  paths: readonly string[]
  destination: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Drag & drop moves confirm once for the whole selection. */
export function MoveFilesDialog({
  paths,
  destination,
  busy = false,
  onConfirm,
  onCancel
}: MoveFilesDialogProps): React.JSX.Element {
  return (
    <DialogShell
      label="Move files"
      title={`Move ${String(paths.length)} item${paths.length === 1 ? '' : 's'}?`}
      onClose={busy ? undefined : onCancel}
      testId="files-move-dialog"
    >
      <p className="mt-2 flex items-center gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
        <FolderOpen size={13} />
        <span className="font-mono text-foreground">{destination === '' ? 'worktree root' : destination}</span>
      </p>
      <ul className="mt-2 max-h-32 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
        {paths.slice(0, 10).map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
        {paths.length > 10 ? (
          <li className="text-muted-foreground">+{paths.length - 10} more</li>
        ) : null}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-move-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="h-9 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onConfirm}
          disabled={busy}
          data-testid="files-move-confirm"
        >
          {busy ? 'Moving…' : 'Move'}
        </button>
      </div>
    </DialogShell>
  )
}

type AppCloseDialogProps = {
  files: number
  sessions: number
  busy?: boolean
  onSaveAll: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** One prompt for window close / app quit across every session. */
export function AppCloseDialog({
  files,
  sessions,
  busy = false,
  onSaveAll,
  onDiscard,
  onCancel
}: AppCloseDialogProps): React.JSX.Element {
  return (
    <DialogShell
      label="Unsaved files before closing"
      title="Save files before closing?"
      testId="files-app-close-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {files} unsaved file{files === 1 ? '' : 's'} in {sessions} session
        {sessions === 1 ? '' : 's'}. Save them before closing iCode?
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-app-close-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] text-destructive hover:bg-destructive/10"
          onClick={onDiscard}
          disabled={busy}
          data-testid="files-app-close-discard"
        >
          Close without saving
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onSaveAll}
          disabled={busy}
          data-testid="files-app-close-save"
        >
          <Save size={12} />
          {busy ? 'Saving…' : 'Save all and close'}
        </button>
      </div>
    </DialogShell>
  )
}
