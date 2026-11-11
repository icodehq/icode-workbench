import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  X
} from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import type {
  ProjectFolderInspection,
  WslDistroListPayload,
  WslDistroSummary
} from '../../../shared/schemas/ipc'
import {
  type ClonePhasePayload
} from '../../../shared/schemas/remotes'
import { callApi, isAbsolutePathLike } from '../lib/api'
import { isAbsolutePathLike as isAbsolutePathLikeShared } from '../../../shared/domain/paths'
import { detectedPlatform } from '../lib/platform'
import { makeAppError } from '../../../shared/domain/errors'
import { useLocale, useT } from '../i18n/use-i18n'
import type { Translator } from '../i18n/i18n-store'
import { localizeAppError } from '../../../shared/i18n'
import type { MessageKey } from '../../../shared/i18n/messages'
import {
  containsRedactionPlaceholder,
  isCloneableRemoteInput,
  parseRemoteUrl
} from '../../../shared/domain/remote-url'
import { isValidCloneName, joinCloneDestination } from '../../../shared/domain/clone'
import RemoteProviderBadge from './RemoteProviderBadge'

type Dirs = { kind: 'local' } | { kind: 'wsl'; distro: WslDistroSummary | null }

const CLONE_PHASE_KEYS: Record<ClonePhasePayload, MessageKey> = {
  starting: 'addRepo.clone.phase.starting',
  enumerating: 'addRepo.clone.phase.enumerating',
  counting: 'addRepo.clone.phase.counting',
  compressing: 'addRepo.clone.phase.compressing',
  receiving: 'addRepo.clone.phase.receiving',
  resolving: 'addRepo.clone.phase.resolving',
  'checking-out': 'addRepo.clone.phase.checking-out',
  done: 'addRepo.clone.phase.done'
}

type Props = {
  onClose: () => void
  /** Resolves `null` on success, or the failure to show inside the dialog. */
  onSubmit: (input: { path: string; target: ExecutionTarget }) => Promise<AppError | null>
  /** Explicitly creates the Git baseline, then registers the project. */
  onInitialize: (input: {
    path: string
    target: ExecutionTarget
    identity?: { name: string; email: string }
  }) => Promise<AppError | null>
  /** Host platform; WSL is offered only on Windows. */
  platform: string | null
}

type DistroState =
  /** Nothing asked yet: the dialog has never shown the WSL tab. */
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; payload: Extract<WslDistroListPayload, { status: 'ok' }> }
  | { phase: 'unavailable'; payload: Extract<WslDistroListPayload, { status: 'unavailable' }> }
  | { phase: 'ipc_failed'; error: AppError }

function reasonText(
  reason: 'not_windows' | 'registry_unreadable' | 'undecodable_names',
  t: Translator
): string {
  if (reason === 'not_windows') return t('addRepo.wslOnlyWindows')
  if (reason === 'undecodable_names') return t('addRepo.distroUndecodable')
  return t('addRepo.registryUnreadable')
}

export default function AddRepositoryDialog({
  onClose,
  onSubmit,
  onInitialize,
  platform
}: Props): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const isWindows = (platform ?? detectedPlatform()) === 'win32'
  const [mode, setMode] = useState<'open' | 'clone'>('open')
  const [choice, setChoice] = useState<Dirs>({ kind: 'local' })
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  /**
   * Whether the folder was chosen with the picker or typed by hand.
   *
   * The distinction is shown to the user, not just remembered: a browsed path is
   * one they can see and confirm, while a typed one is a claim the service still
   * has to verify.
   */
  const [source, setSource] = useState<'none' | 'browse' | 'typed'>('none')
  const [picking, setPicking] = useState(false)
  /** Manual entry is the fallback, never the default. */
  const [manualEntry, setManualEntry] = useState(false)
  const [distros, setDistros] = useState<DistroState>({ phase: 'idle' })
  const [inspection, setInspection] = useState<ProjectFolderInspection | null>(null)
  const [identityName, setIdentityName] = useState('')
  const [identityEmail, setIdentityEmail] = useState('')
  /**
   * The Windows spelling behind a translated WSL path.
   *
   * Kept separately from `path` because the field shows the path the target can
   * use while the source remains useful for explaining where the project lives.
   */
  const [pickedFrom, setPickedFrom] = useState<string | null>(null)

  /**
   * Clone mode. The form is deliberately separate from the open-folder form:
   * a clone has a URL, an existing parent folder and a new directory name, and
   * shares only the execution target with the open flow.
   */
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneParent, setCloneParent] = useState('')
  const [cloneParentFrom, setCloneParentFrom] = useState<string | null>(null)
  const [cloneName, setCloneName] = useState('')
  const [cloneNameEdited, setCloneNameEdited] = useState(false)
  const [clonePicking, setClonePicking] = useState(false)
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneCancelling, setCloneCancelling] = useState(false)
  const [cloneProgress, setCloneProgress] = useState<{
    phase: ClonePhasePayload
    percent: number | null
    detail: string
  } | null>(null)
  const [cloneNotice, setCloneNotice] = useState<AppError | null>(null)
  const [cloneCleanupFailedPath, setCloneCleanupFailedPath] = useState<string | null>(null)
  const activeCloneRef = useRef<string | null>(null)
  const cloneTargetRef = useRef<ExecutionTarget | null>(null)
  /**
   * The event subscription is installed once; these refs keep the callbacks it
   * invokes current without tearing the subscription down on every render.
   */
  const onInitializeRef = useRef(onInitialize)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onInitializeRef.current = onInitialize
    onCloseRef.current = onClose
  }, [onInitialize, onClose])

  /**
   * A path belongs to exactly one filesystem.
   *
   * Switching from this machine to a distro (or to a different distro) leaves the
   * previous spelling meaningless, so it is cleared together with the error. The
   * alternative — keeping it — shows `D:\…` under a dialog that says the path is a
   * Linux path, and leaves Submit disabled for a reason the user cannot see.
   */
  const targetKey = choice.kind === 'local' ? 'local' : `wsl:${choice.distro?.registrationId ?? ''}`
  const previousTargetKey = useRef(targetKey)
  useEffect(() => {
    const previous = previousTargetKey.current
    previousTargetKey.current = targetKey
    if (previous === targetKey) return
    /*
     * Discovery auto-selects the default distro after WSL is chosen. That is a
     * completion of the same choice, not a new environment: a path typed while
     * discovery was still running must survive. A real distro change still
     * clears the path because a Linux path may not exist in the next distro.
     */
    if (previous === 'wsl:' && targetKey.startsWith('wsl:')) {
      return
    }
    setPath('')
    setSource('none')
    setError(null)
    setInspection(null)
    setPickedFrom(null)
    setIdentityName('')
    setIdentityEmail('')
    // The parent belongs to the previous environment; the URL and name do not.
    setCloneParent('')
    setCloneParentFrom(null)
    setCloneNotice(null)
    setCloneCleanupFailedPath(null)
    setCloneProgress(null)
  }, [targetKey])

  useEffect(() => {
    const off = window.icode.clone.onProgress((event) => {
      if (activeCloneRef.current !== event.requestId) return
      if (event.type === 'progress') {
        setCloneProgress({
          phase: event.phase,
          percent: event.percent,
          detail: event.detail
        })
        return
      }

      activeCloneRef.current = null
      setCloneCancelling(false)
      setCloneCleanupFailedPath(null)

      if (event.type === 'cancelled') {
        setCloneBusy(false)
        setCloneProgress(null)
        setCloneCleanupFailedPath(event.cleanup === 'failed' ? event.destination : null)
        setCloneNotice(
          makeAppError('INVALID_ARGUMENT', '', {
            messageKey:
              event.cleanup === 'failed'
                ? 'addRepo.clone.cancelledKept'
                : 'addRepo.clone.cancelled',
            messageParams: { path: event.destination }
          })
        )
        return
      }

      if (event.type === 'failed') {
        setCloneBusy(false)
        setCloneProgress(null)
        setCloneNotice(event.error)
        setCloneCleanupFailedPath(event.cleanup === 'failed' ? event.destination : null)
        return
      }

      // Done. Register through the same flow the open-folder form uses, so a
      // normal checkout, an unborn repository and a Gitless folder all end in
      // one place. An empty remote hands control back to the adoption panel.
      setCloneProgress({ phase: 'done', percent: 100, detail: '' })
      const cloneTarget = cloneTargetRef.current
      if (cloneTarget === null) return
      void (async () => {
        const failure = await onInitializeRef.current({
          path: event.destination,
          target: cloneTarget
        })
        setCloneBusy(false)
        if (failure === null) {
          onCloseRef.current()
          return
        }
        if (event.unborn || failure.code === 'GIT_IDENTITY_MISSING') {
          const inspected = await callApi(
            window.icode.repos.inspect({ path: event.destination, target: cloneTarget })
          )
          setMode('open')
          setPath(event.destination)
          setSource('browse')
          setInspection(inspected.ok ? inspected.value : null)
          setPickedFrom(null)
          setIdentityName('')
          setIdentityEmail('')
          setError(failure)
          setCloneNotice(
            makeAppError('INVALID_ARGUMENT', '', {
              messageKey: 'addRepo.clone.emptyRepository'
            })
          )
          setCloneProgress(null)
          return
        }
        setCloneNotice(failure)
        setCloneProgress(null)
      })()
    })
    return off
  }, [])
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
    const result = await callApi(window.icode.wsl.listDistros())
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
   * A WSL target can run against either its own filesystem or a Windows drive
   * mounted into it. Both `D:\project` and `/mnt/d/project` are therefore valid
   * spellings; the backend owns the translation and the mount check.
   */
  const pathLooksRight = trimmed.length > 0 && isAbsolutePathLike(trimmed)
  const needsIdentity =
    inspection !== null &&
    inspection.kind !== 'repository' &&
    inspection.kind !== 'parent' &&
    inspection.canInitialize &&
    !inspection.identity.configured
  const identityLooksValid =
    !needsIdentity || (identityName.trim().length > 0 && identityEmail.trim().length > 0)
  const inspectionReady =
    inspection === null ||
    inspection.kind === 'repository' ||
    ((inspection.kind === 'unborn' || inspection.kind === 'gitless') && inspection.canInitialize)
  const canSubmit =
    !busy && target !== null && pathLooksRight && inspectionReady && identityLooksValid
  const submitLabel =
    inspection === null
      ? t('addRepo.submit.add')
      : inspection.kind === 'repository'
        ? t('addRepo.submit.register')
        : inspection.kind === 'unborn'
          ? t('addRepo.submit.unborn')
          : inspection.kind === 'gitless'
            ? t('addRepo.submit.gitless')
            : t('addRepo.submit.choose')

  const cloneUrlTrimmed = cloneUrl.trim()
  const cloneParentTrimmed = cloneParent.trim()
  const cloneNameTrimmed = cloneName.trim()
  const clonePreview = parseRemoteUrl(cloneUrlTrimmed)
  const cloneUrlValid =
    cloneUrlTrimmed.length > 0 &&
    isCloneableRemoteInput(cloneUrlTrimmed) &&
    !containsRedactionPlaceholder(cloneUrlTrimmed)
  const cloneParentValid =
    cloneParentTrimmed.length > 0 && isAbsolutePathLikeShared(cloneParentTrimmed)
  const cloneNameValid = isValidCloneName(cloneNameTrimmed)
  const cloneDestination =
    target !== null && cloneParentValid && cloneNameTrimmed.length > 0
      ? joinCloneDestination(cloneParentTrimmed, cloneNameTrimmed, target)
      : null
  const cloneReady =
    !busy &&
    !cloneBusy &&
    target !== null &&
    cloneUrlValid &&
    cloneParentValid &&
    cloneNameValid
  const cloneNoticeLocalized =
    cloneNotice === null ? null : localizeAppError(cloneNotice, locale)

  const selectMode = (next: 'open' | 'clone'): void => {
    if (busy || cloneBusy || mode === next) return
    setMode(next)
    setError(null)
    setInspection(null)
    setCloneNotice(null)
    setCloneCleanupFailedPath(null)
    setCloneProgress(null)
  }

  const browseCloneParent = async (): Promise<void> => {
    if (clonePicking || cloneBusy || busy || target === null) return
    setClonePicking(true)
    setCloneNotice(null)
    try {
      const result = await callApi(
        window.icode.repos.pickFolder({
          target,
          purpose: 'clone-parent',
          ...(choice.kind === 'wsl' ? { source: 'windows' as const } : {})
        })
      )
      if (!result.ok) {
        setCloneNotice(result.error)
        return
      }
      if (result.value.status === 'cancelled') return
      if (result.value.status === 'unavailable') {
        setCloneNotice(
          makeAppError('INVALID_ARGUMENT', t('addRepo.pickFailed'), {
            detail: result.value.detail,
            messageKey: 'addRepo.pickFailed'
          })
        )
        return
      }
      setCloneParent(result.value.path)
      setCloneParentFrom(result.value.translatedFrom ?? null)
    } finally {
      setClonePicking(false)
    }
  }

  const startClone = async (): Promise<void> => {
    if (!cloneReady || target === null) {
      setCloneNotice(
        makeAppError('INVALID_ARGUMENT', '', { messageKey: 'addRepo.clone.nothing' })
      )
      return
    }
    const requestId = crypto.randomUUID()
    activeCloneRef.current = requestId
    cloneTargetRef.current = target
    setCloneBusy(true)
    setCloneCancelling(false)
    setCloneNotice(null)
    setCloneCleanupFailedPath(null)
    setCloneProgress({ phase: 'starting', percent: null, detail: '' })
    const result = await callApi(
      window.icode.clone.start({
        requestId,
        url: cloneUrlTrimmed,
        target,
        parentPath: cloneParentTrimmed,
        name: cloneNameTrimmed
      })
    )
    if (!result.ok) {
      activeCloneRef.current = null
      setCloneBusy(false)
      setCloneProgress(null)
      setCloneNotice(result.error)
    }
  }

  const cancelClone = async (): Promise<void> => {
    const requestId = activeCloneRef.current
    if (requestId === null || cloneCancelling) return
    setCloneCancelling(true)
    const result = await callApi(window.icode.clone.cancel({ requestId }))
    if (!result.ok || !result.value.cancelled) setCloneCancelling(false)
  }

  /**
   * Opens one platform folder dialog for the chosen target.
   *
   * For WSL this is the native Windows dialog. It can reach Windows drives and,
   * when Windows exposes it, the distro namespace; the backend translates a
   * Windows spelling with the selected distro. The previous two-button design
   * exposed that implementation split to the user.
   */
  const browse = async (): Promise<void> => {
    if (picking || busy || target === null) return
    setPicking(true)
    setError(null)
    try {
      const result = await callApi(
        choice.kind === 'wsl'
          ? window.icode.repos.pickFolder({ target, source: 'windows' })
          : window.icode.repos.pickFolder({ target })
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.value.status === 'cancelled') return
      if (result.value.status === 'unavailable') {
        setError(
          makeAppError('INVALID_ARGUMENT', t('addRepo.pickFailed'), {
            detail: result.value.detail,
            messageKey: 'addRepo.pickFailed'
          })
        )
        /*
         * The refused folder is not adopted, and neither is whatever was chosen
         * before it: leaving the old path on screen after a refusal reads as
         * though the refused pick had been accepted.
         */
        setPath('')
        setSource('none')
        setInspection(null)
        setPickedFrom(null)
        setManualEntry(true)
        return
      }
      setPath(result.value.path)
      setSource('browse')
      setInspection(null)
      setPickedFrom(result.value.translatedFrom ?? null)
      setError(null)
    } finally {
      setPicking(false)
    }
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (mode === 'clone') {
      await startClone()
      return
    }
    if (inFlight.current || target === null || !pathLooksRight) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      if (inspection === null) {
        /*
         * Do the whole operation in one backend call. `initialize` already
         * classifies an existing checkout, an unborn repository and a plain
         * folder, so asking `inspect` first duplicated every Git and WSL probe
         * before the real call. That duplication was several seconds on a
         * DrvFs folder. If the backend needs a user decision it fails before
         * mutating anything; only then do we ask for the inspection that
         * explains the identity/container/blocked state.
         */
        const failure = await onInitialize({ path: trimmed, target })
        if (failure === null) {
          onClose()
          return
        }
        const result = await callApi(window.icode.repos.inspect({ path: trimmed, target }))
        if (result.ok) {
          setInspection(result.value)
          if (result.value.translatedFrom !== undefined) {
            setPickedFrom(result.value.translatedFrom)
          }
        }
        setError(failure)
        return
      }

      if (inspection.kind === 'repository') {
        const failure = await onSubmit({ path: inspection.path, target })
        if (failure === null) {
          onClose()
          return
        }
        setError(failure)
        return
      }

      if (inspection.kind === 'unborn' || inspection.kind === 'gitless') {
        if (!inspection.canInitialize) return
        const identity = inspection.identity.configured
          ? undefined
          : { name: identityName.trim(), email: identityEmail.trim() }
        if (identity !== undefined && (identity.name.length === 0 || identity.email.length === 0)) {
          return
        }
        const failure = await onInitialize({
          path: inspection.path,
          target,
          ...(identity === undefined ? {} : { identity })
        })
        if (failure === null) {
          onClose()
          return
        }
        setError(failure)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  /**
   * A nested-repository suggestion is a shortcut, not another form step: inspect
   * the candidate and register it immediately when it already has a commit.
   */
  const chooseCandidate = async (candidatePath: string): Promise<void> => {
    if (inFlight.current || target === null) return
    setPath(candidatePath)
    setSource('browse')
    setInspection(null)
    setPickedFrom(null)
    setError(null)
    setIdentityName('')
    setIdentityEmail('')
    inFlight.current = true
    setBusy(true)
    try {
      const result = await callApi(
        window.icode.repos.inspect({ path: candidatePath, target })
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      setInspection(result.value)
      if (result.value.kind === 'repository') {
        const failure = await onSubmit({ path: result.value.path, target })
        if (failure === null) {
          onClose()
          return
        }
        setError(failure)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('addRepo.title')}
    >
      <form
        className="icode-modal max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-2xl"
        onSubmit={(event) => void submit(event)}
        data-testid="add-repo-form"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[16px] font-semibold">{t('addRepo.title')}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t('addRepo.subtitle')}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {t('addRepo.securityNote')}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={onClose}
            aria-label={t('common.close')}
            disabled={busy || cloneBusy}
          >
            <X size={14} />
          </button>
        </div>

        <div
          className="mt-4 grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/40 p-1"
          role="tablist"
          aria-label={t('addRepo.title')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'open'}
            className={`rounded px-2 py-1.5 text-[11px] font-medium ${
              mode === 'open' ? 'bg-accent text-accent-ink' : 'text-muted-foreground hover:bg-muted'
            } disabled:opacity-50`}
            onClick={() => selectMode('open')}
            disabled={busy || cloneBusy}
            data-testid="add-repo-mode-open"
          >
            {t('addRepo.mode.open')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'clone'}
            className={`rounded px-2 py-1.5 text-[11px] font-medium ${
              mode === 'clone' ? 'bg-accent text-accent-ink' : 'text-muted-foreground hover:bg-muted'
            } disabled:opacity-50`}
            onClick={() => selectMode('clone')}
            disabled={busy || cloneBusy}
            data-testid="add-repo-mode-clone"
          >
            {t('addRepo.mode.clone')}
          </button>
        </div>

        <fieldset className="mt-4" disabled={busy || cloneBusy}>
          <legend className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('addRepo.environment')}
          </legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('addRepo.executionTarget')}>
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
                <span className="block text-[12.5px] font-medium">
                  {t('addRepo.thisMachine')}
                </span>
                <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                  {isWindows ? t('addRepo.runWindows') : t('addRepo.runLocal')}
                </span>
              </span>
            </button>
            {isWindows ? (
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
                  <span className="block text-[12.5px] font-medium">{t('addRepo.wslDistro')}</span>
                  <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                    {t('addRepo.wslHint')}
                  </span>
                </span>
              </button>
            ) : null}
          </div>
        </fieldset>

        {choice.kind === 'wsl' ? (
          <div className="mt-4" data-testid="wsl-distro-section">
            <div className="flex items-center justify-between">
              <label
                className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground"
                htmlFor="wsl-distro"
              >
                {t('addRepo.distro')}
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                onClick={() => void loadDistros()}
                disabled={busy || distros.phase === 'loading'}
                data-testid="wsl-distro-retry"
              >
                <RefreshCw size={11} className={distros.phase === 'loading' ? 'animate-spin' : ''} />
                {t('common.refresh')}
              </button>
            </div>
            {distros.phase === 'idle' || distros.phase === 'loading' ? (
              <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                {t('addRepo.looking')}
              </div>
            ) : distros.phase === 'unavailable' ? (
              <UnavailableNotice payload={distros.payload} />
            ) : distros.phase === 'ipc_failed' ? (
              <div className="mt-1.5 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  {t('addRepo.distroListFailed', { message: distros.error.message })}
                </span>
              </div>
            ) : distros.payload.distros.length === 0 ? (
              <div className="mt-1.5 rounded-md border border-signal-line bg-signal-weak px-3 py-2 text-[11px] text-signal">
                {t('addRepo.noDistro')}
              </div>
            ) : (
              <>
                <select
                  id="wsl-distro"
                  className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2.5 text-[12.5px] outline-none focus:border-accent"
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
                  <option value="">{t('addRepo.chooseDistro')}</option>
                  {distros.payload.distros.map((distro) => (
                    <option key={distro.registrationId} value={distro.registrationId}>
                      {distro.name}
                      {distro.version === null
                        ? ''
                        : t('addRepo.distroVersion', { version: distro.version })}
                      {distro.running === false ? t('addRepo.notRunning') : ''}
                    </option>
                  ))}
                </select>
                {choice.distro !== null && choice.distro.running === null ? (
                  // Unknown is not "stopped": saying either would be a guess.
                  <p className="mt-1 text-[10.5px] text-muted-foreground">
                    {t('addRepo.runningUnknown')}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {mode === 'open' ? (
          <>
        <div className="mt-4">
          <span className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('addRepo.projectFolder')}
          </span>

          {/* One primary action; typing is the fallback below. */}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void browse()}
              disabled={busy || picking || target === null}
              data-testid="add-repo-browse"
            >
              {picking ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
              {picking ? t('addRepo.choosing') : t('addRepo.browse')}
            </button>
            {source === 'browse' && path.length > 0 ? (
              <button
                type="button"
                className="text-[10.5px] text-muted-foreground underline hover:text-foreground"
                onClick={() => setManualEntry((open) => !open)}
                data-testid="add-repo-edit-path"
              >
                {manualEntry ? t('addRepo.hidePath') : t('addRepo.editPath')}
              </button>
            ) : path.length === 0 ? (
              <button
                type="button"
                className="text-[10.5px] text-muted-foreground underline hover:text-foreground"
                onClick={() => setManualEntry((open) => !open)}
                data-testid="add-repo-manual-toggle"
              >
                {manualEntry ? t('addRepo.hidePathEntry') : t('addRepo.enterPath')}
              </button>
            ) : null}
          </div>

          {path.length > 0 && source === 'browse' && !manualEntry ? (
            <div
              className="mt-1.5 flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-2"
              data-testid="add-repo-selection"
            >
              <Check size={12} className="mt-0.5 shrink-0 text-add" />
              <span className="min-w-0 flex-1">
                <span className="block break-all font-mono text-[11px] text-foreground">
                  {path}
                </span>
                {pickedFrom !== null && pickedFrom !== path ? (
                  <span
                    className="mt-1 block break-all font-mono text-[9.5px] text-muted-foreground"
                    data-testid="add-repo-translated-from"
                  >
                    {t('addRepo.from', { path: pickedFrom })}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}

          {manualEntry || source !== 'browse' || path.length === 0 ? (
            <>
              <label className="sr-only" htmlFor="repo-path">
                {choice.kind === 'local'
                  ? t('addRepo.localPathAria')
                  : t('addRepo.wslPathAria')}
              </label>
              <input
                id="repo-path"
                autoFocus={manualEntry}
                className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12.5px] outline-none focus:border-accent"
                placeholder={
                  choice.kind === 'local'
                    ? isWindows
                      ? t('addRepo.placeholderWindowsWin')
                      : t('addRepo.placeholderWindowsUnix')
                    : t('addRepo.placeholderWsl')
                }
                value={path}
                onChange={(event) => {
                  setPath(event.target.value)
                  setSource('typed')
                  setError(null)
                  setInspection(null)
                  setPickedFrom(null)
                  setIdentityName('')
                  setIdentityEmail('')
                }}
                spellCheck={false}
                disabled={busy}
                data-testid="add-repo-input"
              />
            </>
          ) : null}

          <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            {choice.kind === 'local' ? t('addRepo.localHelp') : t('addRepo.wslHelp')}
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            {t('addRepo.firstCommitHelp')}
          </p>
          {pickedFrom !== null &&
          (source !== 'browse' || manualEntry) &&
          pickedFrom !== (inspection?.path ?? path) &&
          choice.kind === 'wsl' ? (
            <p
              className="mt-1 rounded border border-border bg-background px-2 py-1.5 text-[10px] text-muted-foreground"
              data-testid="add-repo-mapping"
            >
              {t('addRepo.mapping', {
                from: pickedFrom,
                to: inspection?.path ?? path,
                distro: choice.distro?.name ?? t('newSession.repositoryFallback')
              })}
            </p>
          ) : null}
        </div>

        {inspection !== null && inspection.kind !== 'repository' ? (
          <section
            className="mt-4 rounded-md border border-border bg-muted/30 p-3"
            data-testid="add-repo-adoption"
          >
            {inspection.kind === 'parent' ? (
              <>
                <p className="text-[12px] font-medium">{t('addRepo.chooseRepository')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t('addRepo.childrenIntro')}
                </p>
                <div className="mt-2 grid gap-1.5">
                  {inspection.repositories.map((candidate, index) => (
                    <button
                      key={candidate.path}
                      type="button"
                      className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-left hover:border-accent/60 hover:bg-accent/5 disabled:opacity-50"
                      onClick={() => void chooseCandidate(candidate.path)}
                      disabled={busy}
                      data-testid={`add-repo-candidate-${String(index)}`}
                    >
                      <FolderGit2 size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block text-[11.5px] font-medium">
                          {candidate.displayName}
                        </span>
                        <span className="mt-0.5 block break-all font-mono text-[9.5px] text-muted-foreground">
                          {candidate.path}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-signal" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium">
                      {inspection.kind === 'unborn'
                        ? t('addRepo.createFirstCommit')
                        : t('addRepo.initGit')}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {inspection.kind === 'unborn'
                        ? t('addRepo.unbornBody')
                        : t('addRepo.gitlessBody')}{' '}
                      {t('addRepo.firstCommitRuns')}
                    </p>
                  </div>
                </div>

                {inspection.blockedReason !== null ? (
                  <p className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[10.5px] text-destructive">
                    {inspection.blockedReason}
                  </p>
                ) : null}

                {needsIdentity ? (
                  <div className="mt-3 grid gap-2" data-testid="add-repo-identity">
                    <p className="text-[10.5px] text-muted-foreground">
                      {t('addRepo.identityHelp')}
                    </p>
                    <label className="grid gap-1 text-[10.5px] text-muted-foreground">
                      {t('addRepo.authorName')}
                      <input
                        className="rounded-md border border-border bg-background px-2.5 py-2 text-[11.5px] text-foreground outline-none focus:border-accent"
                        value={identityName}
                        onChange={(event) => setIdentityName(event.target.value)}
                        disabled={busy}
                        autoComplete="name"
                        data-testid="add-repo-identity-name"
                      />
                    </label>
                    <label className="grid gap-1 text-[10.5px] text-muted-foreground">
                      {t('addRepo.email')}
                      <input
                        className="rounded-md border border-border bg-background px-2.5 py-2 text-[11.5px] text-foreground outline-none focus:border-accent"
                        value={identityEmail}
                        onChange={(event) => setIdentityEmail(event.target.value)}
                        disabled={busy}
                        autoComplete="email"
                        inputMode="email"
                        data-testid="add-repo-identity-email"
                      />
                    </label>
                  </div>
                ) : null}
              </>
            )}
          </section>
        ) : null}
          </>
        ) : (
          <section className="mt-4" data-testid="add-repo-clone">
            <label className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('addRepo.clone.url')}
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12px] text-foreground outline-none focus:border-accent disabled:opacity-60"
                  value={cloneUrl}
                  onChange={(event) => {
                    const next = event.target.value
                    setCloneUrl(next)
                    setCloneNotice(null)
                    const parsed = parseRemoteUrl(next)
                    if (!cloneNameEdited && parsed?.suggestedName !== null && parsed?.suggestedName !== undefined) {
                      setCloneName(parsed.suggestedName)
                    }
                  }}
                  placeholder={t('addRepo.clone.urlPlaceholder')}
                  spellCheck={false}
                  disabled={cloneBusy}
                  data-testid="add-repo-clone-url"
                />
                {clonePreview !== null ? (
                  <RemoteProviderBadge provider={clonePreview.provider} />
                ) : null}
                {clonePreview?.webUrl !== null && clonePreview?.webUrl !== undefined ? (
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={t('remotes.openInBrowser')}
                    aria-label={t('remotes.openInBrowser')}
                    onClick={() =>
                      void window.icode.window.openExternal({ url: clonePreview.webUrl! })
                    }
                    data-testid="add-repo-clone-open-browser"
                  >
                    <ExternalLink size={12} />
                  </button>
                ) : null}
              </div>
            </label>
            {clonePreview?.hasCredentials === true ? (
              <p className="mt-1.5 text-[10px] text-signal">
                {t('addRepo.clone.credentialsWarning')}
              </p>
            ) : null}

            <div className="mt-3">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('addRepo.clone.parent')}
                </span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  onClick={() => void browseCloneParent()}
                  disabled={cloneBusy || clonePicking || busy || target === null}
                  data-testid="add-repo-clone-browse"
                >
                  {clonePicking ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <FolderOpen size={11} />
                  )}
                  {clonePicking ? t('addRepo.choosing') : t('addRepo.clone.browse')}
                </button>
              </div>
              <input
                className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12px] text-foreground outline-none focus:border-accent disabled:opacity-60"
                value={cloneParent}
                onChange={(event) => {
                  setCloneParent(event.target.value)
                  setCloneParentFrom(null)
                  setCloneNotice(null)
                }}
                placeholder={t('addRepo.clone.parentPlaceholder')}
                spellCheck={false}
                disabled={cloneBusy}
                data-testid="add-repo-clone-parent"
              />
              {cloneParentFrom !== null && cloneParentFrom !== cloneParent ? (
                <p className="mt-1 break-all font-mono text-[9.5px] text-muted-foreground">
                  {t('addRepo.from', { path: cloneParentFrom })}
                </p>
              ) : null}
            </div>

            <label className="mt-3 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('addRepo.clone.name')}
              <input
                className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12px] text-foreground outline-none focus:border-accent disabled:opacity-60"
                value={cloneName}
                onChange={(event) => {
                  setCloneName(event.target.value)
                  setCloneNameEdited(true)
                  setCloneNotice(null)
                }}
                placeholder={t('addRepo.clone.namePlaceholder')}
                spellCheck={false}
                disabled={cloneBusy}
                data-testid="add-repo-clone-name"
              />
            </label>

            {cloneDestination !== null ? (
              <p
                className="mt-2 break-all font-mono text-[10px] text-muted-foreground"
                data-testid="add-repo-clone-destination"
              >
                {t('addRepo.clone.destination', { path: cloneDestination })}
              </p>
            ) : null}

            {cloneProgress !== null ? (
              <div
                className="mt-3 rounded-md border border-border bg-background px-3 py-2"
                data-testid="add-repo-clone-progress"
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <Loader2 size={12} className={cloneBusy ? 'animate-spin' : ''} />
                  <span>
                    {t(CLONE_PHASE_KEYS[cloneProgress.phase])}
                    {cloneProgress.percent !== null
                      ? ` · ${String(cloneProgress.percent)}%`
                      : '…'}
                  </span>
                </div>
                {cloneProgress.percent !== null ? (
                  <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-accent transition-[width]"
                      style={{ width: `${String(cloneProgress.percent)}%` }}
                    />
                  </div>
                ) : null}
                {cloneProgress.detail.length > 0 ? (
                  <p className="mt-1 break-all font-mono text-[9px] text-muted-foreground">
                    {cloneProgress.detail}
                  </p>
                ) : null}
              </div>
            ) : null}

            {cloneNoticeLocalized !== null ? (
              <div
                className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
                role="alert"
                data-testid="add-repo-clone-notice"
              >
                <span className="font-medium">{cloneNoticeLocalized.message}</span>
                {cloneNoticeLocalized.detail ? (
                  <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
                    {cloneNoticeLocalized.detail}
                  </span>
                ) : null}
                {cloneCleanupFailedPath !== null ? (
                  <span className="mt-0.5 block text-[10px]">
                    {t('addRepo.clone.cleanupFailed', { path: cloneCleanupFailedPath })}
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>
        )}

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

        <div className="mt-5 flex items-center justify-end gap-2">
          {mode === 'clone' && cloneBusy ? (
            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] hover:bg-muted disabled:opacity-50"
              onClick={() => void cancelClone()}
              disabled={cloneCancelling}
              data-testid="add-repo-clone-cancel"
            >
              {cloneCancelling ? <Loader2 size={12} className="animate-spin" /> : null}
              {cloneCancelling ? t('addRepo.clone.cancelling') : t('addRepo.clone.cancel')}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md border border-border h-9 px-3 text-[12px] hover:bg-muted disabled:opacity-50"
            onClick={onClose}
            disabled={busy || cloneBusy}
            data-testid="add-repo-cancel"
          >
            {t('addRepo.cancel')}
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent h-9 px-3.5 text-[12.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
            disabled={mode === 'clone' ? !cloneReady : !canSubmit}
            data-testid="add-repo-submit"
          >
            {mode === 'clone' ? (
              cloneBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )
            ) : busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Check size={12} />
            )}
            {mode === 'clone'
              ? cloneBusy
                ? t('addRepo.clone.starting')
                : t('addRepo.clone.start')
              : submitLabel}
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
  const t = useT()
  return (
    <div
      className="mt-1.5 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
      role="status"
      data-testid="wsl-distro-unavailable"
      data-reason={payload.reason}
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>
        {reasonText(payload.reason, t)}
        <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
          {payload.detail}
        </span>
        {t('addRepo.stillCanRegister')}
      </span>
    </div>
  )
}
