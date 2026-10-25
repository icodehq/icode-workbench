import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, Check, HardDrive, Loader2, RefreshCw, Server, X } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import type { WslDistroListPayload, WslDistroSummary } from '../../../shared/schemas/ipc'
import { callApi, isAbsolutePathLike } from '../lib/api'

type Dirs = { kind: 'local' } | { kind: 'wsl'; distro: WslDistroSummary | null }

type Props = {
  onClose: () => void
  /** Resolves `null` on success, or the failure to show inside the dialog. */
  onSubmit: (input: { path: string; target: ExecutionTarget }) => Promise<AppError | null>
}

type DistroState =
  /** Nothing asked yet: the dialog has never shown the WSL tab. */
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; payload: Extract<WslDistroListPayload, { status: 'ok' }> }
  | { phase: 'unavailable'; payload: Extract<WslDistroListPayload, { status: 'unavailable' }> }
  | { phase: 'ipc_failed'; error: AppError }

function reasonText(reason: 'not_windows' | 'registry_unreadable' | 'undecodable_names'): string {
  if (reason === 'not_windows') return 'WSL is only available on Windows.'
  if (reason === 'undecodable_names') {
    return 'The distro list could not be decoded, so no distro can be offered safely.'
  }
  return 'The WSL registration list could not be read.'
}

export default function AddRepositoryDialog({ onClose, onSubmit }: Props): React.JSX.Element {
  const [choice, setChoice] = useState<Dirs>({ kind: 'local' })
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [distros, setDistros] = useState<DistroState>({ phase: 'idle' })
  /**
   * Discovery is asked once per dialog, and only when WSL is chosen.
   *
   * Counting submissions here (not in render state) is what makes a double click
   * a single request: React state updates are asynchronous, so a `busy` flag read
   * from the closure can still be false on the second click.
   */
  const inFlight = useRef(false)
  /**
   * One discovery per dialog unless the user asks again.
   *
   * Loading must be started by an *event*, not by an effect that watches the
   * phase: an effect keyed on `phase === 'loading'` re-runs on the state update
   * that sets that same phase, which is an unbounded IPC loop.
   */
  const requested = useRef(false)

  const loadDistros = useCallback(async (): Promise<void> => {
    requested.current = true
    setDistros({ phase: 'loading' })
    const result = await callApi(window.ade.wsl.listDistros())
    if (!result.ok) {
      setDistros({ phase: 'ipc_failed', error: result.error })
      return
    }
    if (result.value.status === 'unavailable') {
      setDistros({ phase: 'unavailable', payload: result.value })
      return
    }
    const payload = result.value
    setDistros({ phase: 'ready', payload })
    // Pre-select the distro Windows itself defaults to, so the common case is one
    // click. Falling back to the first entry only when no default is recorded.
    const preferred =
      payload.distros.find((entry) => entry.registrationId === payload.defaultRegistrationId) ??
      payload.distros[0] ??
      null
    setChoice((current) =>
      current.kind === 'wsl' && current.distro === null && preferred !== null
        ? { kind: 'wsl', distro: preferred }
        : current
    )
  }, [])

  const selectLocal = (): void => {
    if (busy) return
    setError(null)
    setChoice({ kind: 'local' })
  }

  const selectWsl = (): void => {
    if (busy) return
    setError(null)
    if (choice.kind !== 'wsl') setChoice({ kind: 'wsl', distro: null })
    if (!requested.current) void loadDistros()
  }

  const target: ExecutionTarget | null =
    choice.kind === 'local'
      ? { kind: 'local' }
      : choice.distro === null
        ? null
        : { kind: 'wsl', distro: choice.distro.name, distroId: choice.distro.registrationId }

  const trimmed = path.trim()
  /**
   * A guest path is POSIX. On Windows a local path may be a drive path, but a
   * WSL path never is — the distro cannot see `C:\`. Rejecting it here keeps the
   * backend's validation from being the first thing to complain.
   */
  const pathLooksRight =
    trimmed.length > 0 &&
    isAbsolutePathLike(trimmed) &&
    (choice.kind === 'local' || trimmed.startsWith('/'))
  const canSubmit = !busy && target !== null && pathLooksRight

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (inFlight.current || target === null || !pathLooksRight) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const failure = await onSubmit({ path: trimmed, target })
    inFlight.current = false
    setBusy(false)
    if (failure === null) {
      onClose()
      return
    }
    // The dialog stays open with the typed path so the user can correct it.
    setError(failure)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Register repository"
    >
      <form
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl"
        onSubmit={(event) => void submit(event)}
        data-testid="add-repo-form"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">Register a repository</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              ADE only registers the path. Your files and Git checkout are not modified.
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

        <fieldset className="mt-4" disabled={busy}>
          <legend className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Where it lives
          </legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Execution target">
            <button
              type="button"
              role="radio"
              aria-checked={choice.kind === 'local'}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left ${
                choice.kind === 'local' ? 'border-accent/70 bg-accent/10' : 'border-border bg-background'
              } disabled:opacity-50`}
              onClick={selectLocal}
              data-testid="target-local"
            >
              <HardDrive size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-[12px] font-medium">This machine</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  A path on this computer
                </span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={choice.kind === 'wsl'}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left ${
                choice.kind === 'wsl' ? 'border-accent/70 bg-accent/10' : 'border-border bg-background'
              } disabled:opacity-50`}
              onClick={selectWsl}
              data-testid="target-wsl"
            >
              <Server size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-[12px] font-medium">WSL distro</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  A path inside Linux
                </span>
              </span>
            </button>
          </div>
        </fieldset>

        {choice.kind === 'wsl' ? (
          <div className="mt-4" data-testid="wsl-distro-section">
            <div className="flex items-center justify-between">
              <label
                className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                htmlFor="wsl-distro"
              >
                Distro
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                onClick={() => void loadDistros()}
                disabled={busy || distros.phase === 'loading'}
                data-testid="wsl-distro-retry"
              >
                <RefreshCw size={11} className={distros.phase === 'loading' ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>
            {distros.phase === 'idle' || distros.phase === 'loading' ? (
              <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                Looking for installed distros…
              </div>
            ) : distros.phase === 'unavailable' ? (
              <UnavailableNotice payload={distros.payload} />
            ) : distros.phase === 'ipc_failed' ? (
              <div className="mt-1.5 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  The distro list could not be loaded: {distros.error.message}
                </span>
              </div>
            ) : distros.payload.distros.length === 0 ? (
              <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                No WSL distro is installed. Install one with <code>wsl --install</code>, then
                refresh.
              </div>
            ) : (
              <>
                <select
                  id="wsl-distro"
                  className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-2 text-[12px] outline-none focus:border-accent"
                  value={choice.distro?.registrationId ?? ''}
                  onChange={(event) => {
                    const next =
                      distros.payload.distros.find(
                        (entry) => entry.registrationId === event.target.value
                      ) ?? null
                    setChoice({ kind: 'wsl', distro: next })
                    setError(null)
                  }}
                  data-testid="wsl-distro-select"
                >
                  <option value="">Choose a distro</option>
                  {distros.payload.distros.map((distro) => (
                    <option key={distro.registrationId} value={distro.registrationId}>
                      {distro.name}
                      {distro.version === null ? '' : ` · WSL ${String(distro.version)}`}
                      {distro.running === false ? ' — not running' : ''}
                    </option>
                  ))}
                </select>
                {choice.distro !== null && choice.distro.running === null ? (
                  // Unknown is not "stopped": saying either would be a guess.
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Running state unknown. Opening a terminal starts it if needed.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <label
          className="mt-4 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          htmlFor="repo-path"
        >
          {choice.kind === 'local' ? 'Local Git repository path' : `Git repository path in ${choice.distro?.name ?? 'the distro'}`}
        </label>
        <input
          id="repo-path"
          autoFocus
          className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent"
          placeholder="/home/you/projects/my-repo"
          value={path}
          onChange={(event) => {
            setPath(event.target.value)
            setError(null)
          }}
          spellCheck={false}
          disabled={busy}
          data-testid="add-repo-input"
        />
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {choice.kind === 'local'
            ? 'The path must be an existing Git working tree visible to this machine.'
            : 'A Linux path, absolute, as the distro sees it. Win32 paths are not visible to the distro.'}
        </p>

        {error ? (
          <div
            className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
            role="alert"
            data-testid="add-repo-error"
          >
            <span className="font-medium">{error.message}</span>
            {error.detail ? (
              <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
                {error.detail}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted disabled:opacity-50"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={!canSubmit}
            data-testid="add-repo-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {choice.kind === 'wsl' ? 'Register in distro' : 'Register'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Discovery could not answer.
 *
 * The detail is shown verbatim: "the registry could not be read" is what a user
 * needs in order to tell an unavailable WSL install from a permission problem.
 * It is explicitly not presented as "no distros installed".
 */
function UnavailableNotice({
  payload
}: {
  payload: Extract<WslDistroListPayload, { status: 'unavailable' }>
}): React.JSX.Element {
  return (
    <div
      className="mt-1.5 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
      role="status"
      data-testid="wsl-distro-unavailable"
      data-reason={payload.reason}
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>
        {reasonText(payload.reason)}
        <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
          {payload.detail}
        </span>
        A local repository can still be registered.
      </span>
    </div>
  )
}
