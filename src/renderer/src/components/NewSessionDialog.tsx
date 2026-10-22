import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import {
  HARNESS_DEFINITIONS,
  HARNESS_IDS,
  harnessLabel,
  type HarnessDetection,
  type HarnessId
} from '../../../shared/domain/harness'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { CreateSessionRequest } from '../state/use-workspace'

type Props = {
  repos: RepositorySummary[]
  activeRepoId: string | null
  harnesses: HarnessDetection[]
  harnessLoading: boolean
  harnessError: AppError | null
  creating: boolean
  onClose: () => void
  onCreate: (input: CreateSessionRequest) => Promise<boolean>
  onRefreshHarnesses: (force: boolean) => Promise<void>
}

function detectionTone(state: HarnessDetection['state']): string {
  if (state === 'available') return 'text-emerald-400'
  if (state === 'detection_failed') return 'text-amber-400'
  return 'text-muted-foreground'
}

function detectionLabel(state: HarnessDetection['state']): string {
  if (state === 'available') return 'Available'
  if (state === 'detection_failed') return 'Detection failed'
  return 'Unavailable'
}

export default function NewSessionDialog({
  repos,
  activeRepoId,
  harnesses,
  harnessLoading,
  harnessError,
  creating,
  onClose,
  onCreate,
  onRefreshHarnesses
}: Props): React.JSX.Element {
  const available = useMemo(
    () => harnesses.filter((harness) => harness.state === 'available'),
    [harnesses]
  )
  const [repoId, setRepoId] = useState(activeRepoId ?? repos[0]?.id ?? '')
  const [harness, setHarness] = useState<HarnessId | null>(available[0]?.harness ?? null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (harness !== null && available.some((entry) => entry.harness === harness)) return
    setHarness(available[0]?.harness ?? null)
  }, [available, harness])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (creating || harness === null || repoId.length === 0) return
    const ok = await onCreate({
      repoId,
      harness,
      ...(title.trim().length > 0 ? { title: title.trim() } : {})
    })
    if (ok) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="New session"
    >
      <form
        className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-[14px] font-semibold">New session</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              A Harness runs in the selected repository through a real terminal.
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <label className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Repository
          </label>
          <select
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-2 text-[12px] outline-none focus:border-accent"
            value={repoId}
            onChange={(event) => setRepoId(event.target.value)}
            data-testid="new-session-repo"
          >
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.displayName} — {repo.path}
              </option>
            ))}
          </select>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Harness
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              onClick={() => void onRefreshHarnesses(true)}
              disabled={harnessLoading}
              data-testid="harness-redetect"
            >
              <RefreshCw size={11} className={harnessLoading ? 'animate-spin' : ''} />
              Detect again
            </button>
          </div>

          {harnessError ? (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              Detection failed: {harnessError.message}
              <button
                type="button"
                className="ml-1 underline"
                onClick={() => void onRefreshHarnesses(true)}
              >
                Retry
              </button>
            </div>
          ) : null}

          <div className="mt-2 space-y-1.5" data-testid="harness-list">
            {harnessLoading && harnesses.length === 0
              ? HARNESS_IDS.map((id) => (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    Checking {harnessLabel(id)}…
                  </div>
                ))
              : harnesses.map((entry) => {
                  const selectable = entry.state === 'available'
                  const selected = harness === entry.harness
                  return (
                    <div
                      key={entry.harness}
                      className={`rounded-md border px-3 py-2 ${
                        selected && selectable
                          ? 'border-accent/70 bg-accent/10'
                          : 'border-border bg-background'
                      } ${selectable ? '' : 'opacity-70'}`}
                    >
                      <button
                        type="button"
                        className={`flex w-full items-center justify-between gap-2 text-left ${
                          selectable ? 'cursor-pointer' : 'cursor-not-allowed'
                        }`}
                        onClick={() => {
                          if (selectable) setHarness(entry.harness)
                        }}
                        disabled={!selectable}
                        data-testid={`harness-option-${entry.harness}`}
                        data-harness-state={entry.state}
                        data-selected={selected && selectable ? 'true' : 'false'}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                              selected && selectable
                                ? 'border-accent bg-accent text-white'
                                : 'border-border'
                            }`}
                          >
                            {selected && selectable ? <Check size={10} /> : null}
                          </span>
                          <span className="text-[12px] font-medium">
                            {HARNESS_DEFINITIONS[entry.harness].label}
                          </span>
                        </span>
                        <span className={`text-[10px] ${detectionTone(entry.state)}`}>
                          {detectionLabel(entry.state)}
                          {entry.state === 'available' && entry.version
                            ? ` · ${entry.version}`
                            : ''}
                        </span>
                      </button>
                      {entry.state !== 'available' ? (
                        <p className="mt-1 pl-6 text-[10px] text-muted-foreground">
                          {entry.message}
                        </p>
                      ) : null}
                      <details className="mt-1 pl-6">
                        <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                          Diagnostics
                        </summary>
                        <dl className="mt-1 space-y-0.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
                          <div>
                            path: {entry.diagnostics.resolvedPath ?? 'not resolved'}
                          </div>
                          <div>
                            probe: {entry.diagnostics.outcome}
                            {entry.diagnostics.exitCode === null
                              ? ''
                              : ` · exit ${String(entry.diagnostics.exitCode)}`}
                            {` · ${String(entry.diagnostics.durationMs)} ms`}
                          </div>
                          {entry.diagnostics.stderrTail ? (
                            <div className="whitespace-pre-wrap break-all">
                              stderr: {entry.diagnostics.stderrTail}
                            </div>
                          ) : null}
                        </dl>
                      </details>
                    </div>
                  )
                })}
          </div>

          {!harnessLoading && available.length === 0 ? (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                No supported Coding Agent is available. Install one, then use “Detect again”.
                Shell sessions are still available if their probe succeeds.
              </span>
            </div>
          ) : null}

          <label className="mt-4 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Title <span className="normal-case tracking-normal">(optional)</span>
          </label>
          <input
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-2 text-[12px] outline-none focus:border-accent"
            placeholder={
              harness === null
                ? 'Choose a Harness'
                : `${harnessLabel(harness)} · ${repos.find((repo) => repo.id === repoId)?.displayName ?? 'repository'}`
            }
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="session-title-input"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-[10px] text-muted-foreground">
            {available.length} of {harnesses.length || HARNESS_IDS.length} Harnesses available
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              disabled={creating || harness === null || repoId.length === 0}
              data-testid="create-session-submit"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : null}
              Start session
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
