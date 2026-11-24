import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../i18n/use-i18n'
import {
  activeFileTab,
  activeTab,
  fileTabs,
  isDirty,
  openFilesStore,
  useSessionFiles,
  type DiffTabRequest
} from '../../files/open-files'
import { useSessionEditor } from '../../files/use-session-editor'
import type { Notice } from '../../state/workspace'
import type { WorkbenchDraftStore } from '../../review/drafts'
import CodeEditor from '../CodeEditor'
import { SaveConflictDialog, UnsavedFilesDialog } from '../FilesDialogs'
import CenterTabStrip from './CenterTabStrip'
import ScmDiffTab from '../scm/ScmDiffTab'

/**
 * The workspace's central tab content: the terminal and the session's open
 * file/diff tabs share one surface. The terminal stays mounted underneath while
 * an editor is shown, so the PTY and scrollback survive; the editor's buffer
 * lives in the open-files store, so switching back never drops unsaved text.
 */
export default function SessionCenterTabs({
  sessionId,
  refreshToken,
  notify,
  focused,
  hideStrip = false,
  request,
  onRequestHandled,
  diffRequest,
  onDiffRequestHandled,
  onOpenHistory,
  drafts,
  sessionState,
  terminal
}: {
  sessionId: string
  refreshToken: number
  notify: (notice: Notice) => void
  /** True while this session's pane is the focused one. */
  focused: boolean
  /** Focus mode hides the strip but keeps the current target. */
  hideStrip?: boolean
  /** A one-shot request from the tree, search, quick open or the palette. */
  request: { path: string; line: number; nonce: number; preview?: boolean } | null
  onRequestHandled: () => void
  /** A one-shot diff tab request from the Changes list. */
  diffRequest: {
    sessionId: string
    request: DiffTabRequest
    preview: boolean
    nonce: number
  } | null
  onDiffRequestHandled: () => void
  onOpenHistory?: (path: string) => void
  drafts: WorkbenchDraftStore
  sessionState: string
  /** The terminal panes; always mounted, hidden while an editor is showing. */
  terminal: ReactNode
}): React.JSX.Element {
  const t = useT()
  const sessionFiles = useSessionFiles(sessionId)
  const files = fileTabs(sessionFiles)
  const active = activeTab(sessionFiles)
  const file = activeFileTab(sessionFiles)
  const dirtyCount = files.reduce((count, tab) => (isDirty(tab) ? count + 1 : count), 0)

  const editor = useSessionEditor({
    sessionId,
    refreshToken,
    notify,
    sessionFiles,
    tabs: files,
    activeTab: file
  })

  useEffect(() => {
    if (request === null) return
    void editor.openFile(request.path, request.line, {
      preview: request.preview ?? true
    })
    onRequestHandled()
    // The request's nonce is the handshake; editor functions are stable enough
    // for this effect to fire once per request.
  }, [request?.nonce])

  useEffect(() => {
    if (diffRequest === null) return
    openFilesStore.openDiff(sessionId, diffRequest.request, {
      preview: diffRequest.preview
    })
    onDiffRequestHandled()
  }, [diffRequest?.nonce])

  const editorVisible = sessionFiles.mode === 'editor' && active !== null
  const terminalVisible = !editorVisible
  const fileVisible = editorVisible && file !== null
  const diffVisible = editorVisible && active !== null && active.kind === 'diff'

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="session-center"
      data-mode={sessionFiles.mode}
      data-session-id={sessionId}
      data-focused={focused ? 'true' : 'false'}
    >
      <CenterTabStrip
        tabs={sessionFiles.tabs}
        activeKey={sessionFiles.activeKey}
        terminalActive={terminalVisible}
        dirtyCount={dirtyCount}
        stripHidden={hideStrip}
        tabRefs={editor.tabRefs}
        onShowTerminal={() => editor.setMode('terminal')}
        onActivate={(key) => editor.activateTab(key)}
        onPin={(key) => editor.pin(key)}
        onClose={(key) => editor.requestClose(key)}
        onSaveAll={() => void editor.saveAllTabs()}
        onCloseAll={() => editor.requestCloseAll()}
      />

      <div className="relative min-h-0 flex-1">
        <div
          className={
            terminalVisible
              ? 'flex h-full min-h-0 flex-col'
              : 'hidden h-full min-h-0 flex-col'
          }
          data-testid="center-terminal"
        >
          {terminal}
        </div>

        {file !== null ? (
          <div
            className={
              fileVisible
                ? 'flex h-full min-h-0 flex-col bg-background'
                : 'hidden h-full min-h-0 flex-col'
            }
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
              <div className="flex flex-1 items-center justify-center p-6" data-testid="center-tab-loading">
                <p className="text-[11.5px] text-muted-foreground">
                  {t('files.opening', { path: file.path })}
                </p>
              </div>
            ) : file.load === 'failed' ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center" data-testid="center-tab-failure">
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
                onChange={(next) => openFilesStore.updateText(sessionId, file.path, next)}
                onSave={() => void editor.saveActive()}
                onClose={() => editor.requestClose(file.path)}
                onHistory={onOpenHistory ? () => onOpenHistory(file.path) : undefined}
                engine="monaco"
                original={file.original}
                onQuickDiffChanged={() => {
                  void editor.reloadFromDisk(file.path)
                }}
                sessionId={sessionId}
                active={focused && fileVisible}
              />
            )}
          </div>
        ) : null}

        {diffVisible && active !== null && active.kind === 'diff' ? (
          <div
            className="flex h-full min-h-0 flex-col bg-background"
            data-testid="center-diff"
          >
            <ScmDiffTab
              sessionId={sessionId}
              tab={active}
              active={focused && diffVisible}
              refreshToken={refreshToken}
              sessionState={sessionState}
              drafts={drafts}
            />
          </div>
        ) : null}
      </div>

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
