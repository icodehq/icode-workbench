import { useEffect, useState } from 'react'
import { FileDiff, Files, ListTodo, Square, TerminalSquare } from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { AppError } from '../../../shared/domain/errors'
import { isAgentHarness } from '../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type { Notice } from '../state/workspace'
import ChangesPanel from './ChangesPanel'
import FilesPanel from './FilesPanel'
import GitBranchMenu from './GitBranchMenu'
import { StatePanel } from './SessionWorkspace'
import TaskOverview from './TaskOverview'
import { sessionStateLabel, stateDotClass } from './status'
import {
  taskPillClass,
  taskStatusLabel
} from './task-status'
import TerminalPane from './TerminalPane'

type Tab = 'overview' | 'terminal' | 'changes' | 'files'

type Props = {
  task: TaskRecordPayload
  previousAttempts: TaskRecordPayload[]
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
 * The project task workbench: a task list on the left (owned by
 * ProjectTasksView) and this full-height pane on the right.
 *
 * Overview, Terminal, Changes and Files are the same task, not a drawer plus a
 * separate session screen. The session tabs reuse the real terminal, review and
 * files services; accepting remains in Overview and never means merge.
 */
export default function TaskWorkbench({
  task,
  previousAttempts,
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
  onChanged
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['overview']))
  const [gitRevision, setGitRevision] = useState(0)
  const [filesRequest, setFilesRequest] = useState<{
    path: string
    line: number
    nonce: number
  } | null>(null)

  useEffect(() => {
    if (session === null) setTab('overview')
  }, [session])

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
      title={disabled ? 'Available once this task has a session' : undefined}
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

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="task-workbench">
      <header className="shrink-0 bg-background">
        <div className="flex flex-wrap items-start gap-3 px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Task · {repo.displayName}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-[18px] font-semibold leading-tight tracking-[-0.015em]">
                {task.title}
              </h1>
              <span
                className={`inline-flex h-[21px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-medium ${taskPillClass(task)}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {taskStatusLabel(task)}
              </span>
              {task.reviewDecision !== 'pending' ? (
                <span className={`text-[10.5px] ${task.reviewDecision === 'accepted' ? 'text-add' : 'text-destructive'}`}>
                  {task.reviewDecision}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground">
              <span>{task.harness}</span>
              <span className="h-2.5 w-px shrink-0 bg-border" />
              <span>attempt {task.attempt}</span>
              {session?.worktree ? (
                <>
                  <span className="h-2.5 w-px shrink-0 bg-border" />
                  <GitBranchMenu
                    sessionId={session.id}
                    branch={session.worktree.branch}
                    notify={notify}
                    onChanged={() => {
                      setGitRevision((current) => current + 1)
                      onRecheckSession(session.id)
                    }}
                    onOpenTerminal={() => selectTab('terminal')}
                  />
                  <span className="font-mono text-[10px]">base {session.worktree.baseOid.slice(0, 7)}</span>
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
              title={session ? 'Open the task terminal' : 'This task has no session yet'}
              data-testid="task-workbench-open-terminal"
            >
              <TerminalSquare size={12} />
              Open terminal
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 px-3 text-[11px] text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => session && onStopSession(session.id)}
              disabled={!live}
              title="Stop this task's session"
              data-testid="task-workbench-stop"
            >
              <Square size={10} />
              Stop
            </button>
          </div>
        </div>

        <div
          className="flex items-end gap-0 overflow-x-auto border-b border-border px-3"
          role="tablist"
          aria-label="Task view"
        >
          {tabButton('overview', 'Overview', <ListTodo size={14} />)}
          {tabButton('terminal', 'Terminal', <TerminalSquare size={14} />, session === null)}
          {tabButton('changes', 'Source Control', <FileDiff size={14} />, session === null)}
          {tabButton('files', 'Files', <Files size={14} />, session === null)}
        </div>
      </header>

      {visited.has('overview') ? (
        <div
          className={`min-h-0 flex-1 ${tab === 'overview' ? 'flex flex-col' : 'hidden'}`}
          data-testid="task-overview-view"
        >
          <TaskOverview
            task={task}
            previousAttempts={previousAttempts}
            notify={notify}
            session={session}
            onOpenTerminal={() => selectTab('terminal')}
            onOpenFullSession={() => {
              if (session) onOpenSession(session.id)
            }}
            onOpenChanges={() => selectTab('changes')}
            onChanged={onChanged}
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
            refreshToken={refreshToken}
            gitRevision={gitRevision}
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
        <EmptyView>This task has no session yet. Dispatch it before opening a terminal.</EmptyView>
      ) : null}
      {tab === 'changes' && session === null ? (
        <EmptyView>
          Source Control appears after this task has a session and the agent starts editing its worktree.
        </EmptyView>
      ) : null}
      {tab === 'files' && session === null ? (
        <EmptyView>This task gets its own worktree when it is dispatched.</EmptyView>
      ) : null}
    </section>
  )
}
