import type { RefObject } from 'react'
import {
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  X
} from 'lucide-react'
import { basenameOf } from '../../files/file-paths'
import { isDirty, type OpenFileTab } from '../../files/open-files'
import { useT } from '../../i18n/use-i18n'

export default function FilesTabStrip({
  tabs,
  activePath,
  dirtyCount,
  detailMaximized,
  twoColumnAvailable,
  listHidden,
  tabRefs,
  onToggleList,
  onToggleMaximize,
  onCloseActive,
  onActivate,
  onClose,
  onTabKeyDown,
  onSaveAll,
  onCloseAll
}: {
  tabs: OpenFileTab[]
  activePath: string | null
  dirtyCount: number
  detailMaximized: boolean
  twoColumnAvailable: boolean
  listHidden: boolean
  tabRefs: RefObject<Map<string, HTMLDivElement>>
  onToggleList: () => void
  onToggleMaximize: () => void
  onCloseActive: () => void
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onTabKeyDown: (
    event: React.KeyboardEvent<HTMLDivElement>,
    index: number,
    path: string
  ) => void
  onSaveAll: () => void
  onCloseAll: () => void
}): React.JSX.Element | null {
  const t = useT()
  if (tabs.length === 0) return null

  return (
    <div className="flex h-8 shrink-0 items-center border-b border-border bg-card">
      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        {detailMaximized ? null : (
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={
              twoColumnAvailable && !listHidden ? t('session.hideList') : t('session.showList')
            }
            aria-label={
              twoColumnAvailable && !listHidden ? t('session.hideList') : t('session.showList')
            }
            data-testid="files-list-toggle"
            onClick={onToggleList}
          >
            {twoColumnAvailable && !listHidden ? (
              <PanelLeftClose size={12} />
            ) : (
              <PanelLeftOpen size={12} />
            )}
          </button>
        )}
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title={detailMaximized ? t('session.restoreDetail') : t('session.maximizeDetail')}
          aria-label={detailMaximized ? t('session.restoreDetail') : t('session.maximizeDetail')}
          data-testid="files-detail-maximize"
          onClick={onToggleMaximize}
        >
          {detailMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        {activePath === null ? null : (
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('common.close')}
            aria-label={t('common.close')}
            data-testid="files-detail-close"
            onClick={onCloseActive}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div
        role="tablist"
        aria-label={t('files.tabs.openFiles')}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
        data-testid="files-tabs"
      >
        {tabs.map((tab, index) => {
          const selectedTab = tab.path === activePath
          return (
            <div
              key={tab.path}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(tab.path)
                else tabRefs.current.set(tab.path, element)
              }}
              role="tab"
              aria-selected={selectedTab}
              tabIndex={selectedTab ? 0 : -1}
              title={tab.path}
              className={`group flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] outline-none ${
                selectedTab
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/60'
              } ${tab.load === 'failed' ? 'text-destructive' : ''}`}
              onClick={() => onActivate(tab.path)}
              onKeyDown={(event) => onTabKeyDown(event, index, tab.path)}
              data-testid={`files-tab-${tab.path}`}
            >
              {tab.load === 'loading' ? (
                <span className="text-[9px]">…</span>
              ) : isDirty(tab) ? (
                <span
                  role="img"
                  aria-label={t('files.tabs.unsavedChanges')}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  data-testid="files-tab-dirty"
                />
              ) : null}
              <span className="max-w-[180px] truncate">{basenameOf(tab.path)}</span>
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                aria-label={t('files.tabs.close', { path: tab.path })}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.path)
                }}
                data-testid={`files-tab-close-${tab.path}`}
              >
                <X size={9} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        {dirtyCount > 0 ? (
          <span className="px-1 text-[9px] text-muted-foreground" data-testid="files-dirty-count">
            {t('files.tabs.unsaved', { count: dirtyCount })}
          </span>
        ) : null}
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          title={t('files.toolbar.saveAll')}
          aria-label={t('files.toolbar.saveAll')}
          disabled={dirtyCount === 0}
          onClick={onSaveAll}
          data-testid="files-save-all"
        >
          <Save size={10} />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          title={t('files.toolbar.closeAll')}
          aria-label={t('files.toolbar.closeAll')}
          disabled={tabs.length === 0}
          onClick={onCloseAll}
          data-testid="files-close-all"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  )
}
