import { FolderGit2, Plus } from 'lucide-react'
import { useT } from '../../i18n/use-i18n'

type Props = {
  onAddRepository: () => void
}

/**
 * The only surface shown before a project exists. Projects themselves live in
 * the sidebar; there is no project wall once one is registered.
 */
export default function WorkspaceWelcome({ onAddRepository }: Props): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-1 items-center justify-center p-8" data-testid="empty-workspace">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <FolderGit2 size={15} className="text-muted-foreground" />
          <h1 className="text-[14px] font-semibold">{t('projects.empty.title')}</h1>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('projects.empty.body')}
        </p>
        <button
          type="button"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
          onClick={onAddRepository}
          data-testid="empty-add-repo"
        >
          <Plus size={12} />
          {t('projects.addProject')}
        </button>
      </div>
    </div>
  )
}
