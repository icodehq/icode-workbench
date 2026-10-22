import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FolderGit2, Loader2, Plus, RefreshCw } from 'lucide-react'
import AddRepositoryDialog from './components/AddRepositoryDialog'
import NewSessionDialog from './components/NewSessionDialog'
import NoticeToast from './components/NoticeToast'
import RemovalDialog from './components/RemovalDialog'
import WorktreeCleanupDialog from './components/WorktreeCleanupDialog'
import BranchCleanupDialog from './components/BranchCleanupDialog'
import SessionWorkspace from './components/SessionWorkspace'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import { useWorkspace } from './state/use-workspace'
import { activeRepo, activeSession, pendingAction } from './state/workspace'

function paneKey(sessionId: string, incarnationId: string | null): string {
  return `${sessionId}:${incarnationId ?? 'pending'}`
}

export default function App(): React.JSX.Element {
  const workspace = useWorkspace()
  const { state } = workspace
  const [addOpen, setAddOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [removalBusy, setRemovalBusy] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [mounted, setMounted] = useState<Set<string>>(new Set())

  const repo = activeRepo(state)
  const session = activeSession(state)

  // A session keeps its terminal mounted after it exits so the final output is
  // still readable. A new incarnation replaces the old pane instead of sharing it.
  useEffect(() => {
    setMounted((previous) => {
      const next = new Set<string>()
      const byId = new Map(state.sessions.map((entry) => [entry.id, entry]))
      for (const key of previous) {
        const separator = key.lastIndexOf(':')
        const id = key.slice(0, separator)
        const incarnation = key.slice(separator + 1)
        const current = byId.get(id)
        if (!current) continue
        if (
          current.incarnationId !== null &&
          current.incarnationId !== incarnation &&
          (current.state === 'live' || current.state === 'starting')
        ) {
          continue
        }
        next.add(key)
      }
      for (const entry of state.sessions) {
        if (entry.state === 'live' || entry.state === 'starting') {
          next.add(paneKey(entry.id, entry.incarnationId))
        }
      }
      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous
      }
      return next
    })
  }, [state.sessions])

  const paneSessions = useMemo(
    () =>
      state.sessions.filter((entry) => mounted.has(paneKey(entry.id, entry.incarnationId))),
    [mounted, state.sessions]
  )

  const openNewSession = (): void => {
    if (state.repos.length === 0) {
      setAddOpen(true)
      return
    }
    setNewSessionOpen(true)
  }

  const confirmRemoval = async (): Promise<void> => {
    const prompt = state.removal
    if (!prompt) return
    setRemovalBusy(true)
    await workspace.confirmRemoval()
    setRemovalBusy(false)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        state={state}
        runtime={workspace.runtime}
        onSelectRepo={workspace.selectRepo}
        onAddRepository={() => setAddOpen(true)}
        onRemoveRepository={() => {
          if (state.activeRepoId !== null) void workspace.removeRepository(state.activeRepoId)
        }}
        onRefresh={() => void workspace.refreshAll()}
        onNewSession={openNewSession}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          repos={state.repos}
          sessions={state.sessions}
          orphans={state.orphans}
          activeRepoId={state.activeRepoId}
          activeSessionId={state.activeSessionId}
          pending={state.pending}
          canCreate={state.repos.length > 0}
          branches={state.branches}
          onSelectSession={workspace.selectSession}
          onNewSession={openNewSession}
          onRemoveBranch={(branch) => void workspace.requestRemoveBranch(branch)}
        />

        <main className="relative flex min-w-0 flex-1">
          {state.boot === 'loading' ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                Loading repositories and sessions…
              </div>
            </div>
          ) : state.boot === 'failed' ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-5">
                <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
                  <AlertTriangle size={14} />
                  ADE could not load the workspace
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {state.bootError}
                </p>
                <button
                  type="button"
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
                  onClick={() => void workspace.refreshAll()}
                  data-testid="boot-retry"
                >
                  <RefreshCw size={12} />
                  Retry
                </button>
              </div>
            </div>
          ) : state.repos.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
                <div className="flex items-center gap-2">
                  <FolderGit2 size={15} className="text-muted-foreground" />
                  <h1 className="text-[14px] font-semibold">Add your first repository</h1>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  ADE runs Coding Agent terminals inside a local Git working tree. Register a
                  repository to detect Harnesses and start a session.
                </p>
                <button
                  type="button"
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90"
                  onClick={() => setAddOpen(true)}
                  data-testid="empty-add-repo"
                >
                  <Plus size={12} />
                  Register a repository
                </button>
              </div>
            </div>
          ) : session === null ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
                <h1 className="text-[14px] font-semibold">No sessions in {repo?.displayName}</h1>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {state.sessions.length === 0
                    ? 'Detected Harnesses are listed before a session is created. A real terminal opens inside this repository.'
                    : 'Choose a session from the sidebar, or start another one from this repository.'}
                </p>
                <button
                  type="button"
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90"
                  onClick={openNewSession}
                  data-testid="empty-new-session"
                >
                  <Plus size={12} />
                  New session
                </button>
              </div>
            </div>
          ) : (
            <SessionWorkspace
              session={session}
              repo={repo}
              pending={pendingAction(state, session.id)}
              panes={paneSessions}
              onStop={(sessionId) => void workspace.stopSession(sessionId)}
              onRestart={(sessionId) => void workspace.restartSession(sessionId)}
              onRecheck={(sessionId) => void workspace.recheckSession(sessionId)}
              onRemove={(sessionId) => void workspace.requestRemoveSession(sessionId)}
              onRecoverWorktree={(sessionId) => void workspace.recoverWorktree(sessionId)}
              onError={workspace.reportError}
            />
          )}
        </main>
      </div>

      <NoticeToast notice={state.notice} onDismiss={workspace.dismissNotice} />

      {addOpen ? (
        <AddRepositoryDialog
          onClose={() => setAddOpen(false)}
          onSubmit={workspace.addRepository}
        />
      ) : null}

      {newSessionOpen ? (
        <NewSessionDialog
          repos={state.repos}
          activeRepoId={state.activeRepoId}
          harnesses={state.harnesses}
          harnessLoading={state.harnessLoading}
          harnessError={state.harnessError}
          creating={workspace.creating}
          onClose={() => setNewSessionOpen(false)}
          onCreate={workspace.createSession}
          onRefreshHarnesses={workspace.refreshHarnesses}
        />
      ) : null}

      {state.removal ? (
        <RemovalDialog
          prompt={state.removal}
          busy={removalBusy}
          onCancel={workspace.dismissRemoval}
          onConfirm={() => void confirmRemoval()}
        />
      ) : null}

      {state.sessionCleanup ? (
        <WorktreeCleanupDialog
          prompt={state.sessionCleanup}
          busy={cleanupBusy}
          onClose={workspace.dismissSessionCleanup}
          onRecover={() => void workspace.recoverWorktree(state.sessionCleanup!.sessionId)}
          onDiscard={async (confirmBranch) => {
            setCleanupBusy(true)
            const removed = await workspace.discardSession(
              state.sessionCleanup!.sessionId,
              confirmBranch
            )
            setCleanupBusy(false)
            return removed
          }}
        />
      ) : null}

      {state.branchCleanup ? (
        <BranchCleanupDialog
          prompt={state.branchCleanup}
          busy={cleanupBusy}
          onClose={workspace.dismissBranchCleanup}
          onConfirm={async (confirmBranch) => {
            setCleanupBusy(true)
            await workspace.requestRemoveBranch(state.branchCleanup!.branch, confirmBranch)
            setCleanupBusy(false)
          }}
        />
      ) : null}
    </div>
  )
}
