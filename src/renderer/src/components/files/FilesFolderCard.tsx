import { History, Pencil, Trash2 } from 'lucide-react'
import { useT } from '../../i18n/use-i18n'

export default function FilesFolderCard({
  name,
  path,
  canOpenHistory,
  onOpenHistory,
  onRename,
  onDelete
}: {
  name: string
  path: string
  canOpenHistory: boolean
  onOpenHistory: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4">
        <h2 className="text-[13px] font-semibold">{name}</h2>
        <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{path}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('files.folderRenameNote')}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {canOpenHistory ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
              data-testid="files-folder-history"
              onClick={onOpenHistory}
            >
              <History size={10} />
              {t('files.menu.history')}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
            data-testid="files-folder-rename"
            onClick={onRename}
          >
            <Pencil size={10} />
            {t('files.menu.renameEllipsis')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
            data-testid="files-folder-delete"
            onClick={onDelete}
          >
            <Trash2 size={10} />
            {t('files.deleteFolder')}
          </button>
        </div>
      </div>
    </div>
  )
}
