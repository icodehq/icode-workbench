import { useEffect, useRef, type ReactNode } from 'react'
import {
  FileCode2,
  FileDiff,
  Sparkles,
  TerminalSquare,
  X
} from 'lucide-react'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import type { Notice } from '../../state/workspace'
import type { WorkbenchDraftStore } from '../../review/drafts'
import {
  fileTabs,
  findTab,
  isDirty,
  openFilesStore,
  tabKey,
  useSessionFiles,
  type CenterTab,
  type DiffTab,
  type FileTab
} from '../../files/open-files'
import { useSessionEditor } from '../../files/use-session-editor'
import { basenameOf } from '../../files/file-paths'
import { useT } from '../../i18n/use-i18n'
import { translate } from '../../i18n/i18n-store'
import CodeEditor from '../CodeEditor'
import { SaveConflictDialog, UnsavedFilesDialog } from '../FilesDialogs'
import ScmDiffTab from '../scm/ScmDiffTab'
import type { SplitLeaf } from '../../state/workspace-split'

export type WorktreeTabRequest = {
  path: string
  line: number
  preview: boolean
  /** True when the pane should read the file (new or failed placeholder). */
  load: boolean
  nonce: number
}

/** Close/save actions a pane lends to the shared tab bar. */
export type PaneTabActions = {
  requestClose: (key: string) => void
  requestCloseAll: () => void
  saveAll: () => void
}

type Props = {
  leaf: SplitLeaf
  tabs: readonly CenterTab[]
  sessions: ReadonlyMap<string, SessionSummary>
  scopeKey: string
  ownerSessionId: string | null
  ownerSessionState: string | null
  refreshToken: number
  drafts: WorkbenchDraftStore
  notify: (notice: Notice) => void
  focused: boolean
  splitActive: boolean
  request: WorktreeTabRequest | null
  onRequestHandled: () => void
  onFocus: () => void
  onClosePane: () => void
  onPickTab: (key: string) => void
  onNewAgent: () => void
  onNewTerminal: () => void
  onOpenHistory?: (path: string) => void
  /** Registers this pane's dirty-close/save handlers with the tab bar. */
  onTabActions?: (paneId: string, actions: PaneTabActions | null) => void
  /** Session-tab content is supplied by the surface so it keeps session actions. */
  renderSession: (session: SessionSummary, focused: boolean) => ReactNode
}

function fileLabel(tab: FileTab): string {
  return basenameOf(tab.path)
}

function diffLabel(tab: DiffTab): string {
  return tab.request.kind === 'committed'
    ? basenameOf(tab.request.file.path)
    : basenameOf(tab.request.entry.entry.path)
}


/**
 * One split pane. Its content follows the tab key the pane remembers: a session
 * terminal, a file editor, a diff view, or the empty-pane tab picker.
 */
export default function WorktreePane({
  leaf,
  tabs,
  sessions,
  scopeKey,
  ownerSessionId,
  ownerSessionState,
  refreshToken,
  drafts,
  notify,
  focused,
  splitActive,
  request,
  onRequestHandled,
  onFocus,
  onClosePane,
  onPickTab,
  onNewAgent,
  onNewTerminal,
  onOpenHistory,
  onTabActions,
  renderSession
}: Props): React.JSX.Element {
  const t = useT()
  const sessionFiles = useSessionFiles(scopeKey)
  const files = fileTabs(sessionFiles)
  // Each pane renders the tab it remembers, not the store's last-focused tab:
  // two panes may show different files/diffs at once.
  const active =
    leaf.activeTabKey === null ? null : findTab(sessionFiles, leaf.activeTabKey)
  const file = active !== null && active.kind === 'file' ? active : null
  const diff = active !== null && active.kind === 'diff' ? active : null
  const editor = useSessionEditor({
    sessionId: ownerSessionId ?? '',
    scopeKey,
    ownerSessionId: ownerSessionId ?? '',
    refreshToken,
    notify,
    sessionFiles,
    tabs: files,
    activeTab: file
  })
  const dirtyCount = files.reduce((count, tab) => (isDirty(tab) ? count + 1 : count), 0)

  const editorRef = useRef(editor)
  editorRef.current = editor
  useEffect(() => {
    if (onTabActions === undefined) return
    onTabActions(leaf.paneId, {
      requestClose: (key) => editorRef.current.requestClose(key),
      requestCloseAll: () => editorRef.current.requestCloseAll(),
      saveAll: () => void editorRef.current.saveAllTabs()
    })
    return () => onTabActions(leaf.paneId, null)
  }, [leaf.paneId, onTabActions])

  useEffect(() => {
    if (request === null) return
    if (ownerSessionId === null) {
      onRequestHandled()
      return
    }
    void editor.openFile(request.path, request.line, {
      preview: request.preview,
      load: request.load
    })
    onRequestHandled()
    // The request nonce is the handshake; editor functions are stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce])

  const activeKey = leaf.activeTabKey
  const sessionId =
    activeKey !== null && activeKey.startsWith('session:')
      ? activeKey.slice('session:'.length)
      : null
  const session = sessionId === null ? null : sessions.get(sessionId) ?? null
  const undisplayed = tabs.filter((tab) => tabKey(tab) !== activeKey)

  let content: ReactNode = null
  if (session !== null) {
    content = renderSession(session, focused)
  } else if (file !== null && activeKey === tabKey(file) && ownerSessionId !== null) {
    content = (
      <div
        className="flex h-full min-h-0 flex-col bg-background"
        data-testid="center-editor"
      >
        {editor.hotExitNote.length > 0 ? (
          <div
            className="flex items-center gap-2 border-b border-border bg-signal-weak px-3 py-1 text-[10px] text-signal"
            data-testid="center-hot-exit-note"
          >
            <span className="min-w-0 flex-1">{editor.hotExitNote}</span>
            <button
              type="button"
              className="shrink-0 rounded px-1 hover:bg-signal/10"
              aria-label={t('files.toolbar.dismiss')}
              onClick={() => editor.setHotExitNote('')}
            >
              <X size={10} />
            </button>
          </div>
        ) : null}
        {editor.fileNote.length > 0 ? (
          <p className="border-b border-border px-3 py-1 text-[10px] text-signal">
            {editor.fileNote}
          </p>
        ) : null}
        {file.disk === 'changed' ? (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-signal/40 bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
            data-testid="center-disk-changed"
          >
            <span className="min-w-0 flex-1">{t('files.disk.changed')}</span>
            <button
              type="button"
              className="rounded border border-signal/50 px-1.5 py-0.5 hover:bg-signal/10"
              onClick={() => void editor.reloadFromDisk(file.path)}
              data-testid="center-disk-reload"
            >
              {t('files.disk.reload')}
            </button>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
              onClick={() => void editor.keepMine(file.path)}
              data-testid="center-disk-keep"
            >
              {t('files.disk.keepMine')}
            </button>
          </div>
        ) : file.disk === 'deleted' ? (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-signal/40 bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
            data-testid="center-disk-deleted"
          >
            <span className="min-w-0 flex-1">{t('files.disk.deleted')}</span>
            <button
              type="button"
              className="rounded border border-signal/50 px-1.5 py-0.5 hover:bg-signal/10"
              onClick={() => void editor.saveTabAt(file.path, null, false)}
              data-testid="center-disk-recreate"
            >
              {t('files.disk.recreate')}
            </button>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
              onClick={() => editor.requestClose(file.path)}
              data-testid="center-disk-close"
            >
              {t('files.disk.close')}
            </button>
          </div>
        ) : null}
        {file.load === 'loading' ? (
          <div
            className="flex flex-1 items-center justify-center p-6"
            data-testid="center-tab-loading"
          >
            <p className="text-[11.5px] text-muted-foreground">
              {t('files.opening', { path: file.path })}
            </p>
          </div>
        ) : file.load === 'failed' ? (
          <div
            className="flex flex-1 items-center justify-center p-6 text-center"
            data-testid="center-tab-failure"
          >
            <div className="max-w-sm">
              <p className="text-[11.5px] leading-relaxed text-signal">{file.failure}</p>
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  onClick={() => void editor.loadTab(file.path, 1)}
                  data-testid="center-tab-retry"
                >
                  {t('common.retry')}
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => editor.requestClose(file.path)}
                  data-testid="center-tab-failure-close"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <CodeEditor
            path={file.path}
            value={file.text}
            dirty={isDirty(file)}
            gotoLine={editor.gotoLine}
            onGotoLineConsumed={editor.onGotoLineConsumed}
            onChange={(next) => openFilesStore.updateText(scopeKey, file.path, next)}
            onSave={() => void editor.saveActive()}
            onClose={() => editor.requestClose(file.path)}
            onHistory={onOpenHistory ? () => onOpenHistory(file.path) : undefined}
            engine="monaco"
            original={file.original}
            onQuickDiffChanged={() => {
              void editor.reloadFromDisk(file.path)
            }}
            sessionId={ownerSessionId ?? ''}
            scopeKey={scopeKey}
            active={focused}
          />
        )}
      </div>
    )
  } else if (diff !== null && activeKey === tabKey(diff) && ownerSessionId !== null) {
    content = (
      <div className="flex h-full min-h-0 flex-col bg-background" data-testid="center-diff">
        <ScmDiffTab
          sessionId={ownerSessionId}
          scopeKey={scopeKey}
          tab={diff}
          active={focused}
          refreshToken={refreshToken}
          sessionState={ownerSessionState ?? 'unavailable'}
          drafts={drafts}
        />
      </div>
    )
  } else {
    content = (
      <div
        className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-6"
        data-testid="workspace-empty-pane"
        data-pane-id={leaf.paneId}
      >
        <p className="text-[12px] font-medium text-foreground">{t('session.tabs')}</p>
        {undisplayed.length > 0 ? (
          <div className="flex max-h-[40vh] w-full max-w-sm flex-col gap-1 overflow-auto">
            {undisplayed.map((tab) => {
              const key = tabKey(tab)
              const label =
                tab.kind === 'session'
                  ? (sessions.get(tab.sessionId)?.title ?? tab.sessionId)
                  : tab.kind === 'file'
                    ? fileLabel(tab)
                    : diffLabel(tab)
              return (
                <button
                  key={key}
                  type="button"
                  className="flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left text-[11px] hover:bg-muted"
                  onClick={() => onPickTab(key)}
                  data-testid={`workspace-pick-tab-${key}`}
                >
                  {tab.kind === 'session' ? (
                    <TerminalSquare size={11} className="shrink-0 text-muted-foreground" />
                  ) : tab.kind === 'file' ? (
                    <FileCode2 size={11} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FileDiff size={11} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate">{label}</span>
                </button>
              )
            })}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
            onClick={onNewAgent}
            data-testid="workspace-empty-new-agent"
          >
            <Sparkles size={11} />
            {t('newSession.codingAgent')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
            onClick={onNewTerminal}
            data-testid="workspace-empty-new-terminal"
          >
            <TerminalSquare size={11} />
            {t('newSession.terminal')}
          </button>
        </div>
        {dirtyCount > 0 ? (
          <p className="text-[10px] text-muted-foreground">
            {translate('files.tabs.unsaved', { count: dirtyCount })}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${
        focused ? '' : 'opacity-[0.995]'
      }`}
      data-testid="workspace-pane"
      data-pane-id={leaf.paneId}
      data-active-tab={activeKey ?? ''}
      data-focused={focused ? 'true' : 'false'}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return
        onFocus()
      }}
    >
      {splitActive ? (
        <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-card px-1 text-[10px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {activeKey === null
              ? t('session.tabs')
              : (session?.title ??
                (file !== null ? fileLabel(file) : diff !== null ? diffLabel(diff) : activeKey))}
          </span>
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted hover:text-foreground"
            onClick={onClosePane}
            aria-label={t('common.close')}
            title={t('common.close')}
            data-testid={`workspace-pane-close-${leaf.paneId}`}
          >
            <X size={9} />
          </button>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">{content}</div>

      {editor.unsaved !== null ? (
        <UnsavedFilesDialog
          path={editor.unsaved.kind === 'single' ? editor.unsaved.path : ''}
          multiple={editor.unsaved.kind === 'all'}
          busy={editor.dialogBusy}
          onSave={() => void editor.confirmUnsavedSave()}
          onDiscard={editor.confirmUnsavedDiscard}
          onCancel={() => {
            editor.setUnsaved(null)
            editor.setCloseAfterSave(null)
          }}
        />
      ) : null}

      {editor.conflict !== null ? (
        <SaveConflictDialog
          path={editor.conflict.path}
          detail={editor.conflict.detail}
          busy={editor.dialogBusy}
          onOverwrite={() => void editor.resolveConflictOverwrite()}
          onReload={() => void editor.resolveConflictReload()}
          onCancel={editor.cancelConflict}
        />
      ) : null}
    </div>
  )
}
