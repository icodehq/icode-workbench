import type { RefObject } from 'react'
import { Save, TerminalSquare, X } from 'lucide-react'
import { basenameOf } from '../../files/file-paths'
import {
  isDirty,
  isFileTab,
  tabKey,
  type CenterTab,
  type DiffTab
} from '../../files/open-files'
import { useT } from '../../i18n/use-i18n'
import { translate } from '../../i18n/i18n-store'

/** The stable test id for a center tab. File tabs keep the path; diffs name their scope. */
export function centerTabTestId(tab: CenterTab): string {
  if (isFileTab(tab)) return `center-tab-${tab.path}`
  return tab.request.kind === 'committed'
    ? `center-tab-diff-committed-${tab.request.file.path}`
    : `center-tab-diff-${tab.request.entry.area}-${tab.request.entry.entry.path}`
}

function diffTabLabel(tab: DiffTab): string {
  if (tab.request.kind === 'committed') return basenameOf(tab.request.file.path)
  return basenameOf(tab.request.entry.entry.path)
}

function diffTabScope(tab: DiffTab): string {
  if (tab.request.kind === 'committed') return translate('scm.group.committed')
  const area = tab.request.entry.area
  return area === 'conflicts'
    ? translate('scm.scope.conflict')
    : area === 'staged'
      ? translate('scm.scope.staged')
      : area === 'untracked'
        ? translate('scm.scope.untracked')
        : translate('scm.scope.unstaged')
}

export default function CenterTabStrip({
  tabs,
  activeKey,
  terminalActive,
  dirtyCount,
  stripHidden,
  tabRefs,
  onShowTerminal,
  onActivate,
  onPin,
  onClose,
  onSaveAll,
  onCloseAll
}: {
  tabs: CenterTab[]
  activeKey: string | null
  terminalActive: boolean
  dirtyCount: number
  stripHidden: boolean
  tabRefs: RefObject<Map<string, HTMLDivElement>>
  onShowTerminal: () => void
  onActivate: (key: string) => void
  onPin: (key: string) => void
  onClose: (key: string) => void
  onSaveAll: () => void
  onCloseAll: () => void
}): React.JSX.Element | null {
  const t = useT()
  if (stripHidden || tabs.length === 0) return null

  const moveFocus = (index: number, delta: number): void => {
    const next = (index + delta + tabs.length) % tabs.length
    const tab = tabs[next]
    if (tab !== undefined) tabRefs.current.get(tabKey(tab))?.focus()
  }

  return (
    <div
      className="flex h-8 shrink-0 items-center border-b border-border bg-card"
      data-testid="center-tabs"
    >
      <button
        type="button"
        className={`inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] ${
          terminalActive
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }`}
        onClick={onShowTerminal}
        data-testid="center-tab-terminal"
        aria-pressed={terminalActive}
      >
        <TerminalSquare size={11} />
        {t('session.viewTerminal')}
      </button>
      <div
        role="tablist"
        aria-label={t('files.tabs.openFiles')}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
        data-testid="center-tab-list"
      >
        {tabs.map((tab, index) => {
          const key = tabKey(tab)
          const active = !terminalActive && key === activeKey
          const label = isFileTab(tab) ? basenameOf(tab.path) : diffTabLabel(tab)
          const path = isFileTab(tab)
            ? tab.path
            : tab.request.kind === 'committed'
              ? tab.request.file.path
              : tab.request.entry.entry.path
          const title = isFileTab(tab) && tab.preview
            ? t('files.tabs.previewHint')
            : isFileTab(tab)
              ? tab.path
              : `${diffTabScope(tab)} · ${path}`
          return (
            <div
              key={key}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(key)
                else tabRefs.current.set(key, element)
              }}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={title}
              className={`group flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] outline-none ${
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/60'
              } ${isFileTab(tab) && tab.load === 'failed' ? 'text-destructive' : ''}`}
              data-preview={tab.preview ? 'true' : undefined}
              data-tab-kind={tab.kind}
              onClick={() => onActivate(key)}
              onDoubleClick={() => onPin(key)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault()
                  moveFocus(index, event.key === 'ArrowRight' ? 1 : -1)
                  return
                }
                if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const target = tabs[event.key === 'Home' ? 0 : tabs.length - 1]
                  if (target !== undefined) tabRefs.current.get(tabKey(target))?.focus()
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onActivate(key)
                  return
                }
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault()
                  onClose(key)
                }
              }}
              data-testid={centerTabTestId(tab)}
            >
              {isFileTab(tab) && tab.load === 'loading' ? (
                <span className="text-[9px]">…</span>
              ) : isFileTab(tab) && isDirty(tab) ? (
                <span
                  role="img"
                  aria-label={t('files.tabs.unsavedChanges')}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  data-testid="center-tab-dirty"
                />
              ) : null}
              <span
                className={`max-w-[180px] truncate ${tab.preview ? 'italic' : ''}`}
              >
                {label}
              </span>
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                aria-label={t('files.tabs.close', { path: key })}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(key)
                }}
                data-testid={`center-tab-close-${key}`}
              >
                <X size={9} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        {dirtyCount > 0 ? (
          <span className="px-1 text-[9px] text-muted-foreground" data-testid="center-dirty-count">
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
          data-testid="center-save-all"
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
          data-testid="center-close-all"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  )
}
