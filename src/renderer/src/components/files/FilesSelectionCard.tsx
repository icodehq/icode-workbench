import { Copy, Trash2 } from 'lucide-react'
import { useT, useTp } from '../../i18n/use-i18n'

export default function FilesSelectionCard({
  total,
  files,
  directories,
  onCopyPath,
  onCopyRelativePath,
  onDelete
}: {
  total: number
  files: number
  directories: number
  onCopyPath: () => void
  onCopyRelativePath: () => void
  onDelete: () => void
}): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="files-selection-card">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4">
        <h2 className="text-[13px] font-semibold">{total} items selected</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t('files.selectionSummary', {
            files: tp('files.summary.files', files),
            directories: tp('files.summary.directories', directories)
          })}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
            data-testid="files-selection-copy-path"
            onClick={onCopyPath}
          >
            <Copy size={10} />
            {t('files.menu.copyPath')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
            data-testid="files-selection-copy-relative-path"
            onClick={onCopyRelativePath}
          >
            <Copy size={10} />
            {t('files.menu.copyRelativePath')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
            data-testid="files-selection-delete"
            onClick={onDelete}
          >
            <Trash2 size={10} />
            {t('files.menu.deleteEllipsis')}
          </button>
        </div>
      </div>
    </div>
  )
}
