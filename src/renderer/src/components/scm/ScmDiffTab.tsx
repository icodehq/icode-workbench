import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { makeAppError } from '../../../../shared/domain/errors'
import { useWorkbenchDraft, type LineComment, type WorkbenchDraftStore } from '../../review/drafts'
import {
  loadScmSettings,
  saveScmSettings,
  subscribeScmSettings,
  type ScmSettings
} from '../../scm/scm-settings'
import {
  findScmEntry,
  findScmEntryByPath,
  getScmController,
  useScmControllerVersion
} from '../../scm/controller-registry'
import { useWorkingDiff } from '../../scm/use-working-diff'
import { openFilesStore, type DiffTab } from '../../files/open-files'
import { useT } from '../../i18n/use-i18n'
import { translate } from '../../i18n/i18n-store'
import WorkingDiffView, { type WorkingDiffMode } from '../WorkingDiffView'
import CommittedFileDiff from '../history/CommittedFileDiff'
import type { DiffViewState } from '../UnifiedDiffView'

/**
 * A diff opened as a center tab. The Changes list owns status and staging; this
 * tab owns its patch, polls it while visible, and uses the session controller's
 * hunk/conflict actions without starting a second Git read loop.
 */
export default function ScmDiffTab({
  sessionId,
  scopeKey = sessionId,
  tab,
  active,
  refreshToken,
  sessionState,
  drafts
}: {
  /** Owner session for Git IPC and the SCM controller. */
  sessionId: string
  /** Worktree tab/store identity; defaults to the session for task surfaces. */
  scopeKey?: string
  tab: DiffTab
  active: boolean
  refreshToken: number
  sessionState: string
  drafts: WorkbenchDraftStore
}): React.JSX.Element {
  const t = useT()
  useScmControllerVersion()
  const controller = getScmController(sessionId)
  const draft = useWorkbenchDraft(drafts, scopeKey)
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  useEffect(() => subscribeScmSettings(setSettings), [])

  const stored = tab.request.kind === 'working' ? tab.request.entry : null
  const live =
    stored !== null && stored.area !== 'committed'
      ? findScmEntry(sessionId, stored.area, stored.entry.path)
      : null
  // A hunk action can move the path to another area (staged ↔ unstaged). Keep
  // showing the file's remaining change instead of dead-ending on the old area.
  const moved =
    stored !== null && stored.area !== 'committed' && live === null
      ? findScmEntryByPath(sessionId, stored.entry.path, stored.area)
      : null
  const entry = live ?? moved ?? stored
  const stale = stored !== null && live === null && moved === null

  const diff = useWorkingDiff({
    sessionId,
    entry: tab.request.kind === 'working' ? entry : null,
    active,
    refreshToken,
    diffTick: controller?.diffTick ?? 0,
    watchActive: false,
    sessionState
  })

  const updateDiffView = (mode: WorkingDiffMode): void => {
    saveScmSettings({ ...settings, diffView: mode })
  }

  const pin = (): void => {
    openFilesStore.pin(scopeKey, tab.key)
  }

  if (tab.request.kind === 'committed') {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto bg-background">
        <CommittedFileDiff
          sessionId={sessionId}
          baseOid={tab.request.baseOid}
          file={tab.request.file}
        />
      </div>
    )
  }

  if (entry === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[11.5px] text-muted-foreground">
        {t('scm.diff.stale')}
      </div>
    )
  }

  const state: DiffViewState =
    diff.state.phase === 'ready'
      ? diff.state.diff !== undefined
        ? {
            phase: 'ready',
            diff: diff.state.diff,
            ...(diff.state.stale === true ? { stale: true } : {})
          }
        : { phase: 'loading' }
      : diff.state.phase === 'error'
        ? {
            phase: 'error',
            error:
              diff.state.error ??
              makeAppError('GIT_READ_FAILED', translate('diff.readError'))
          }
        : diff.state.phase === 'loading'
          ? { phase: 'loading' }
          : { phase: 'idle' }

  const comments = draft.comments.filter((comment) => comment.path === entry.entry.path)
  const updateComments = (
    updater: (current: LineComment[]) => LineComment[]
  ): void => {
    drafts.update(scopeKey, (current) => ({
      ...current,
      comments: updater(current.comments)
    }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {stale ? (
        <div
          className="flex shrink-0 items-start gap-1.5 border-b border-signal/40 bg-signal-weak px-3 py-1 text-[10.5px] text-signal"
          data-testid="scm-diff-stale"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{t('scm.diff.stale')}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <WorkingDiffView
          sessionId={sessionId}
          entry={entry}
          state={state}
          onRetry={diff.retry}
          comments={comments}
          onAddComment={(comment) => {
            pin()
            updateComments((current) => [
              ...current,
              {
                ...comment,
                id: `${comment.path}:${comment.side}:${String(comment.line)}:${String(current.length)}`
              }
            ])
          }}
          onRemoveComment={(id) => {
            updateComments((current) => current.filter((comment) => comment.id !== id))
          }}
          scopeLabel={t(
            entry.area === 'staged'
              ? 'scm.scope.staged'
              : entry.area === 'untracked'
                ? 'scm.scope.untracked'
                : entry.area === 'conflicts'
                  ? 'scm.scope.conflict'
                  : 'scm.scope.unstaged'
          )}
          mode={settings.diffView}
          onModeChange={updateDiffView}
          onApplyHunk={
            controller === null
              ? undefined
              : (patch, mode) => {
                  pin()
                  return controller.applyHunk(entry.entry.path, patch, mode)
                }
          }
          onResolveConflict={
            controller === null
              ? undefined
              : (text) => {
                  pin()
                  return controller.resolveConflict(entry.entry.path, text)
                }
          }
        />
      </div>
    </div>
  )
}
