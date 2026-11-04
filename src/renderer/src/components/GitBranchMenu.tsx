import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock,
  Copy,
  FileDiff,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Tag,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type {
  GitBranchesPayload,
  GitBranchPayload,
  GitComparePayload,
  GitCheckoutRefPayload,
  GitFetchPayload,
  GitHistoryPayload,
  GitRemoteMutationPayload,
  GitRemoteBranchesPayload,
  GitRemotesPayload,
  GitRenameBranchPayload,
  GitStatusPayload,
  GitPushTagsPayload,
  GitTagPayload,
  GitTagsPayload
} from '../../../shared/ade-api'
import type { GitRemote, GitTag } from '../../../shared/domain/git-workspace'
import type { GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import type { Notice } from '../state/workspace'
import { workspaceUnavailableText } from '../review/workspace-unavailable'
import GitCompareDialog from './GitCompareDialog'
import GitHistoryDialog from './GitHistoryDialog'

type Props = {
  sessionId: string
  branch: string | null
  notify: (notice: Notice) => void
  onChanged: () => void
  onOpenTerminal: () => void
  onOpenChanges: () => void
}

type Branches = { current: string | null; names: string[] }

/**
 * Branch and remote controls in the workbench header.
 *
 * The menu exposes the operations the Git service can perform safely here:
 * switch/create, compare, fetch/pull/push/publish and history. Merge, rebase,
 * force-push and remote configuration stay in the terminal because they need a
 * decision this menu cannot make on the user's behalf.
 */
export default function GitBranchMenu({
  sessionId,
  branch,
  notify,
  onChanged,
  onOpenTerminal,
  onOpenChanges
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<GitWorkspaceStatus | null>(null)
  const [branches, setBranches] = useState<Branches | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<
    'switch' | 'push' | 'pull' | 'create' | 'fetch' | 'publish' | 'compare' | 'history' | null
  >(null)
  const [creating, setCreating] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [managing, setManaging] = useState(false)
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [deleteTarget, setDeleteTarget] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [rebaseTarget, setRebaseTarget] = useState('')
  const [rebaseConfirm, setRebaseConfirm] = useState(false)
  const [manageBusy, setManageBusy] = useState<
    'rename' | 'delete' | 'merge' | 'rebase' | null
  >(null)
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [tags, setTags] = useState<GitTag[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [upstreamTarget, setUpstreamTarget] = useState('')
  const [tagBusy, setTagBusy] = useState<'checkout' | 'delete' | null>(null)
  const [remoteName, setRemoteName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteBusy, setRemoteBusy] = useState<
    'add' | 'remove' | 'tags' | 'force' | 'sync' | 'upstream' | 'fetch' | null
  >(null)
  const [forceConfirm, setForceConfirm] = useState(false)
  const [history, setHistory] = useState<Extract<GitHistoryPayload, { status: 'ok' }> | null>(null)
  const [compare, setCompare] = useState<Extract<GitComparePayload, { status: 'ok' }> | null>(null)
  const newBranchRef = useRef<HTMLInputElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 })

  useEffect(() => {
    if (creating) newBranchRef.current?.focus()
  }, [creating])

  // The session header clips overflow, so the menu is portalled out of it and
  // positioned from the chip instead of being an absolutely positioned child.
  useLayoutEffect(() => {
    if (!open) return
    const rect = chipRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288 - 8)),
      top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 360))
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (menuRef.current?.contains(event.target) || chipRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [statusResult, branchResult, remotesResult, tagsResult, remoteBranchesResult] =
      await Promise.all([
        callApi<GitStatusPayload>(window.ade.git.status({ sessionId })),
        callApi<GitBranchesPayload>(window.ade.git.branches({ sessionId })),
        callApi<GitRemotesPayload>(window.ade.git.remotes({ sessionId })),
        callApi<GitTagsPayload>(window.ade.git.tags({ sessionId })),
        callApi<GitRemoteBranchesPayload>(window.ade.git.remoteBranches({ sessionId }))
      ])
    setLoading(false)
    if (!statusResult.ok) {
      setNote(statusResult.error.message)
      return
    }
    if (statusResult.value.status === 'unavailable') {
      setSnapshot(null)
      setNote(workspaceUnavailableText(statusResult.value))
    } else {
      setSnapshot(statusResult.value.snapshot)
      setNote('')
    }
    if (!branchResult.ok) {
      notify(errorNotice(branchResult.error))
      return
    }
    if (branchResult.value.status === 'unavailable') {
      notify({ tone: 'error', message: workspaceUnavailableText(branchResult.value) })
      return
    }
    setBranches({ current: branchResult.value.current, names: branchResult.value.names })
    if (remotesResult.ok && remotesResult.value.status === 'ok') {
      setRemotes(remotesResult.value.remotes)
    }
    if (tagsResult.ok && tagsResult.value.status === 'ok') {
      setTags(tagsResult.value.tags)
    }
    if (remoteBranchesResult.ok && remoteBranchesResult.value.status === 'ok') {
      setRemoteBranches(remoteBranchesResult.value.branches)
    }
  }, [notify, sessionId])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) void load()
  }

  const switchTo = async (name: string): Promise<void> => {
    if (busy !== null) return
    setBusy('switch')
    try {
      const result = await callApi<GitBranchPayload>(
        window.ade.git.switchBranch({ sessionId, branch: name })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Switched to ${result.value.branch}` })
      await load()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const remote = async (verb: 'push' | 'pull'): Promise<void> => {
    if (busy !== null) return
    setBusy(verb)
    try {
      const result = await callApi<GitBranchPayload>(
        verb === 'push' ? window.ade.git.push({ sessionId }) : window.ade.git.pull({ sessionId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({
        tone: 'success',
        message: `${verb === 'push' ? 'Pushed' : 'Pulled'} ${result.value.branch} (${result.value.upstream ?? 'upstream'})`
      })
      await load()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const create = async (): Promise<void> => {
    const name = newBranch.trim()
    if (busy !== null || name.length === 0) return
    setBusy('create')
    try {
      const result = await callApi<GitBranchPayload>(
        window.ade.git.createBranch({ sessionId, branch: name })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      setCreating(false)
      setNewBranch('')
      notify({ tone: 'success', message: `Created ${result.value.branch} at HEAD.` })
      await load()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const fetchRemote = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('fetch')
    try {
      const result = await callApi<{ status: 'ok'; remote: string } | { status: 'unavailable'; detail: string }>(
        window.ade.git.fetch({ sessionId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Fetched ${result.value.remote}.` })
      await load()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const publish = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('publish')
    try {
      const result = await callApi<GitBranchPayload>(window.ade.git.publish({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({
        tone: 'success',
        message: `Published ${result.value.branch} → ${result.value.upstream ?? 'upstream'}.`
      })
      await load()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const openHistory = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('history')
    try {
      const result = await callApi<GitHistoryPayload>(window.ade.git.history({ sessionId, limit: 20 }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      setHistory(result.value)
      setOpen(false)
    } finally {
      setBusy(null)
    }
  }

  const openCompare = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('compare')
    try {
      const result = await callApi<GitComparePayload>(window.ade.git.compare({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      setCompare(result.value)
      setOpen(false)
    } finally {
      setBusy(null)
    }
  }

  const copyBranch = async (): Promise<void> => {
    const name = snapshot?.branch ?? branch
    if (!name) return
    try {
      await navigator.clipboard.writeText(name)
      notify({ tone: 'success', message: `Copied ${name}` })
    } catch {
      notify({ tone: 'error', message: 'Clipboard is unavailable.' })
    }
  }

  const runBranchManage = async (
    action: 'rename' | 'delete' | 'merge' | 'rebase'
  ): Promise<void> => {
    if (manageBusy !== null) return
    setManageBusy(action)
    try {
      if (action === 'rename') {
        const result = await callApi<GitRenameBranchPayload>(
          window.ade.git.renameBranch({ sessionId, from: renameFrom, to: renameTo })
        )
        if (!result.ok) {
          notify(errorNotice(result.error))
          return
        }
        if (result.value.status === 'unavailable') {
          notify({ tone: 'error', message: result.value.detail })
          return
        }
        notify({
          tone: 'success',
          message: `Renamed ${result.value.from} to ${result.value.branch}`
        })
        setRenameFrom('')
        setRenameTo('')
      } else if (action === 'delete') {
        const result = await callApi<GitBranchPayload>(
          window.ade.git.deleteBranch({ sessionId, branch: deleteTarget })
        )
        if (!result.ok) {
          notify(errorNotice(result.error))
          return
        }
        if (result.value.status === 'unavailable') {
          notify({ tone: 'error', message: result.value.detail })
          return
        }
        notify({ tone: 'success', message: `Deleted branch ${result.value.branch}` })
        setDeleteTarget('')
      } else if (action === 'merge') {
        const result = await callApi<GitBranchPayload>(
          window.ade.git.mergeBranch({ sessionId, branch: mergeTarget })
        )
        if (!result.ok) {
          notify(errorNotice(result.error))
          return
        }
        if (result.value.status === 'unavailable') {
          notify({ tone: 'error', message: result.value.detail })
          return
        }
        notify({ tone: 'success', message: `Merged ${result.value.branch}` })
        setMergeTarget('')
      } else {
        const result = await callApi<GitBranchPayload>(
          window.ade.git.rebaseBranch({ sessionId, branch: rebaseTarget })
        )
        if (!result.ok) {
          notify(errorNotice(result.error))
          return
        }
        if (result.value.status === 'unavailable') {
          notify({ tone: 'error', message: result.value.detail })
          return
        }
        notify({ tone: 'success', message: `Rebased onto ${result.value.branch}` })
        setRebaseTarget('')
        setRebaseConfirm(false)
      }
      await load()
      onChanged()
    } finally {
      setManageBusy(null)
    }
  }

  const addRemote = async (): Promise<void> => {
    if (remoteBusy !== null) return
    setRemoteBusy('add')
    try {
      const result = await callApi<GitRemoteMutationPayload>(
        window.ade.git.addRemote({ sessionId, name: remoteName, url: remoteUrl })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Added remote ${result.value.name}` })
      setRemoteName('')
      setRemoteUrl('')
      await load()
    } finally {
      setRemoteBusy(null)
    }
  }

  const fetchOneRemote = async (name: string, prune: boolean): Promise<void> => {
    if (remoteBusy !== null) return
    setRemoteBusy('fetch')
    try {
      const result = await callApi<GitFetchPayload>(
        window.ade.git.fetchRemote({
          sessionId,
          remote: name,
          ...(prune ? { prune: true } : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({
        tone: 'success',
        message: `${prune ? 'Pruned' : 'Fetched'} ${result.value.remote}`
      })
      await load()
      onChanged()
    } finally {
      setRemoteBusy(null)
    }
  }

  const removeRemote = async (name: string): Promise<void> => {
    if (remoteBusy !== null) return
    setRemoteBusy('remove')
    try {
      const result = await callApi<GitRemoteMutationPayload>(
        window.ade.git.removeRemote({ sessionId, name })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Removed remote ${result.value.name}` })
      await load()
    } finally {
      setRemoteBusy(null)
    }
  }

  const checkoutTag = async (name: string): Promise<void> => {
    if (tagBusy !== null) return
    setTagBusy('checkout')
    try {
      const result = await callApi<GitCheckoutRefPayload>(
        window.ade.git.checkoutRef({ sessionId, ref: name })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Checked out ${name} (detached)` })
      await load()
      onChanged()
    } finally {
      setTagBusy(null)
    }
  }

  const deleteTag = async (name: string): Promise<void> => {
    if (tagBusy !== null) return
    setTagBusy('delete')
    try {
      const result = await callApi<GitTagPayload>(
        window.ade.git.deleteTag({ sessionId, name })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Deleted tag ${result.value.name}` })
      await load()
    } finally {
      setTagBusy(null)
    }
  }

  const pushTags = async (): Promise<void> => {
    if (remoteBusy !== null) return
    setRemoteBusy('tags')
    try {
      const result = await callApi<GitPushTagsPayload>(window.ade.git.pushTags({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Pushed tags to ${result.value.remote}` })
    } finally {
      setRemoteBusy(null)
    }
  }

  const forcePush = async (): Promise<void> => {
    if (remoteBusy !== null) return
    setRemoteBusy('force')
    try {
      const result = await callApi<GitBranchPayload>(window.ade.git.forcePush({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Force-pushed ${result.value.branch} with a lease` })
      setForceConfirm(false)
      await load()
      onChanged()
    } finally {
      setRemoteBusy(null)
    }
  }

  const setUpstream = async (): Promise<void> => {
    if (remoteBusy !== null || upstreamTarget.length === 0) return
    setRemoteBusy('upstream')
    try {
      const result = await callApi<GitBranchPayload>(
        window.ade.git.setUpstream({ sessionId, upstream: upstreamTarget })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Set upstream to ${result.value.upstream}` })
      setUpstreamTarget('')
      await load()
      onChanged()
    } finally {
      setRemoteBusy(null)
    }
  }

  const sync = async (): Promise<void> => {
    if (remoteBusy !== null) return
    setRemoteBusy('sync')
    try {
      const pulled = await callApi<GitBranchPayload>(window.ade.git.pull({ sessionId }))
      if (!pulled.ok) {
        notify(errorNotice(pulled.error))
        return
      }
      if (pulled.value.status === 'unavailable') {
        notify({ tone: 'error', message: pulled.value.detail })
        return
      }
      const pushed = await callApi<GitBranchPayload>(window.ade.git.push({ sessionId }))
      if (!pushed.ok) {
        notify(errorNotice(pushed.error))
        return
      }
      if (pushed.value.status === 'unavailable') {
        notify({ tone: 'error', message: pushed.value.detail })
        return
      }
      notify({ tone: 'success', message: `Synced ${pushed.value.branch}` })
      await load()
      onChanged()
    } finally {
      setRemoteBusy(null)
    }
  }

  const current = snapshot?.branch ?? branches?.current ?? branch
  const dirty =
    snapshot === null
      ? 0
      : snapshot.staged.length +
        snapshot.unstaged.length +
        snapshot.untracked.length +
        snapshot.conflicted.length
  const canRemote = snapshot?.upstream !== null && snapshot?.upstream !== undefined && busy === null

  return (
    <span className="relative inline-flex">
      <button
        ref={chipRef}
        type="button"
        className="inline-flex h-6 max-w-40 items-center gap-1.5 rounded border border-border bg-muted/40 px-2 font-mono text-[10.5px] text-inherit hover:bg-muted"
        onClick={toggle}
        aria-expanded={open}
        title={current ?? 'detached'}
        data-testid="git-branch-chip"
      >
        <GitBranch size={11} className="shrink-0" />
        <span className="min-w-0 truncate">{current ?? 'detached'}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-[80] max-h-[calc(100vh-96px)] w-72 overflow-y-auto rounded-md border border-border bg-card p-1.5 text-foreground shadow-xl"
              style={{ left: `${String(menuPosition.left)}px`, top: `${String(menuPosition.top)}px` }}
              role="menu"
              aria-label="Branch and remote"
              data-testid="git-branch-menu"
            >
          <div className="flex items-center gap-1.5 px-2 py-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Branch
            </p>
            {loading ? <Loader2 size={10} className="animate-spin text-muted-foreground" /> : null}
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {snapshot?.upstream
                ? `${snapshot.upstream} ↑${String(snapshot.ahead)} ↓${String(snapshot.behind)}`
                : 'no upstream'}
            </span>
          </div>

          {note.length > 0 ? (
            <p className="mx-1 mb-1 rounded border border-signal-line bg-signal-weak px-2 py-1 text-[10px] leading-relaxed text-signal">
              {note}
            </p>
          ) : null}

          <div className="max-h-32 overflow-auto">
            {branches === null ? (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">Reading branches…</p>
            ) : (
              branches.names.map((name) => {
                const isCurrent = name === current
                return (
                  <button
                    key={name}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11px] ${
                      isCurrent
                        ? 'text-muted-foreground'
                        : 'text-foreground hover:bg-muted disabled:opacity-40'
                    }`}
                    disabled={isCurrent || busy !== null || dirty > 0}
                    title={
                      isCurrent
                        ? 'Current branch'
                        : dirty > 0
                          ? 'Commit or discard changes before switching branches'
                          : `Switch to ${name}`
                    }
                    data-testid={`git-branch-option-${name}`}
                    onClick={() => void switchTo(name)}
                  >
                    {isCurrent ? <Check size={10} /> : <GitBranch size={10} />}
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {isCurrent ? <span>current</span> : null}
                  </button>
                )
              })
            )}
          </div>

          {dirty > 0 ? (
            <p className="mx-1 mt-1 rounded bg-signal-weak px-2 py-1 text-[10px] leading-relaxed text-signal">
              {String(dirty)} uncommitted change{dirty === 1 ? '' : 's'}. Commit or discard before switching
              branches.
            </p>
          ) : null}

          <div className="my-1 border-t border-border" />
          <details
            className="px-1 pb-1"
            open={managing}
            onToggle={(event) => setManaging(event.currentTarget.open)}
            data-testid="git-branch-manage"
          >
            <summary className="cursor-pointer px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
              Manage branches…
            </summary>
            <div className="space-y-1.5 pt-1">
              <div className="rounded border border-border bg-background p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Rename</p>
                <select
                  value={renameFrom}
                  onChange={(event) => setRenameFrom(event.target.value)}
                  aria-label="Branch to rename"
                  className="mt-1 h-6 w-full rounded border border-border bg-card px-1 font-mono text-[10px]"
                  data-testid="git-branch-rename-from"
                >
                  <option value="">Choose a branch…</option>
                  {(branches?.names ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <div className="mt-1 flex gap-1">
                  <input
                    value={renameTo}
                    onChange={(event) => setRenameTo(event.target.value)}
                    placeholder="New name"
                    aria-label="New branch name"
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-branch-rename-to"
                  />
                  <button
                    type="button"
                    className="h-6 shrink-0 rounded border border-border px-1.5 text-[10px] hover:bg-muted disabled:opacity-40"
                    disabled={
                      renameFrom.length === 0 ||
                      renameTo.trim().length === 0 ||
                      manageBusy !== null
                    }
                    data-testid="git-branch-rename"
                    onClick={() => void runBranchManage('rename')}
                  >
                    Rename
                  </button>
                </div>
              </div>

              <div className="rounded border border-border bg-background p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  Delete merged branch
                </p>
                <div className="mt-1 flex gap-1">
                  <select
                    value={deleteTarget}
                    onChange={(event) => setDeleteTarget(event.target.value)}
                    aria-label="Branch to delete"
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-branch-delete-target"
                  >
                    <option value="">Choose a branch…</option>
                    {(branches?.names ?? [])
                      .filter((name) => name !== current)
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="h-6 shrink-0 rounded border border-destructive/50 px-1.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                    disabled={deleteTarget.length === 0 || manageBusy !== null}
                    data-testid="git-branch-delete"
                    onClick={() => void runBranchManage('delete')}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="rounded border border-border bg-background p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  Rebase current onto
                </p>
                <div className="mt-1 flex gap-1">
                  <select
                    value={rebaseTarget}
                    onChange={(event) => setRebaseTarget(event.target.value)}
                    aria-label="Branch to rebase onto"
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-branch-rebase-target"
                  >
                    <option value="">Choose a branch…</option>
                    {(branches?.names ?? [])
                      .filter((name) => name !== current)
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="h-6 shrink-0 rounded border border-destructive/50 px-1.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                    disabled={rebaseTarget.length === 0 || manageBusy !== null}
                    data-testid="git-branch-rebase"
                    onClick={() => setRebaseConfirm(true)}
                  >
                    Rebase…
                  </button>
                </div>
                {rebaseConfirm ? (
                  <div className="mt-1 rounded border border-destructive/40 bg-destructive/10 p-1.5 text-[10px] leading-relaxed text-destructive">
                    <p>Rebase {current ?? 'HEAD'} onto {rebaseTarget}? This rewrites local commits.</p>
                    <div className="mt-1 flex gap-1">
                      <button
                        type="button"
                        className="rounded border border-destructive/60 px-1.5 py-0.5 text-[10px] hover:bg-destructive/15 disabled:opacity-40"
                        disabled={manageBusy !== null}
                        data-testid="git-branch-rebase-confirm"
                        onClick={() => void runBranchManage('rebase')}
                      >
                        Rebase
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
                        disabled={manageBusy !== null}
                        onClick={() => setRebaseConfirm(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded border border-border bg-background p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  Merge into current
                </p>
                <div className="mt-1 flex gap-1">
                  <select
                    value={mergeTarget}
                    onChange={(event) => setMergeTarget(event.target.value)}
                    aria-label="Branch to merge"
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-branch-merge-target"
                  >
                    <option value="">Choose a branch…</option>
                    {(branches?.names ?? [])
                      .filter((name) => name !== current)
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="h-6 shrink-0 rounded border border-border px-1.5 text-[10px] hover:bg-muted disabled:opacity-40"
                    disabled={mergeTarget.length === 0 || manageBusy !== null}
                    data-testid="git-branch-merge"
                    onClick={() => void runBranchManage('merge')}
                  >
                    Merge
                  </button>
                </div>
              </div>
            </div>
          </details>

          <div className="my-1 border-t border-border" />
          <details className="px-1 pb-1" data-testid="git-remotes">
            <summary className="cursor-pointer px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
              Remotes… ({remotes.length})
            </summary>
            <div className="space-y-1 pt-1">
              {remotes.length === 0 ? (
                <p className="px-1 py-1 text-[10px] text-muted-foreground">No remotes configured.</p>
              ) : (
                remotes.map((remote) => (
                  <div
                    key={remote.name}
                    className="flex items-center gap-1 rounded border border-border bg-background px-1.5 py-1"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-foreground">
                      {remote.name}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground"
                      title={remote.url}
                    >
                      {remote.url}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                      disabled={remoteBusy !== null}
                      onClick={() => void fetchOneRemote(remote.name, false)}
                      title={`Fetch ${remote.name}`}
                      data-testid={`git-remote-fetch-${remote.name}`}
                    >
                      Fetch
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                      disabled={remoteBusy !== null}
                      onClick={() => void fetchOneRemote(remote.name, true)}
                      title={`Fetch and prune ${remote.name}`}
                      data-testid={`git-remote-prune-${remote.name}`}
                    >
                      Prune
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      disabled={remoteBusy !== null}
                      onClick={() => void removeRemote(remote.name)}
                      aria-label={`Remove remote ${remote.name}`}
                      title={`Remove remote ${remote.name}`}
                      data-testid={`git-remote-remove-${remote.name}`}
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))
              )}

              <div className="rounded border border-border bg-background p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Add remote</p>
                <div className="mt-1 flex gap-1">
                  <input
                    value={remoteName}
                    onChange={(event) => setRemoteName(event.target.value)}
                    placeholder="Name"
                    aria-label="Remote name"
                    className="h-6 w-20 shrink-0 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-remote-add-name"
                  />
                  <input
                    value={remoteUrl}
                    onChange={(event) => setRemoteUrl(event.target.value)}
                    placeholder="URL or path"
                    aria-label="Remote URL"
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-remote-add-url"
                  />
                  <button
                    type="button"
                    className="h-6 shrink-0 rounded border border-border px-1.5 text-[10px] hover:bg-muted disabled:opacity-40"
                    disabled={
                      remoteName.trim().length === 0 ||
                      remoteUrl.trim().length === 0 ||
                      remoteBusy !== null
                    }
                    data-testid="git-remote-add"
                    onClick={() => void addRemote()}
                  >
                    Add
                  </button>
                </div>
              </div>

              <div className="rounded border border-border bg-background p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  Current branch upstream
                </p>
                <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
                  {snapshot?.upstream ?? 'none'}
                </p>
                <div className="mt-1 flex gap-1">
                  <select
                    value={upstreamTarget}
                    onChange={(event) => setUpstreamTarget(event.target.value)}
                    aria-label="Remote branch for the upstream"
                    className="h-6 min-w-0 flex-1 rounded border border-border bg-card px-1 font-mono text-[10px]"
                    data-testid="git-upstream-target"
                  >
                    <option value="">Choose a remote branch…</option>
                    {remoteBranches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="h-6 shrink-0 rounded border border-border px-1.5 text-[10px] hover:bg-muted disabled:opacity-40"
                    disabled={upstreamTarget.length === 0 || remoteBusy !== null}
                    data-testid="git-upstream-set"
                    onClick={() => void setUpstream()}
                  >
                    Set upstream
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] hover:bg-muted disabled:opacity-40"
                  disabled={remoteBusy !== null}
                  data-testid="git-sync"
                  onClick={() => void sync()}
                >
                  Sync
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded border border-destructive/50 px-1.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                  disabled={remoteBusy !== null || !snapshot?.upstream}
                  title="Force-with-lease only; never a bare force push."
                  data-testid="git-force-push"
                  onClick={() => setForceConfirm(true)}
                >
                  Force push…
                </button>
              </div>

              {forceConfirm ? (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-1.5 text-[10px] leading-relaxed text-destructive">
                  <p>
                    Force-push {current ?? 'HEAD'} with a lease? This rewrites the remote branch
                    only if it still matches the last fetched state.
                  </p>
                  <div className="mt-1 flex gap-1">
                    <button
                      type="button"
                      className="rounded border border-destructive/60 px-1.5 py-0.5 text-[10px] hover:bg-destructive/15 disabled:opacity-40"
                      disabled={remoteBusy !== null}
                      data-testid="git-force-push-confirm"
                      onClick={() => void forcePush()}
                    >
                      Force push
                    </button>
                    <button
                      type="button"
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
                      disabled={remoteBusy !== null}
                      onClick={() => setForceConfirm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>

          <div className="my-1 border-t border-border" />
          <details className="px-1 pb-1" data-testid="git-tags">
            <summary className="cursor-pointer px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
              Tags… ({tags.length})
            </summary>
            <div className="space-y-1 pt-1">
              {tags.length === 0 ? (
                <p className="px-1 py-1 text-[10px] text-muted-foreground">No local tags.</p>
              ) : (
                tags.map((tag) => (
                  <div
                    key={tag.name}
                    className="flex items-center gap-1 rounded border border-border bg-background px-1.5 py-1"
                  >
                    <Tag size={9} className="shrink-0 text-signal" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">
                      {tag.name}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                      {tag.oid.slice(0, 7)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border px-1 py-0.5 text-[9px] hover:bg-muted disabled:opacity-40"
                      disabled={tagBusy !== null}
                      onClick={() => void checkoutTag(tag.name)}
                      data-testid={`git-tag-checkout-${tag.name}`}
                    >
                      Checkout
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      disabled={tagBusy !== null}
                      onClick={() => void deleteTag(tag.name)}
                      aria-label={`Delete tag ${tag.name}`}
                      title={`Delete local tag ${tag.name}`}
                      data-testid={`git-tag-delete-${tag.name}`}
                    >
                      <Trash2 size={9} />
                    </button>
                  </div>
                ))
              )}
              <button
                type="button"
                className="inline-flex h-6 items-center rounded border border-border px-1.5 text-[10px] hover:bg-muted disabled:opacity-40"
                disabled={remoteBusy !== null}
                data-testid="git-push-tags"
                onClick={() => void pushTags()}
              >
                Push tags to remote
              </button>
            </div>
          </details>

          <div className="my-1 border-t border-border" />
          {creating ? (
            <form
              className="mx-1 mb-1 rounded border border-border bg-background p-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <label className="sr-only" htmlFor="new-branch-name">
                New branch name
              </label>
              <div className="flex items-center gap-1">
                <input
                  ref={newBranchRef}
                  id="new-branch-name"
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  placeholder="new-branch"
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 font-mono text-[10.5px] text-foreground outline-none placeholder:text-muted-foreground"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="git-new-branch-input"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setCreating(false)
                      setNewBranch('')
                    }
                  }}
                />
                <button
                  type="submit"
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-[10px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                  disabled={busy !== null || newBranch.trim().length === 0}
                  data-testid="git-new-branch-create"
                >
                  {busy === 'create' ? <Loader2 size={9} className="animate-spin" /> : <Plus size={9} />}
                  Create
                </button>
                <button
                  type="button"
                  className="h-7 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setCreating(false)
                    setNewBranch('')
                  }}
                >
                  Cancel
                </button>
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                Created at HEAD. It is not checked out.
              </p>
            </form>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
              disabled={busy !== null}
              onClick={() => setCreating(true)}
              data-testid="git-create-branch"
            >
              <Plus size={10} /> Create branch…
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
            disabled={busy !== null}
            onClick={() => void openCompare()}
            data-testid="git-compare"
          >
            {busy === 'compare' ? <Loader2 size={10} className="animate-spin" /> : <FileDiff size={10} />}
            Compare with baseline
          </button>

          <div className="my-1 border-t border-border" />
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Remote
          </p>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
            disabled={busy !== null}
            onClick={() => void fetchRemote()}
            data-testid="git-fetch"
          >
            {busy === 'fetch' ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            Fetch
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
            disabled={!canRemote}
            title={snapshot?.upstream ? 'Pull the configured upstream (fast-forward only)' : 'Set an upstream before pulling.'}
            data-testid="git-pull"
            onClick={() => void remote('pull')}
          >
            {busy === 'pull' ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
            Pull <span className="ml-auto text-[11px] text-muted-foreground">ff-only</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
            disabled={!canRemote}
            title={snapshot?.upstream ? 'Push the current branch' : 'Set an upstream before pushing.'}
            data-testid="git-push"
            onClick={() => void remote('push')}
          >
            {busy === 'push' ? <Loader2 size={10} className="animate-spin" /> : <ArrowUpRight size={10} />}
            Push
          </button>
          {snapshot?.upstream ? null : (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
              disabled={busy !== null}
              onClick={() => void publish()}
              title="Push this branch and set its upstream"
              data-testid="git-publish"
            >
              {busy === 'publish' ? <Loader2 size={10} className="animate-spin" /> : <ArrowUpRight size={10} />}
              Publish branch <span className="ml-auto text-[11px] text-muted-foreground">set upstream</span>
            </button>
          )}

          <div className="my-1 border-t border-border" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
            disabled={busy !== null}
            onClick={() => void openHistory()}
            data-testid="git-history"
          >
            {busy === 'history' ? <Loader2 size={10} className="animate-spin" /> : <Clock size={10} />}
            Recent commits
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted"
            onClick={() => void copyBranch()}
            data-testid="git-copy-branch"
          >
            <Copy size={10} /> Copy branch name
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted"
            onClick={() => {
              setOpen(false)
              onOpenTerminal()
            }}
            data-testid="git-open-terminal"
          >
            <TerminalSquare size={10} /> Open Git in terminal
          </button>
          <p className="px-2 pt-1 text-[10px] leading-relaxed text-muted-foreground">
            Merge, rebase, force-push and remote configuration stay in the terminal.
          </p>
            </div>,
            document.body
          )
        : null}

      {history !== null ? (
        <GitHistoryDialog data={history} notify={notify} onClose={() => setHistory(null)} />
      ) : null}
      {compare !== null ? (
        <GitCompareDialog
          data={compare}
          onClose={() => setCompare(null)}
          onOpenChanges={() => {
            setOpen(false)
            onOpenChanges()
          }}
        />
      ) : null}
    </span>
  )
}
