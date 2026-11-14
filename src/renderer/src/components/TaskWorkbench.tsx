import { useEffect, useState } from 'react'
import {
  FileDiff,
  Files,
  GitBranch,
  ListTodo,
  MoreHorizontal,
  Square,
  TerminalSquare
} from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { AppError } from '../../../shared/domain/errors'
import { isAgentHarness } from '../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type { Notice } from '../state/workspace'
import ChangesPanel from './ChangesPanel'
import FilesPanel from './FilesPanel'
import { StatePanel } from './SessionWorkspace'
import type { ScmMergeRequest } from '../scm/scm-merge'
import TaskOverview from './TaskOverview'
import { useT } from '../i18n/use-i18n'
import { sessionStateLabel, stateDotClass } from './status'
import {
  taskPillClass,
  taskStatusLabel
} from './task-status'
import TerminalPane from './TerminalPane'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'

type Tab = 'overview' | 'terminal' | 'changes' | 'files'

export type TaskAction =
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'retry'
  | 'resume'
  | 'archive'
  | 'unarchive'

type Props = {
  task: TaskRecordPayload
  previousAttempts: TaskRecordPayload[]
  /** Every task in the project, for the dependency picker and graph. */
  projectTasks: TaskRecordPayload[]
  onSelectTask: (taskId: string) => void
  onQueueFollowUp: (task: TaskRecordPayload) => void
  repo: RepositorySummary
  session: SessionSummary | null
  notify: (notice: Notice) => void
  refreshToken: number
  /** A file opened from QuickOpen or the command palette. */
  openRequest: { path: string; line: number; nonce: number } | null
  onOpenRequestHandled: () => void
  onOpenSession: (sessionId: string) => void
  onStopSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  onRecheckSession: (sessionId: string) => void
  onError: (error: AppError) => void
  onSendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>
  drafts: WorkbenchDraftStore
  onReload: () => Promise<void>
  onChanged: () => void
  viewRequest?: { tab: 'terminal' | 'changes' | 'files'; nonce: number } | null
  onViewRequestHandled?: () => void
  onTaskAction?: (action: TaskAction) => void
  /** Focus mode drops the task header and shows the terminal. */
  focusActive?: boolean
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`
}

function EmptyView({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

/**
 * The task workbench: the queue lives in the sidebar and this pane fills the
 * main surface.
 *
 * Overview, Terminal, Changes and Files are the same task, not a drawer plus a
 * separate session screen. The session tabs reuse the real terminal, review and
 * files services; accepting remains in Overview and never means merge.
 */
export default function TaskWorkbench({
  task,
  previousAttempts,
  projectTasks,
  onSelectTask,
  onQueueFollowUp,
  repo,
  session,
  notify,
  refreshToken,
  openRequest,
  onOpenRequestHandled,
  onOpenSession,
  onStopSession,
  onRestartSession,
  onRecheckSession,
  onError,
  onSendToAgent,
  drafts,
  onReload,
  onChanged,
  viewRequest = null,
  onViewRequestHandled,
  onTaskAction,
  focusActive = false
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const [mergeRequest, setMergeRequest] = useState<ScmMergeRequest | null>(null)
  const t = useT()
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['overview']))
  const [filesRequest, setFilesRequest] = useState<{
    path: string
    line: number
    nonce: number
  } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null)

  useEffect(() => {
    // Overview does not need a session; the execution tabs do.
    if (session === null && tab !== 'overview') setTab('overview')
  }, [session, tab])

  /**
   * Once a tab has been opened, its pane stays mounted and hidden. That is what
   * keeps the terminal attached and the Changes/Files state alive while the user
   * moves between views; it mirrors SessionWorkspace rather than remounting a
   * fresh panel on every click.
   */
  const selectTab = (value: Tab): void => {
    setTab(value)
    setVisited((current) => {
      if (current.has(value)) return current
      const next = new Set(current)
      next.add(value)
      return next
    })
  }

  useEffect(() => {
    if (!viewRequest) return
    if (session === null) {
      onViewRequestHandled?.()
      return
    }
    selectTab(viewRequest.tab)
    onViewRequestHandled?.()
  }, [viewRequest?.nonce])

  useEffect(() => {
    if (focusActive && session !== null) selectTab('terminal')
  }, [focusActive, session?.id])

  useEffect(() => {
    if (!openRequest) return
    setTab('files')
    setVisited((current) => {
      if (current.has('files')) return current
      const next = new Set(current)
      next.add('files')
      return next
    })
  }, [openRequest?.nonce])

  const live = session !== null && (session.state === 'live' || session.state === 'starting')
  const duration =
    task.startedAt !== null && task.finishedAt !== null
      ? formatDuration(task.finishedAt - task.startedAt)
      : null

  const tabButton = (
    value: Tab,
    label: string,
    icon: React.ReactNode,
    disabled = false
  ): React.JSX.Element => (
    <button
      key={value}
      type="button"
      role="tab"
      aria-selected={tab === value}
      disabled={disabled}
      title={disabled ? t('task.tabUnavailable') : undefined}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[11.5px] disabled:cursor-not-allowed disabled:opacity-40 ${
        tab === value
          ? 'border-accent text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
      onClick={() => selectTab(value)}
      data-testid={`task-tab-${value}`}
    >
      {icon}
      {label}
    </button>
  )

  const menuItems: ContextMenuItem[] = []
  if (onTaskAction !== undefined) {
    if (task.canApprove) {
      menuItems.push({
        id: 'approve',
        label: t('tasks.row.approve'),
        testId: 'task-workbench-action-approve',
        onSelect: () => onTaskAction('approve')
      })
      menuItems.push({
        id: 'reject',
        label: t('tasks.row.reject'),
        testId: 'task-workbench-action-reject',
        onSelect: () => onTaskAction('reject')
      })
    }
    if (task.canResume) {
      menuItems.push({
        id: 'resume',
        label: t('tasks.row.continue'),
        testId: 'task-workbench-action-resume',
        onSelect: () => onTaskAction('resume')
      })
    }
    if (task.canRetry) {
      menuItems.push({
        id: 'retry',
        label: t('tasks.row.retry'),
        testId: 'task-workbench-action-retry',
        onSelect: () => onTaskAction('retry')
      })
    }
    if (
      !task.canApprove &&
      (task.status === 'queued' || task.status === 'running' || task.status === 'dispatching' || task.status === 'waiting')
    ) {
      menuItems.push({
        id: 'cancel',
        label: t('tasks.row.cancel'),
        danger: true,
        separatorBefore: menuItems.length > 0,
        testId: 'task-workbench-action-cancel',
        onSelect: () => onTaskAction('cancel')
      })
    }
    if (task.canArchive) {
      menuItems.push({
        id: 'archive',
        label: t('tasks.row.archive'),
        separatorBefore: menuItems.length > 0,
        testId: 'task-workbench-action-archive',
        onSelect: () => onTaskAction('archive')
      })
    }
    if (task.canUnarchive) {
      menuItems.push({
        id: 'unarchive',
        label: t('tasks.row.restore'),
        separatorBefore: menuItems.length > 0,
        testId: 'task-workbench-action-unarchive',
        onSelect: () => onTaskAction('unarchive')
      })
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="task-workbench">
      {focusActive ? null : (
      <header className="icode-titlebar window-chrome-safe shrink-0 bg-background">
        <div className="flex flex-wrap items-start gap-3 px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {t('task.header', { project: repo.displayName })}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-[18px] font-semibold leading-tight tracking-[-0.015em]">
                {task.title}
              </h1>
              <span
                className={`inline-flex h-[21px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-medium ${taskPillClass(task)}`}
                data-testid="task-workbench-status"
                data-status={task.status}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {taskStatusLabel(task)}
              </span>
              {task.reviewDecision !== 'pending' ? (
                <span className={`text-[10.5px] ${task.reviewDecision === 'accepted' ? 'text-add' : 'text-destructive'}`}>
                  {task.reviewDecision === 'accepted'
                    ? t('tasks.row.accepted')
                    : t('tasks.row.rejected')}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground">
              <span>{task.harness}</span>
              <span className="h-2.5 w-px shrink-0 bg-border" />
              <span>{t('task.attempt', { count: task.attempt })}</span>
              {session?.worktree ? (
                <>
                  <span className="h-2.5 w-px shrink-0 bg-border" />
                  <span
                    className="inline-flex min-w-0 max-w-[180px] items-center gap-1 font-mono text-[10px] text-muted-foreground"
                    title={session.worktree.branch}
                  >
                    <GitBranch size={11} className="shrink-0" />
                    <span className="truncate">{session.worktree.branch}</span>
                  </span>
                  <span className="font-mono text-[10px]">
                    {t('task.base', { hash: session.worktree.baseOid.slice(0, 7) })}
                  </span>
                </>
              ) : null}
              {duration ? (
                <>
                  <span className="h-2.5 w-px shrink-0 bg-border" />
                  <span>{duration}</span>
                </>
              ) : null}
              {session ? (
                <>
                  <span className="h-2.5 w-px shrink-0 bg-border" />
                  <span className="inline-flex items-center gap-1">
                    <span className={`h-1.5 w-1.5 rounded-full ${stateDotClass(session.state, null)}`} />
                    {sessionStateLabel(session.state, null)}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => selectTab('terminal')}
              disabled={session === null}
              title={
                session ? t('task.openTerminalTitle') : t('task.noSessionTitle')
              }
              data-testid="task-workbench-open-terminal"
            >
              <TerminalSquare size={12} />
              {t('task.openTerminal')}
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 px-3 text-[11px] text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => session && onStopSession(session.id)}
              disabled={!live}
              title={t('task.stopTitle')}
              data-testid="task-workbench-stop"
            >
              <Square size={10} />
              {t('task.stop')}
            </button>
            {menuItems.length > 0 ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setMenuAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
                  setMenuOpen(true)
                }}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('task.actions')}
                title={t('task.actions')}
                data-testid="task-workbench-actions"
              >
                <MoreHorizontal size={13} />
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="flex items-end gap-0 overflow-x-auto border-b border-border px-3"
          role="tablist"
          aria-label={t('task.view')}
        >
          {tabButton('overview', t('task.tab.overview'), <ListTodo size={14} />)}
          {tabButton('terminal', t('task.tab.terminal'), <TerminalSquare size={14} />, session === null)}
          {tabButton('changes', t('task.tab.sourceControl'), <FileDiff size={14} />, session === null)}
          {tabButton('files', t('task.tab.files'), <Files size={14} />, session === null)}
        </div>
      </header>
      )}

      {visited.has('overview') ? (
        <div
          className={`min-h-0 flex-1 ${tab === 'overview' ? 'flex flex-col' : 'hidden'}`}
          data-testid="task-overview-view"
        >
          <TaskOverview
            task={task}
            previousAttempts={previousAttempts}
            projectTasks={projectTasks}
            notify={notify}
            session={session}
            onOpenTerminal={() => selectTab('terminal')}
            onOpenFullSession={() => {
              if (session) onOpenSession(session.id)
            }}
            onOpenChanges={() => selectTab('changes')}
            onSelectTask={onSelectTask}
            onQueueFollowUp={onQueueFollowUp}
            onChanged={onChanged}
            onMerge={
              session === null
                ? undefined
                : () => {
                    selectTab('changes')
                    setMergeRequest({
                      target: task.chainBranch ?? null,
                      lockTarget: (task.dependents?.length ?? 0) > 0,
                      nonce: Date.now()
                    })
                  }
            }
          />
        </div>
      ) : null}

      {visited.has('terminal') && session !== null ? (
        <div
          className={`relative min-h-0 flex-1 bg-background ${tab === 'terminal' ? '' : 'hidden'}`}
          data-testid="task-terminal-view"
        >
          {live ? (
            <TerminalPane
              key={`${session.id}:${session.incarnationId ?? 'pending'}`}
              session={session}
              active={tab === 'terminal'}
              onError={onError}
            />
          ) : (
            <StatePanel
              session={session}
              onRestart={() => onRestartSession(session.id)}
              onRecheck={() => onRecheckSession(session.id)}
            />
          )}
        </div>
      ) : null}

      {visited.has('changes') && session !== null ? (
        <div
          className={`min-h-0 flex-1 ${tab === 'changes' ? '' : 'hidden'}`}
          data-testid="task-changes-view"
        >
          <ChangesPanel
            sessionId={session.id}
            sessionState={session.state}
            repoId={task.repoId}
            harness={session.harness}
            baseOid={session.worktree?.baseOid ?? null}
            refreshToken={refreshToken}
            active={tab === 'changes'}
            notify={notify}
            onOpenPath={(path) => {
              setFilesRequest({ path, line: 1, nonce: Date.now() })
              selectTab('files')
            }}
            onOpenTerminal={() => selectTab('terminal')}
            onSendToAgent={(text) => onSendToAgent(text, session)}
            canSendToAgent={session.state === 'live' && isAgentHarness(session.harness)}
            drafts={drafts}
            mergeTargetHint={task.chainBranch ?? null}
            lockMergeTarget={(task.dependents?.length ?? 0) > 0}
            mergeRequest={mergeRequest}
            onMergeRequestHandled={() => setMergeRequest(null)}
            onChanged={() => {
              onRecheckSession(session.id)
              void onReload()
            }}
          />
        </div>
      ) : null}

      {visited.has('files') && session !== null ? (
        <div
          className={`flex min-h-0 flex-1 ${tab === 'files' ? '' : 'hidden'}`}
          data-testid="task-files-view"
        >
          <FilesPanel
            sessionId={session.id}
            refreshToken={refreshToken}
            active={tab === 'files'}
            notify={notify}
            openRequest={openRequest ?? filesRequest}
            onOpenRequestHandled={() => {
              onOpenRequestHandled()
              setFilesRequest(null)
            }}
            editorEngine="monaco"
          />
        </div>
      ) : null}

      {tab === 'terminal' && session === null ? (
        <EmptyView>{t('task.empty.terminal')}</EmptyView>
      ) : null}
      {tab === 'changes' && session === null ? (
        <EmptyView>{t('task.empty.changes')}</EmptyView>
      ) : null}
      {tab === 'files' && session === null ? (
        <EmptyView>{t('task.empty.files')}</EmptyView>
      ) : null}

      {menuOpen && menuAnchor !== null ? (
        <ContextMenu
          items={menuItems}
          ariaLabel={t('task.actions')}
          testId="task-workbench-menu"
          width={220}
          anchor={menuAnchor}
          align="end"
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

    </section>
  )
}
