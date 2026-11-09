import { AlertTriangle, FolderOpen, Save, Trash2, X } from 'lucide-react'
import { useT, useTp } from '../i18n/use-i18n'

type ShellProps = {
  label: string
  title: string
  children: React.ReactNode
  onClose?: () => void
  testId: string
}

function DialogShell({ label, title, children, onClose, testId }: ShellProps): React.JSX.Element {
  const t = useT()
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
              aria-label={t('common.close')}
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
  const t = useT()
  return (
    <DialogShell
      label={t('files.unsaved.label')}
      title={
        multiple ? t('files.unsaved.title.other') : t('files.unsaved.title.one')
      }
      onClose={busy ? undefined : onCancel}
      testId="files-unsaved-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {multiple
          ? t('files.unsaved.bodyMany')
          : t('files.unsaved.bodyOne', { path })}{' '}
        {t('files.unsaved.bodySuffix')}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-unsaved-cancel"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-destructive hover:bg-destructive/10"
          onClick={onDiscard}
          disabled={busy}
          data-testid="files-unsaved-discard"
        >
          <Trash2 size={12} />
          {multiple ? t('files.unsaved.discardAll') : t('files.unsaved.discard')}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onSave}
          disabled={busy}
          data-testid="files-unsaved-save"
        >
          <Save size={12} />
          {busy
            ? t('files.saving')
            : multiple
              ? t('files.unsaved.saveAll')
              : t('files.unsaved.save')}
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
  const t = useT()
  return (
    <DialogShell
      label={t('files.conflict.label')}
      title={t('files.conflict.title')}
      onClose={busy ? undefined : onCancel}
      testId="files-conflict-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {t('files.conflict.body', { path })}
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
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onReload}
          disabled={busy}
          data-testid="files-conflict-reload"
        >
          {t('files.conflict.reload')}
        </button>
        <button
          type="button"
          className="h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-black hover:opacity-90"
          onClick={onOverwrite}
          disabled={busy}
          data-testid="files-conflict-overwrite"
        >
          {busy ? t('files.saving') : t('files.conflict.overwrite')}
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
  const t = useT()
  const tp = useTp()
  const names = paths.slice(0, 10)
  return (
    <DialogShell
      label={t('files.delete.label')}
      title={
        paths.length === 1
          ? t('files.delete.title.one')
          : t('files.delete.title.other', { count: paths.length })
      }
      onClose={busy ? undefined : onCancel}
      testId="files-delete-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {useTrash ? t('files.delete.bodyTrash') : t('files.delete.bodyPermanent')}{' '}
        {t('files.delete.bodySuffix')}
      </p>
      <ul className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
        {names.map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
        {paths.length > names.length ? (
          <li className="text-muted-foreground">
            {t('files.more', { count: paths.length - names.length })}
          </li>
        ) : null}
      </ul>
      {dirtyCount > 0 ? (
        <p className="mt-2 rounded border border-signal/40 bg-signal-weak px-2 py-1.5 text-[11px] text-signal">
          {tp('files.delete.unsaved', dirtyCount)}
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
          {t('common.cancel')}
        </button>
        {useTrash ? (
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] text-destructive hover:bg-destructive/10"
            onClick={onConfirmPermanent}
            disabled={busy}
            data-testid="files-delete-permanent"
          >
            {t('files.delete.permanent')}
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
            ? t('files.deleting')
            : useTrash
              ? t('files.delete.moveToTrash')
              : paths.length === 1
                ? t('files.delete.delete')
                : t('files.delete.count', { count: paths.length })}
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
  const t = useT()
  const tp = useTp()
  const names = paths.slice(0, 10)
  return (
    <DialogShell
      label={t('files.replace.label')}
      title={tp('files.replace.title', matches)}
      onClose={busy ? undefined : onCancel}
      testId="files-replace-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {t('files.replace.body', { files })}
      </p>
      <ul className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
        {names.map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
        {paths.length > names.length ? (
          <li className="text-muted-foreground">
            {t('files.more', { count: paths.length - names.length })}
          </li>
        ) : null}
      </ul>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {t('files.replace.skipped')}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-replace-cancel"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="h-9 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onConfirm}
          disabled={busy}
          data-testid="files-replace-confirm"
        >
          {busy ? t('files.replacing') : t('files.replace.all')}
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
  const t = useT()
  const tp = useTp()
  return (
    <DialogShell
      label={t('files.move.label')}
      title={tp('files.move.title', paths.length)}
      onClose={busy ? undefined : onCancel}
      testId="files-move-dialog"
    >
      <p className="mt-2 flex items-center gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
        <FolderOpen size={13} />
        <span className="font-mono text-foreground">{destination === '' ? t('files.move.root') : destination}</span>
      </p>
      <ul className="mt-2 max-h-32 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
        {paths.slice(0, 10).map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
        {paths.length > 10 ? (
          <li className="text-muted-foreground">
            {t('files.more', { count: paths.length - 10 })}
          </li>
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
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="h-9 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onConfirm}
          disabled={busy}
          data-testid="files-move-confirm"
        >
          {busy ? t('files.moving') : t('files.move.action')}
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
  const t = useT()
  const tp = useTp()
  return (
    <DialogShell
      label={t('files.appClose.label')}
      title={t('files.appClose.title')}
      testId="files-app-close-dialog"
    >
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        {tp('files.appClose.body', sessions, { files })}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
          onClick={onCancel}
          disabled={busy}
          data-testid="files-app-close-cancel"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="h-9 rounded-md border border-border px-3 text-[12px] text-destructive hover:bg-destructive/10"
          onClick={onDiscard}
          disabled={busy}
          data-testid="files-app-close-discard"
        >
          {t('files.appClose.closeWithout')}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90"
          onClick={onSaveAll}
          disabled={busy}
          data-testid="files-app-close-save"
        >
          <Save size={12} />
          {busy ? t('files.saving') : t('files.appClose.saveAll')}
        </button>
      </div>
    </DialogShell>
  )
}
