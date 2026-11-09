import { useEffect, useState } from 'react'
import { openFilesStore } from '../files/open-files'
import { AppCloseDialog } from './FilesDialogs'

/**
 * Answers main's window-close request after checking every session's tabs.
 *
 * Save All writes with each tab's expected version. A conflict or a failed
 * write cancels the close and says which file needs attention; the user can
 * return to Files, resolve it, and close again.
 */
import { useT } from '../i18n/use-i18n'

export default function AppCloseGuard(): React.JSX.Element | null {
  const t = useT()
  const [prompt, setPrompt] = useState<{ files: number; sessions: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    return window.icode.window.onBeforeClose(() => {
      // Acknowledge immediately, so main does not run its short unresponsive-
      // renderer fallback while the user is deciding or saving.
      void window.icode.window.respondClose('ack')
      const summary = openFilesStore.dirtySummary()
      if (summary.files === 0) {
        void openFilesStore.flush().then(() => window.icode.window.respondClose('close'))
        return
      }
      setFailure(null)
      setPrompt(summary)
    })
  }, [])

  if (prompt === null) return null

  const saveAllAndClose = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const tabs = openFilesStore.allDirtyTabs()
    for (const tab of tabs) {
      const result = await window.icode.files.write({
        sessionId: tab.sessionId,
        path: tab.path,
        text: tab.text,
        expectedEtag: tab.etag
      })
      if (!result.ok) {
        setBusy(false)
        setFailure(
          t('files.appClose.saveError', {
            path: tab.path,
            detail: result.error.message
          })
        )
        await window.icode.window.respondClose('cancel')
        return
      }
      if (result.value.status === 'unavailable') {
        const detail =
          result.value.reason === 'changed-on-disk'
            ? t('files.appClose.changedOnDisk')
            : result.value.detail
        setBusy(false)
        setFailure(t('files.appClose.saveError', { path: tab.path, detail }))
        await window.icode.window.respondClose('cancel')
        return
      }
      openFilesStore.markSaved(tab.sessionId, tab.path, result.value.etag)
    }
    setBusy(false)
    await openFilesStore.flush()
    await window.icode.window.respondClose('close')
  }

  const discardAndClose = async (): Promise<void> => {
    setBusy(true)
    // Discard means the dirty buffers must not reappear through hot exit.
    for (const tab of openFilesStore.allDirtyTabs()) {
      openFilesStore.closeTab(tab.sessionId, tab.path)
    }
    await openFilesStore.flush()
    await window.icode.window.respondClose('close')
    setBusy(false)
  }

  const cancel = async (): Promise<void> => {
    await window.icode.window.respondClose('cancel')
    setPrompt(null)
    setFailure(null)
  }

  if (failure !== null) {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
        role="dialog"
        aria-modal="true"
        aria-label={t('files.appClose.label')}
        data-testid="files-app-close-failure"
      >
        <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
          <h2 className="text-[16px] font-semibold">{t('files.appClose.failedTitle')}</h2>
          <p className="mt-2 text-[12px] leading-relaxed text-signal">{failure}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
              onClick={() => {
                setFailure(null)
                setPrompt(null)
              }}
              data-testid="files-app-close-failure-dismiss"
            >
              {t('files.appClose.back')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <AppCloseDialog
      files={prompt.files}
      sessions={prompt.sessions}
      busy={busy}
      onSaveAll={() => void saveAllAndClose()}
      onDiscard={() => void discardAndClose()}
      onCancel={() => void cancel()}
    />
  )
}
