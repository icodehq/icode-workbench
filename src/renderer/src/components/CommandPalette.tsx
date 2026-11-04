import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  CloudDownload,
  CloudUpload,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  History,
  LayoutGrid,
  ListTodo,
  Minus,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Sun,
  TerminalSquare,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/ade-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import { fuzzyScore } from '../files/fuzzy'
import { getWorktreeFileIndex } from '../files/file-index'
import type { Notice } from '../state/workspace'
import {
  filterAndSortProjects,
  projectStats
} from './projects-wall-model'
import { sessionStateLabel } from './status'
import { taskAttention, taskStatusLabel } from './task-status'
import {
  runScmCommand,
  useScmCommandSnapshot,
  type ScmCommandId
} from '../scm/scm-commands'

type PaletteKind = 'action' | 'project' | 'work' | 'file'

type PaletteItem = {
  id: string
  kind: PaletteKind
  label: string
  hint: string
  icon: LucideIcon
  disabled?: boolean
  run: () => void
}

type FileSession = { id: string; title: string }

type Props = {
  open: boolean
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  /** The active session whose worktree the Files group searches, if any. */
  fileSession: FileSession | null
  canStartSession: boolean
  resolvedTheme: 'dark' | 'light'
  notify: (notice: Notice) => void
  onClose: () => void
  onNewSession: () => void
  onQueueTask: () => void
  onProjects: () => void
  onSchedules: () => void
  onRepositories: () => void
  onSettings: () => void
  /** Focuses the active session's Source Control tab. */
  onSourceControl: () => void
  onToggleTheme: () => void
  onOpenProject: (repoId: string) => void
  onOpenSession: (sessionId: string) => void
  onOpenTask: (task: TaskRecordPayload) => void
  onOpenFile: (path: string, line: number) => void
}

const kindTitle: Record<PaletteKind, string> = {
  action: 'Actions',
  project: 'Projects',
  work: 'Sessions & Tasks',
  file: 'Files'
}

function repoName(repos: RepositorySummary[], id: string): string {
  return repos.find((repo) => repo.id === id)?.displayName ?? 'unknown project'
}

function workHint(task: TaskRecordPayload, repos: RepositorySummary[]): string {
  const attention = taskAttention(task)
  return `${repoName(repos, task.repoId)} · ${attention ?? taskStatusLabel(task)}`
}

function workMatches(
  label: string,
  hint: string,
  query: string
): boolean {
  if (query.length === 0) return true
  return label.toLowerCase().includes(query) || hint.toLowerCase().includes(query)
}

/**
 * The global Ctrl/Cmd+K palette.
 *
 * It is deliberately a renderer-only surface: work and actions are already in
 * the shell's state, and files reuse the same bounded worktree index QuickOpen
 * uses. Opening work from here uses the same routes as clicking a project row,
 * so the project header and mode stay truthful.
 */
export default function CommandPalette({
  open,
  repos,
  sessions,
  tasks,
  fileSession,
  canStartSession,
  resolvedTheme,
  notify,
  onClose,
  onNewSession,
  onQueueTask,
  onProjects,
  onSchedules,
  onRepositories,
  onSettings,
  onSourceControl,
  onToggleTheme,
  onOpenProject,
  onOpenSession,
  onOpenTask,
  onOpenFile
}: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [filesIndexed, setFilesIndexed] = useState(false)
  const [fileNote, setFileNote] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    setFiles([])
    setFilesIndexed(false)
    setFileNote('')
    if (!open || fileSession === null) return
    let cancelled = false
    void getWorktreeFileIndex(fileSession.id, notify).then((result) => {
      if (cancelled) return
      setFiles(result.files)
      setFilesIndexed(true)
      setFileNote(result.note ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [fileSession?.id, notify, open])

  const normalizedQuery = query.trim().toLowerCase()
  const scmCommands = useScmCommandSnapshot()

  const actions = useMemo<PaletteItem[]>(() => {
    const scmSessionId = fileSession?.id ?? null
    const scmAction = (
      id: ScmCommandId,
      label: string,
      hint: string,
      icon: LucideIcon
    ): PaletteItem => {
      const entry = scmSessionId === null ? undefined : scmCommands[id]
      const available = entry !== undefined && entry.sessionId === scmSessionId
      const disabled = !available || !entry.enabled
      return {
        id,
        kind: 'action',
        label,
        hint:
          scmSessionId === null
            ? 'open a session first'
            : !available
              ? 'Source Control is not ready'
              : !entry.enabled
                ? entry.disabledReason ?? 'unavailable'
                : hint,
        icon,
        disabled,
        run: () => {
          if (runScmCommand(id, scmSessionId ?? undefined)) onSourceControl()
        }
      }
    }
    const list: PaletteItem[] = [
      {
        id: 'new-session',
        kind: 'action',
        label: 'New session',
        hint: !canStartSession
          ? 'Host unreachable'
          : repos.length === 0
            ? 'add a repository first'
            : 'direct',
        icon: TerminalSquare,
        disabled: !canStartSession,
        run: onNewSession
      },
      {
        id: 'queue-task',
        kind: 'action',
        label: 'Queue task',
        hint: 'unattended',
        icon: ListTodo,
        run: onQueueTask
      },
      {
        id: 'projects',
        kind: 'action',
        label: 'Go to Projects',
        hint: 'all projects',
        icon: LayoutGrid,
        run: onProjects
      },
      {
        id: 'source-control',
        kind: 'action',
        label: 'Go to Source Control',
        hint:
          fileSession === null
            ? 'open a session first'
            : `staging and commits · ${fileSession.title}`,
        icon: GitBranch,
        disabled: fileSession === null,
        run: onSourceControl
      },
      scmAction('git.commit', 'Commit', 'commit the staged changes', GitCommitHorizontal),
      scmAction('git.commitAll', 'Commit All', 'stage and commit every change', GitCommitHorizontal),
      scmAction('git.refresh', 'Refresh Source Control', 're-read Git status', RefreshCw),
      scmAction('git.stageAll', 'Stage All Changes', 'stage every unstaged file', Plus),
      scmAction('git.unstageAll', 'Unstage All Changes', 'unstage every staged file', Minus),
      scmAction('git.discardAll', 'Discard All Changes', 'revert every uncommitted change', Trash2),
      scmAction('git.fetch', 'Git: Fetch', 'fetch from the upstream remote', CloudDownload),
      scmAction('git.pull', 'Git: Pull', 'pull from the upstream remote', ArrowDownToLine),
      scmAction('git.push', 'Git: Push', 'push to the upstream remote', ArrowUpFromLine),
      scmAction('git.sync', 'Git: Sync', 'pull then push', RefreshCw),
      scmAction('git.publish', 'Git: Publish Branch', 'push a branch without an upstream', CloudUpload),
      scmAction('git.viewHistory', 'Git: View History', 'browse the commit graph', History),
      scmAction('git.continueOperation', 'Git: Continue Operation', 'continue a merge or rebase', Play),
      scmAction('git.abortOperation', 'Git: Abort Operation', 'abort a merge or rebase', Square),
      {
        id: 'schedules',
        kind: 'action',
        label: 'Go to Schedules',
        hint: 'recurring tasks',
        icon: CalendarClock,
        run: onSchedules
      },
      {
        id: 'repositories',
        kind: 'action',
        label: 'Go to Repositories',
        hint: 'registration and targets',
        icon: FolderGit2,
        run: onRepositories
      },
      {
        id: 'settings',
        kind: 'action',
        label: 'Go to Settings',
        hint: 'appearance, slots, Harnesses',
        icon: Settings,
        run: onSettings
      },
      {
        id: 'toggle-theme',
        kind: 'action',
        label: 'Toggle appearance',
        hint: resolvedTheme === 'dark' ? 'switch to light' : 'switch to dark',
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        run: onToggleTheme
      }
    ]
    return list.filter((item) => workMatches(item.label, item.hint, normalizedQuery))
  }, [
    normalizedQuery,
    canStartSession,
    fileSession,
    onNewSession,
    onProjects,
    onQueueTask,
    onRepositories,
    onSchedules,
    onSettings,
    onSourceControl,
    onToggleTheme,
    repos.length,
    resolvedTheme,
    scmCommands
  ])

  const projects = useMemo<PaletteItem[]>(() => {
    const stats = repos.map((repo) => projectStats(repo, sessions, tasks))
    return filterAndSortProjects(stats, [], 'all', normalizedQuery)
      .slice(0, 8)
      .map((project) => ({
        id: `project:${project.repo.id}`,
        kind: 'project',
        label: project.repo.displayName,
        hint: `${project.repo.target.kind === 'wsl' ? 'WSL' : 'Local'} · ${
          project.repo.currentBranch ?? 'no branch'
        }`,
        icon: FolderGit2,
        run: () => onOpenProject(project.repo.id)
      }))
  }, [normalizedQuery, onOpenProject, repos, sessions, tasks])

  const work = useMemo<PaletteItem[]>(() => {
    const taskSessionIds = new Set(
      tasks.map((task) => task.sessionId).filter((id): id is string => id !== null)
    )
    const sessionItems = sessions
      .filter((session) => !taskSessionIds.has(session.id))
      .filter((session) =>
        workMatches(
          session.title,
          repoName(repos, session.repoId),
          normalizedQuery
        )
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 12)
      .map<PaletteItem>((session) => ({
        id: `session:${session.id}`,
        kind: 'work',
        label: session.title,
        hint: `${repoName(repos, session.repoId)} · ${sessionStateLabel(session.state, null)}`,
        icon: TerminalSquare,
        run: () => onOpenSession(session.id)
      }))
    const taskItems = tasks
      .filter((task) => workMatches(task.title, workHint(task, repos), normalizedQuery))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 12)
      .map<PaletteItem>((task) => ({
        id: `task:${task.id}`,
        kind: 'work',
        label: task.title,
        hint: workHint(task, repos),
        icon: task.sessionLive ? TerminalSquare : ListTodo,
        run: () => onOpenTask(task)
      }))
    return [...sessionItems, ...taskItems].slice(0, 14)
  }, [normalizedQuery, onOpenSession, onOpenTask, repos, sessions, tasks])

  const fileItems = useMemo<PaletteItem[]>(() => {
    if (fileSession === null) return []
    if (!filesIndexed) return []
    const wanted = normalizedQuery
    const scored: Array<{ path: string; score: number }> = []
    for (const path of files) {
      const score = fuzzyScore(path, wanted)
      if (score !== null) scored.push({ path, score })
    }
    scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    return scored.slice(0, wanted.length === 0 ? 5 : 10).map<PaletteItem>(({ path }) => ({
      id: `file:${path}`,
      kind: 'file',
      label: path,
      hint: `Open in ${fileSession.title} · Files`,
      icon: FileText,
      run: () => onOpenFile(path, 1)
    }))
  }, [fileSession, files, filesIndexed, normalizedQuery, onOpenFile])

  const groups = [
    { kind: 'action' as const, items: actions },
    { kind: 'project' as const, items: projects },
    { kind: 'work' as const, items: work },
    { kind: 'file' as const, items: fileItems }
  ]
  const flat = groups.flatMap((group) => group.items)
  const indexById = new Map(flat.map((item, index) => [item.id, index]))
  const activeItem = flat[active] ?? null

  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1))
  }, [active, flat.length])

  if (!open) return null

  const choose = (item: PaletteItem): void => {
    if (item.disabled === true) return
    onClose()
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, Math.max(flat.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter' && activeItem !== null) {
      event.preventDefault()
      choose(activeItem)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 px-4 pt-[9vh] pb-8 backdrop-blur-[1px]"
      data-testid="command-palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="ade-command-palette w-[min(680px,100%)] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--ade-shadow-overlay)]"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search projects, work, files and commands"
            className="h-[46px] min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="Search projects, work, files and commands"
            data-testid="command-palette-input"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden shrink-0 rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground sm:block">
            Ctrl K
          </kbd>
        </div>

        <div className="max-h-[calc(72vh-50px)] overflow-y-auto p-1.5" data-testid="command-palette-results">
          {flat.length === 0 && normalizedQuery.length > 0 ? (
            <p className="px-3 py-5 text-[11.5px] text-muted-foreground">
              No match. Try a project, session, task, file path or command.
            </p>
          ) : null}
          {groups.map((group) => {
            const showIndexing =
              group.kind === 'file' &&
              fileSession !== null &&
              !filesIndexed &&
              normalizedQuery.length > 0
            const showEmpty =
              group.kind === 'file' &&
              fileSession !== null &&
              filesIndexed &&
              group.items.length === 0 &&
              normalizedQuery.length > 0
            if (group.items.length === 0 && !showIndexing && !showEmpty) return null
            return (
              <section key={group.kind} className="mb-1.5 last:mb-0" data-testid={`command-group-${group.kind}`}>
                <h2 className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  {kindTitle[group.kind]}
                </h2>
                {showIndexing ? (
                  <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Indexing worktree…</p>
                ) : null}
                {showEmpty ? (
                  <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No matching files.</p>
                ) : null}
                {group.items.map((item) => {
                  const index = indexById.get(item.id) ?? 0
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
                        index === active
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                      }`}
                      disabled={item.disabled === true}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(item)}
                      data-testid="command-palette-item"
                      data-kind={item.kind}
                      data-id={item.id}
                    >
                      <Icon size={14} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px]">{item.label}</span>
                      <span className="max-w-[45%] shrink-0 truncate text-[9.5px] text-muted-foreground">
                        {item.hint}
                      </span>
                    </button>
                  )
                })}
              </section>
            )
          })}
          {fileSession !== null && fileNote.length > 0 ? (
            <p className="px-2 py-1 text-[10px] text-signal">{fileNote}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>·</span>
          <span>Enter open</span>
          <span>·</span>
          <span>Esc close</span>
          {fileSession === null ? (
            <span className="ml-auto truncate">Files need an active session</span>
          ) : (
            <span className="ml-auto max-w-[45%] truncate">Files · {fileSession.title}</span>
          )}
        </div>
      </div>
    </div>
  )
}
