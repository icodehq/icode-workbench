import { useRef, useState } from 'react'
import {
  Columns2,
  FileCode2,
  FileDiff,
  Folder,
  GitBranch,
  Info,
  Maximize2,
  Minimize2,
  Moon,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Sunrise,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import { isAgentHarness } from '../../../../shared/domain/harness'
import { basenameOf } from '../../files/file-paths'
import {
  isDirty,
  isFileTab,
  tabKey,
  type CenterTab
} from '../../files/open-files'
import { useT } from '../../i18n/use-i18n'
import { translate } from '../../i18n/i18n-store'
import { sessionStateDotClass } from '../status'
import ContextMenu, { type ContextMenuItem, type MenuAnchor } from '../ContextMenu'
import type { PendingAction } from '../../state/workspace'
import type { SplitSide } from '../../state/workspace-split'

export type SessionTabAction =
  | 'details'
  | 'sleep'
  | 'wake'
  | 'restart'
  | 'resume'
  | 'remove'

type Props = {
  workspaceKey: string
  workspaceLabel: string
  workspaceKind: 'default' | 'worktree'
  tabs: readonly CenterTab[]
  sessions: ReadonlyMap<string, SessionSummary>
  /** Session commands available from a session tab's context menu. */
  onSessionAction?: (session: SessionSummary, action: SessionTabAction) => void
  /** The tab shown by the focused pane. */
  focusedTabKey: string | null
  /** Pane id per displayed tab key. */
  displayedPaneByKey: ReadonlyMap<string, string>
  focusedPaneId: string
  pending: Record<string, PendingAction>
  dirtyCount: number
  splitActive: boolean
  zoomed: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onPin: (key: string) => void
  onReorder: (sourceKey: string, targetKey: string) => void
  onCloseAll: () => void
  onSaveAll?: () => void
  onNewAgent: () => void
  onSplit: () => void
  onToggleZoom: () => void
  onCloseOthers?: (key: string) => void
  onCloseRight?: (key: string) => void
  onSplitWithTab?: (key: string, side: SplitSide) => void
  onUnsplit?: () => void
}

function diffLabel(tab: Extract<CenterTab, { kind: 'diff' }>): string {
  return tab.request.kind === 'committed'
    ? basenameOf(tab.request.file.path)
    : basenameOf(tab.request.entry.entry.path)
}

function diffTitle(tab: Extract<CenterTab, { kind: 'diff' }>): string {
  const path =
    tab.request.kind === 'committed'
      ? tab.request.file.path
      : tab.request.entry.entry.path
  const scope =
    tab.request.kind === 'committed'
      ? translate('scm.group.committed')
      : tab.request.entry.area === 'conflicts'
        ? translate('scm.scope.conflict')
        : tab.request.entry.area === 'staged'
          ? translate('scm.scope.staged')
          : tab.request.entry.area === 'untracked'
            ? translate('scm.scope.untracked')
            : translate('scm.scope.unstaged')
  return `${scope} · ${path}`
}

function diffTestId(tab: Extract<CenterTab, { kind: 'diff' }>): string {
  return tab.request.kind === 'committed'
    ? `center-tab-diff-committed-${tab.request.file.path}`
    : `center-tab-diff-${tab.request.entry.area}-${tab.request.entry.entry.path}`
}

/**
 * The single worktree tab list: agent sessions, raw terminals, files and
 * diffs share one order. Session actions live on the tab context menu and in
 * the sidebar; this bar owns switching, closing, creation and split controls.
 */
export default function WorktreeTabStrip({
  workspaceKey,
  workspaceLabel,
  workspaceKind,
  tabs,
  sessions,
  onSessionAction,
  focusedTabKey,
  displayedPaneByKey,
  focusedPaneId,
  pending,
  dirtyCount,
  splitActive,
  zoomed,
  onActivate,
  onClose,
  onPin,
  onReorder,
  onCloseAll,
  onSaveAll,
  onNewAgent,
  onSplit,
  onToggleZoom,
  onCloseOthers,
  onCloseRight,
  onSplitWithTab,
  onUnsplit
}: Props): React.JSX.Element {
  const t = useT()
  const dragging = useRef<string | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState<{
    key: string
    anchor: MenuAnchor
    opener: HTMLElement
  } | null>(null)

  const menuTab = tabMenu === null ? null : (tabs.find((tab) => tabKey(tab) === tabMenu.key) ?? null)
  const menuIndex =
    menuTab === null ? -1 : tabs.findIndex((tab) => tabKey(tab) === tabKey(menuTab))
  const menuSession =
    menuTab !== null && menuTab.kind === 'session'
      ? (sessions.get(menuTab.sessionId) ?? null)
      : null
  const sessionItems: ContextMenuItem[] =
    menuSession !== null && onSessionAction !== undefined
      ? [
          {
            id: 'details',
            label: t('session.details'),
            icon: <Info size={12} />,
            testId: 'session-tab-menu-details',
            onSelect: () => onSessionAction(menuSession, 'details')
          },
          ...(menuSession.sleeping === true
            ? [
                {
                  id: 'wake',
                  label: t('session.wake'),
                  icon: <Sunrise size={12} />,
                  testId: 'session-tab-menu-wake',
                  onSelect: () => onSessionAction(menuSession, 'wake')
                }
              ]
            : menuSession.state === 'live' || menuSession.state === 'starting'
              ? [
                  {
                    id: 'sleep',
                    label: t('session.sleep'),
                    icon: <Moon size={12} />,
                    testId: 'session-tab-menu-sleep',
                    onSelect: () => onSessionAction(menuSession, 'sleep')
                  }
                ]
              : []),
          ...(menuSession.sleeping === true
            ? []
            : [
                {
                  id: 'restart',
                  label: t('session.restart'),
                  icon: <RotateCcw size={12} />,
                  testId: 'session-tab-menu-restart',
                  onSelect: () => onSessionAction(menuSession, 'restart')
                }
              ]),
          ...(menuSession.resumable === true &&
          menuSession.sleeping !== true &&
          menuSession.state !== 'live' &&
          menuSession.state !== 'starting'
            ? [
                {
                  id: 'resume',
                  label: t('session.resume'),
                  icon: <Play size={12} />,
                  testId: 'session-tab-menu-resume',
                  onSelect: () => onSessionAction(menuSession, 'resume')
                }
              ]
            : []),
          {
            id: 'remove',
            label: t('session.remove'),
            icon: <Trash2 size={12} />,
            danger: true,
            testId: 'session-tab-menu-remove',
            onSelect: () => onSessionAction(menuSession, 'remove')
          }
        ]
      : []
  const menuItems: ContextMenuItem[] =
    menuTab === null
      ? []
      : [
          ...sessionItems,
          {
            id: 'close',
            label: t('session.close'),
            icon: <X size={12} />,
            disabled: tabs.length <= 1,
            separatorBefore: sessionItems.length > 0,
            testId: 'session-tab-menu-close',
            onSelect: () => onClose(tabKey(menuTab))
          },
          {
            id: 'close-others',
            label: t('session.closeOthers'),
            disabled: tabs.length <= 1 || onCloseOthers === undefined,
            testId: 'session-tab-menu-close-others',
            onSelect: () => onCloseOthers?.(tabKey(menuTab))
          },
          {
            id: 'close-right',
            label: t('session.closeRight'),
            disabled: menuIndex >= tabs.length - 1 || onCloseRight === undefined,
            testId: 'session-tab-menu-close-right',
            onSelect: () => onCloseRight?.(tabKey(menuTab))
          },
          ...(onSplitWithTab !== undefined
            ? [
                {
                  id: 'split-right',
                  label: t('session.splitRight'),
                  icon: <Columns2 size={12} />,
                  separatorBefore: true,
                  testId: 'session-tab-menu-split-right',
                  onSelect: () => onSplitWithTab(tabKey(menuTab), 'right')
                },
                {
                  id: 'split-down',
                  label: t('session.splitDown'),
                  icon: <Columns2 size={12} />,
                  testId: 'session-tab-menu-split-down',
                  onSelect: () => onSplitWithTab(tabKey(menuTab), 'down')
                }
              ]
            : []),
          ...(splitActive && onUnsplit !== undefined
            ? [
                {
                  id: 'unsplit',
                  label: t('session.unsplit'),
                  separatorBefore: true,
                  testId: 'session-tab-menu-unsplit',
                  onSelect: () => onUnsplit()
                }
              ]
            : [])
        ]

  const moved = (index: number, delta: number): void => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-workspace-tablist="${CSS.escape(workspaceKey)}"] [role="tab"]`)
    )
    const next = buttons[(index + delta + buttons.length) % buttons.length]
    next?.focus()
  }

  return (
    <>
      <nav
        className="icode-titlebar window-chrome-safe flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-card px-2"
        role="tablist"
        aria-label={t('session.tabs')}
        data-testid="session-tabs"
        data-workspace-key={workspaceKey}
        data-workspace-tablist={workspaceKey}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const tabsInBar = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
          )
          const index = tabsInBar.indexOf(document.activeElement as HTMLElement)
          if (index < 0) return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabsInBar.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabsInBar.length) %
                  tabsInBar.length
          const target = tabsInBar[next]
          target?.focus()
          const key = target?.getAttribute('data-tab-key')
          if (key) onActivate(key)
        }}
      >
        <span
          className="flex h-9 shrink-0 items-center gap-1.5 border-r border-border/70 pr-2 text-[11px] text-muted-foreground"
          data-testid="workspace-label"
          title={workspaceLabel}
        >
          {workspaceKind === 'worktree' ? <GitBranch size={11} /> : <Folder size={11} />}
          <span className="max-w-[220px] truncate">{workspaceLabel}</span>
        </span>

        {tabs.map((tab, index) => {
          const key = tabKey(tab)
          const active = key === focusedTabKey
          const session = tab.kind === 'session' ? sessions.get(tab.sessionId) ?? null : null
          const isPreview = tab.kind !== 'session' && tab.preview
          const dirty = isFileTab(tab) && isDirty(tab)
          const displayedElsewhere =
            displayedPaneByKey.get(key) !== undefined &&
            displayedPaneByKey.get(key) !== focusedPaneId
          const label =
            tab.kind === 'session'
              ? (session?.title ?? tab.sessionId)
              : isFileTab(tab)
                ? basenameOf(tab.path)
                : tab.kind === 'room'
                  ? tab.threadId
                  : tab.kind === 'chat'
                    ? tab.label
                    : diffLabel(tab)
          const title =
            tab.kind === 'session'
              ? (session?.title ?? tab.sessionId)
              : isFileTab(tab)
                ? tab.path
                : tab.kind === 'room'
                  ? tab.key
                  : tab.kind === 'chat'
                    ? tab.label
                    : diffTitle(tab)
          const kindLabel =
            tab.kind === 'session'
              ? session !== null && isAgentHarness(session.harness)
                ? translate('newSession.codingAgent')
                : translate('newSession.terminal')
              : ''
          const testId =
            tab.kind === 'session'
              ? `session-tab-${tab.sessionId}`
              : isFileTab(tab)
                ? `center-tab-${tab.path}`
                : tab.kind === 'room'
                  ? `room-tab-${tab.key.replace(/:/g, '-')}`
                  : tab.kind === 'chat'
                    ? `chat-tab-${tab.key.replace(/:/g, '-')}`
                    : diffTestId(tab)
          const closeTestId =
            tab.kind === 'session'
              ? `session-tab-close-${tab.sessionId}`
              : isFileTab(tab)
                ? `center-tab-close-${tab.path}`
                : tab.kind === 'room'
                  ? `room-tab-close-${tab.key.replace(/:/g, '-')}`
                  : tab.kind === 'chat'
                    ? `chat-tab-close-${tab.key.replace(/:/g, '-')}`
                    : `center-tab-close-${key}`
          const isDragged = draggingKey === key
          const isDropTarget = dropKey === key
          return (
            <div
              key={key}
              className={`flex h-9 shrink-0 items-center rounded-sm ${
                isDropTarget ? 'ring-1 ring-inset ring-accent/70' : ''
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable
                className={`inline-flex h-9 max-w-[220px] items-center gap-1.5 border-b-2 px-2.5 text-[11px] ${
                  active
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                } ${isDragged ? 'opacity-50' : ''}`}
                onClick={() => onActivate(key)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setTabMenu({
                    key,
                    anchor: {
                      left: event.clientX,
                      right: event.clientX,
                      top: event.clientY,
                      bottom: event.clientY
                    },
                    opener: event.currentTarget
                  })
                }}
                onDragStart={(event) => {
                  dragging.current = key
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', key)
                  setDraggingKey(key)
                }}
                onDragOver={(event) => {
                  const source = dragging.current
                  if (source === null || source === key) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropKey(key)
                }}
                onDragLeave={() => setDropKey((current) => (current === key ? null : current))}
                onDrop={(event) => {
                  event.preventDefault()
                  const source = dragging.current
                  if (source !== null && source !== key) onReorder(source, key)
                  dragging.current = null
                  setDraggingKey(null)
                  setDropKey(null)
                }}
                onDragEnd={() => {
                  dragging.current = null
                  setDraggingKey(null)
                  setDropKey(null)
                }}
                onDoubleClick={() => {
                  if (tab.kind !== 'session') onPin(key)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    moved(index, event.key === 'ArrowRight' ? 1 : -1)
                  }
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    onClose(key)
                  }
                }}
                title={title}
                data-tab-key={key}
                data-tab-kind={tab.kind}
                data-session-id={tab.kind === 'session' ? tab.sessionId : undefined}
                data-session-state={session?.state}
                data-session-activity={session?.activity?.state ?? 'unknown'}
                data-session-activity-unread={String(session?.activity?.unread ?? false)}
                data-preview={isPreview ? 'true' : undefined}
                data-displayed-pane={displayedPaneByKey.get(key)}
                data-testid={testId}
              >
                {tab.kind === 'session' ? (
                  <>
                    {session !== null ? (
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(
                          session,
                          pending[session.id] ?? null
                        )}`}
                      />
                    ) : null}
                    {session !== null && isAgentHarness(session.harness) ? (
                      <Sparkles size={10} className="shrink-0 text-muted-foreground/70" />
                    ) : (
                      <TerminalSquare size={10} className="shrink-0 text-muted-foreground/70" />
                    )}
                    {session?.activity?.unread === true ? (
                      <span className="h-1 w-1 shrink-0 rounded-full bg-signal" />
                    ) : null}
                    <span className="min-w-0 truncate">{label}</span>
                    <span className="sr-only">{kindLabel}</span>
                  </>
                ) : isFileTab(tab) ? (
                  <>
                    <FileCode2 size={10} className="shrink-0 text-muted-foreground/70" />
                    {dirty ? (
                      <span
                        role="img"
                        aria-label={t('files.tabs.unsavedChanges')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        data-testid="center-tab-dirty"
                      />
                    ) : null}
                    <span
                      className={`max-w-[180px] truncate ${isPreview ? 'italic' : ''}`}
                    >
                      {label}
                    </span>
                  </>
                ) : (
                  <>
                    <FileDiff size={10} className="shrink-0 text-muted-foreground/70" />
                    <span className={`max-w-[180px] truncate ${isPreview ? 'italic' : ''}`}>
                      {label}
                    </span>
                  </>
                )}
                {displayedElsewhere ? (
                  <span
                    className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
                    title={t('session.tabs')}
                  />
                ) : null}
              </button>
              <button
                type="button"
                className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onClose(key)}
                aria-label={
                  tab.kind === 'session'
                    ? t('session.closeTab', { title: label })
                    : t('files.tabs.close', { path: key })
                }
                title={
                  tab.kind === 'session'
                    ? t('session.closeTab', { title: label })
                    : t('files.tabs.close', { path: key })
                }
                data-testid={closeTestId}
              >
                <X size={10} />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          className="my-auto ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onNewAgent}
          aria-label={t('newSession.title')}
          title={t('newSession.title')}
          data-testid="workspace-tab-new"
        >
          <Plus size={14} />
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {dirtyCount > 0 && onSaveAll !== undefined ? (
            <button
              type="button"
              className="rounded px-1.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onSaveAll}
              title={t('files.toolbar.saveAll')}
              data-testid="center-save-all"
            >
              {t('files.tabs.unsaved', { count: dirtyCount })}
            </button>
          ) : null}
          {tabs.some((tab) => tab.kind !== 'session') ? (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onCloseAll}
              title={t('files.toolbar.closeAll')}
              aria-label={t('files.toolbar.closeAll')}
              data-testid="center-close-all"
            >
              <X size={10} />
            </button>
          ) : null}
          <button
            type="button"
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
              splitActive ? 'bg-accent-weak text-accent' : ''
            }`}
            onClick={onSplit}
            aria-pressed={splitActive}
            aria-label={splitActive ? t('session.unsplit') : t('session.split')}
            title={splitActive ? t('session.unsplit') : t('session.split')}
            data-testid="session-split-toggle"
          >
            <Columns2 size={12} />
          </button>
          {splitActive ? (
            <button
              type="button"
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                zoomed ? 'bg-accent-weak text-accent' : ''
              }`}
              onClick={onToggleZoom}
              aria-pressed={zoomed}
              aria-label={zoomed ? t('session.unzoom') : t('session.zoom')}
              title={zoomed ? t('session.unzoom') : t('session.zoom')}
              data-testid="session-zoom-toggle"
            >
              {zoomed ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          ) : null}
        </div>
      </nav>
      {tabMenu !== null && menuTab !== null ? (
        <ContextMenu
          items={menuItems}
          ariaLabel={t('session.tabMenu')}
          testId="session-tab-menu"
          width={210}
          anchor={tabMenu.anchor}
          returnFocus={tabMenu.opener}
          opener={tabMenu.opener}
          onClose={() => setTabMenu(null)}
        />
      ) : null}
    </>
  )
}
