import {
  makeAppError,
  type AppError,
  type AppErrorCode
} from '../../shared/domain/errors'
import type { MessageKey } from '../../shared/i18n'
import {
  resolveUpdateMode,
  releasePageUrl,
  type UnsupportedUpdateReason,
  type UpdateMode
} from '../../shared/domain/update'
import type {
  UpdateInstallInput,
  UpdateInstallOutcome,
  UpdateLiveSession,
  UpdateProgress,
  UpdateState
} from '../../shared/schemas/updates'
import type { AppPreferences } from '../app/preferences'
import type { ReleaseFeed } from './release-feed'
import type { UpdateBackend } from './update-backend'
import {
  UPDATE_JOURNAL_VERSION,
  type UpdateJournalEntry
} from './update-journal'

/**
 * Owns update state for the main process.
 *
 * Electron-updater is reached only through `UpdateBackend`, and every platform
 * fact and side effect is injected, so the state machine runs in vitest's node
 * environment without Electron and without touching the machine.
 */

export const UPDATE_STARTUP_DELAY_MS = 60_000
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const INSTALL_RESPONSE_DELAY_MS = 250

export type PrepareWindowsResult = 'ready' | 'cancelled' | 'timeout' | 'unavailable'

export type UpdateServiceDeps = {
  currentVersion: string
  packaged: boolean
  platform: string
  arch: string
  appImage: string | null | undefined
  feed: ReleaseFeed
  backend: UpdateBackend
  preferences: {
    load: () => AppPreferences
    update: (patch: Partial<AppPreferences>) => boolean
  }
  sessions: {
    listLive: () => Promise<UpdateLiveSession[]>
    /** Sleeps every live session; a non-zero failed count aborts the install. */
    sleepAllLive: () => Promise<{
      slept: number
      failed: number
      /** Lists the sessions/processes involved; the installer error shows it. */
      detail?: string | null
    }>
  }
  windows: {
    prepareForClose: () => Promise<PrepareWindowsResult>
    beginInstall: () => void
  }
  background: {
    quiesce: () => void
    resume: () => void
  }
  stopTerminalHosts: () => Promise<void>
  shutdownRuntime: () => Promise<void>
  /** A platform-specific reason the downloaded update cannot be installed. */
  preflightInstall?: () => AppError | null
  /** A durable record of the attempt, for the next launch's version check. */
  journal?: { begin(entry: UpdateJournalEntry): void }
  /** A previous attempt whose target version this launch is not running. */
  interruptedInstall?: UpdateJournalEntry | null
  /** Relaunch after teardown, when the app can no longer recover in place. */
  relaunchAfterFailure: () => void
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
  logger?: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export type UpdateService = {
  getState: () => UpdateState
  subscribe: (listener: (state: UpdateState) => void) => () => void
  start: () => void
  check: () => Promise<UpdateState>
  download: () => Promise<UpdateState>
  cancelDownload: () => UpdateState
  install: (input: UpdateInstallInput) => Promise<UpdateInstallOutcome>
  skip: (version: string | null) => UpdateState
  setAutoCheck: (enabled: boolean) => UpdateState
  dispose: () => void
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  )
}

function asUpdateError(
  error: unknown,
  code: AppErrorCode,
  message: string,
  messageKey: MessageKey
): AppError {
  if (isAppError(error)) return error
  return makeAppError(code, message, {
    detail: error instanceof Error ? error.message : String(error),
    messageKey
  })
}

function installFailed(detail: string): AppError {
  return makeAppError('UPDATE_INSTALL_FAILED', 'Could not install the update.', {
    detail,
    messageKey: 'updates.error.installFailed'
  })
}

function notSupported(): AppError {
  return makeAppError('UPDATE_NOT_SUPPORTED', 'This build cannot install updates automatically.', {
    messageKey: 'updates.error.notSupported'
  })
}

function notReady(): AppError {
  return makeAppError('UPDATE_NOT_READY', 'The update is not ready to install.', {
    messageKey: 'updates.error.notReady'
  })
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const now = deps.now ?? Date.now
  const setTimeoutFn = deps.setTimeout ?? setTimeout
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout
  const setIntervalFn = deps.setInterval ?? setInterval
  const clearIntervalFn = deps.clearInterval ?? clearInterval
  const logger = deps.logger ?? {
    info: (...args: unknown[]) => console.info('[updates]', ...args),
    warn: (...args: unknown[]) => console.warn('[updates]', ...args),
    error: (...args: unknown[]) => console.error('[updates]', ...args)
  }

  const resolution = resolveUpdateMode({
    packaged: deps.packaged,
    platform: deps.platform,
    appImage: deps.appImage
  })
  const mode: UpdateMode = resolution.mode
  const unsupportedReason: UnsupportedUpdateReason | null = resolution.unsupportedReason

  const initialPreferences = deps.preferences.load()
  const interrupted = mode === 'install' ? (deps.interruptedInstall ?? null) : null
  if (interrupted !== null) {
    logger.warn(
      `previous install ${interrupted.fromVersion} -> ${interrupted.toVersion} did not complete; ` +
        `still running ${deps.currentVersion}`
    )
  }
  let state: UpdateState = {
    mode,
    phase: interrupted === null ? 'idle' : 'error',
    currentVersion: deps.currentVersion,
    availableVersion: interrupted?.toVersion ?? null,
    releaseUrl: interrupted === null ? null : releasePageUrl(interrupted.toVersion),
    downloadUrl: null,
    progress: null,
    autoCheck: initialPreferences.updateAutoCheckEnabled,
    skippedVersion: initialPreferences.skippedUpdateVersion,
    checkedAt: null,
    error:
      interrupted === null
        ? null
        : makeAppError('UPDATE_INSTALL_FAILED', 'The last update did not complete.', {
            detail:
              `iCode is still on ${deps.currentVersion}; the attempt to install ` +
              `${interrupted.toVersion} started at ${new Date(interrupted.startedAt).toISOString()} ` +
              'did not complete. Check the update log and try again.',
            messageKey: 'updates.error.installFailed'
          }),
    unsupportedReason
  }

  const listeners = new Set<(next: UpdateState) => void>()
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let checkPromise: Promise<void> | null = null
  let checkIsManual = false
  let downloadPromise: Promise<void> | null = null
  let downloadCancelRequested = false
  let installPending = false
  let installTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function emit(): void {
    for (const listener of listeners) listener(state)
  }

  function setState(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch }
    emit()
  }

  function stopTimers(): void {
    if (startupTimer !== null) clearTimeoutFn(startupTimer)
    if (intervalTimer !== null) clearIntervalFn(intervalTimer)
    startupTimer = null
    intervalTimer = null
  }

  function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
    ;(timer as { unref?: () => void }).unref?.()
  }

  function schedule(): void {
    stopTimers()
    if (disposed || mode === 'unsupported' || !state.autoCheck) return
    startupTimer = setTimeoutFn(() => {
      startupTimer = null
      void check(false)
    }, UPDATE_STARTUP_DELAY_MS)
    unrefTimer(startupTimer)
    intervalTimer = setIntervalFn(() => {
      void check(false)
    }, UPDATE_CHECK_INTERVAL_MS)
    unrefTimer(intervalTimer)
  }

  function busyForCheck(): boolean {
    return (
      state.phase === 'checking' ||
      state.phase === 'downloading' ||
      state.phase === 'ready' ||
      state.phase === 'restarting'
    )
  }

  async function check(manual: boolean): Promise<void> {
    if (disposed || mode === 'unsupported') return
    if (!manual && !state.autoCheck) return
    // Await an in-flight check before the phase guard: that check has already
    // set `checking`, and a manual request must still be able to follow it.
    if (checkPromise !== null) {
      const wasManual = checkIsManual
      await checkPromise
      // A manual request that arrived during an automatic check must ignore the
      // automatic check's skip suppression; re-run once it finishes.
      if (manual && !wasManual) return check(true)
      return
    }
    if (busyForCheck()) return

    checkIsManual = manual
    setState({ phase: 'checking', error: null })
    logger.info(`checking for updates (${manual ? 'manual' : 'automatic'})`)
    checkPromise = (async () => {
      try {
        const result = await deps.feed.check(deps.currentVersion, mode)
        if (result.status === 'up-to-date') {
          logger.info('update check: up to date')
          setState({
            phase: 'up-to-date',
            availableVersion: null,
            releaseUrl: null,
            downloadUrl: null,
            progress: null,
            checkedAt: result.checkedAt,
            error: null
          })
          return
        }
        const skipped = !manual && state.skippedVersion === result.version
        logger.info(`update check: ${result.version} available${skipped ? ' (skipped)' : ''}`)
        setState({
          phase: skipped ? 'skipped' : 'available',
          availableVersion: result.version,
          releaseUrl: result.releaseUrl,
          downloadUrl: result.downloadUrl,
          progress: null,
          checkedAt: result.checkedAt,
          error: null
        })
      } catch (error) {
        const failure = asUpdateError(
          error,
          'UPDATE_CHECK_FAILED',
          'Could not check for updates.',
          'updates.error.checkFailed'
        )
        if (manual) {
          logger.error('manual update check failed:', failure.detail ?? failure.message)
          setState({ phase: 'error', progress: null, checkedAt: now(), error: failure })
        } else {
          // Automatic failures stay out of the banner; Settings still shows them.
          logger.warn('automatic update check failed:', failure.detail ?? failure.message)
          setState({
            phase: state.phase === 'skipped' ? 'skipped' : 'idle',
            progress: null,
            checkedAt: now(),
            error: failure
          })
        }
      } finally {
        checkPromise = null
        checkIsManual = false
      }
    })()
    await checkPromise
  }

  async function download(): Promise<void> {
    if (disposed || mode !== 'install') return
    if (state.availableVersion === null) return
    if (state.phase === 'downloading' || state.phase === 'ready') return
    if (state.phase === 'checking' || state.phase === 'restarting') return
    if (downloadPromise !== null) {
      await downloadPromise
      return
    }

    downloadCancelRequested = false
    setState({
      phase: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: null
    })
    logger.info(`downloading update ${state.availableVersion}`)
    downloadPromise = (async () => {
      try {
        const result = await deps.backend.download((progress: UpdateProgress) => {
          if (state.phase === 'downloading') setState({ progress })
        })
        logger.info(`update ${result.version} downloaded`)
        setState({
          phase: 'ready',
          availableVersion: result.version,
          // electron-updater re-checks and may have moved to a newer release
          // than the one our feed check saw. Keep the release link in step.
          releaseUrl: releasePageUrl(result.version),
          progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
          error: null
        })
      } catch (error) {
        if (downloadCancelRequested) {
          logger.info('update download cancelled')
          setState({
            phase: state.availableVersion !== null ? 'available' : 'idle',
            progress: null,
            error: null
          })
          return
        }
        const failure = asUpdateError(
          error,
          'UPDATE_DOWNLOAD_FAILED',
          'Could not download the update.',
          'updates.error.downloadFailed'
        )
        logger.error('update download failed:', failure.detail ?? failure.message)
        setState({ phase: 'error', progress: null, error: failure })
      } finally {
        downloadPromise = null
        downloadCancelRequested = false
      }
    })()
    await downloadPromise
  }

  function resetAfterFailedInstall(error: AppError): void {
    installPending = false
    setState({ phase: 'ready', progress: null, error })
  }

  async function performInstall(stopLiveSessions: boolean): Promise<void> {
    let quiesced = false
    let shutdownStarted = false
    let slept: { slept: number; failed: number; detail?: string | null } | null = null
    try {
      // Fail before any window or session is touched. electron-updater only
      // dispatches an event when its downloaded installer is missing, so this
      // is the last point where the UI can still explain the problem.
      deps.backend.assertInstallable?.()
      const prepared = await deps.windows.prepareForClose()
      if (prepared === 'cancelled') {
        installPending = false
        setState({ phase: 'ready', error: null })
        return
      }
      if (prepared === 'timeout') {
        throw installFailed('The window could not finish saving before the restart.')
      }
      // A normal quit may have begun while the save prompt was open.
      if (disposed) {
        installPending = false
        return
      }

      deps.background.quiesce()
      quiesced = true

      const live = await deps.sessions.listLive()
      if (stopLiveSessions) {
        // Sleep whatever is live now, including sessions that started after the
        // confirmation prompt. A live orphan listed in the prompt is stopped
        // too, because it has no row to resume.
        slept = await deps.sessions.sleepAllLive()
        if (slept.failed > 0) {
          throw installFailed(
            slept.detail ??
              `${slept.failed} live session(s) could not be slept.`
          )
        }
        logger.info(
          `slept ${slept.slept} live session(s) before installing${slept.detail ? `: ${slept.detail}` : ''}`
        )
      } else {
        if (live.length > 0) {
          throw installFailed('New sessions started while preparing the update. Try again.')
        }
        // Narrow the window between "nothing was live" and stopping the host.
        const raced = await deps.sessions.listLive()
        if (raced.length > 0) {
          throw installFailed('New sessions started while preparing the update. Try again.')
        }
      }

      logger.info('stopping terminal hosts before installing')
      await deps.stopTerminalHosts()
      shutdownStarted = true
      await deps.shutdownRuntime()
      // Record the attempt before electron-updater spawns the installer and
      // quits. The next launch compares this target with app.getVersion() and
      // reports an interrupted install when they differ.
      deps.journal?.begin({
        version: UPDATE_JOURNAL_VERSION,
        fromVersion: state.currentVersion,
        toVersion: state.availableVersion ?? state.currentVersion,
        startedAt: now(),
        installerPath: deps.backend.installerPath?.() ?? null
      })
      // The installer may have been quarantined during teardown. Check once
      // more; a failure here still has the relaunch path below.
      deps.backend.assertInstallable?.()
      deps.windows.beginInstall()
      logger.info('running the update installer')
      deps.backend.quitAndInstall()
      installPending = false
    } catch (error) {
      const failure = asUpdateError(
        error,
        'UPDATE_INSTALL_FAILED',
        'Could not install the update.',
        'updates.error.installFailed'
      )
      // Teardown can fail after some sessions were already slept. Say so, or a
      // retry looks like it did nothing while those terminals stay stopped.
      const reportedFailure: AppError =
        slept !== null && slept.slept > 0
          ? {
              ...failure,
              detail:
                `${failure.detail ?? failure.message} ` +
                `${slept.slept} live session(s) were already stopped before this failure.`
            }
          : failure
      if (shutdownStarted) {
        logger.error(
          'update install failed after shutdown; relaunching:',
          reportedFailure.detail
        )
        deps.relaunchAfterFailure()
        return
      }
      if (quiesced) deps.background.resume()
      resetAfterFailedInstall(reportedFailure)
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    start() {
      schedule()
    },

    async check() {
      await check(true)
      return state
    },

    async download() {
      await download()
      return state
    },

    cancelDownload() {
      if (state.phase !== 'downloading') return state
      downloadCancelRequested = true
      logger.info('cancelling update download')
      deps.backend.cancel()
      return state
    },

    async install(input) {
      if (disposed) {
        return { status: 'blocked', error: notReady() }
      }
      if (mode !== 'install') {
        return { status: 'blocked', error: notSupported() }
      }
      if (state.phase !== 'ready' || state.availableVersion === null) {
        return { status: 'blocked', error: notReady() }
      }
      if (installPending) {
        return { status: 'blocked', error: notReady() }
      }
      const preflight = deps.preflightInstall?.() ?? null
      if (preflight !== null) return { status: 'blocked', error: preflight }
      try {
        deps.backend.assertInstallable?.()
      } catch (error) {
        return {
          status: 'blocked',
          error: installFailed(error instanceof Error ? error.message : String(error))
        }
      }

      // Reserve before awaiting the session list: a double-clicked confirm (or
      // two windows) must not schedule two teardowns from the same ready state.
      installPending = true
      let live: UpdateLiveSession[]
      try {
        live = await deps.sessions.listLive()
      } catch (error) {
        installPending = false
        return {
          status: 'blocked',
          error: asUpdateError(
            error,
            'UPDATE_INSTALL_FAILED',
            'Could not inspect running sessions.',
            'updates.error.installFailed'
          )
        }
      }
      if (disposed) {
        installPending = false
        return { status: 'blocked', error: notReady() }
      }

      const version = state.availableVersion
      if (live.length > 0 && input.stopLiveSessions !== true) {
        installPending = false
        return { status: 'confirmation-required', version, liveSessions: live }
      }

      setState({ phase: 'restarting', error: null, progress: null })
      const stopLiveSessions = input.stopLiveSessions === true
      logger.info(
        `installing ${version}; ${live.length} live session(s) listed, ` +
          `stopLiveSessions=${String(stopLiveSessions)}`
      )
      installTimer = setTimeoutFn(() => {
        installTimer = null
        void performInstall(stopLiveSessions)
      }, INSTALL_RESPONSE_DELAY_MS)
      return { status: 'restarting' }
    },

    skip(version) {
      deps.preferences.update({ skippedUpdateVersion: version })
      if (version === null) {
        setState({
          skippedVersion: null,
          // Showing the skipped version again is a deliberate user act.
          ...(state.phase === 'skipped' ? { phase: 'available' as const } : {})
        })
        return state
      }
      const skipped = state.availableVersion === version
      setState({
        skippedVersion: version,
        ...(skipped && (state.phase === 'available' || state.phase === 'skipped')
          ? { phase: 'skipped' as const }
          : {})
      })
      return state
    },

    setAutoCheck(enabled) {
      deps.preferences.update({ updateAutoCheckEnabled: enabled })
      state = { ...state, autoCheck: enabled }
      emit()
      if (enabled) schedule()
      else stopTimers()
      return state
    },

    dispose() {
      disposed = true
      installPending = false
      if (installTimer !== null) clearTimeoutFn(installTimer)
      installTimer = null
      stopTimers()
      deps.backend.dispose()
      listeners.clear()
    }
  }
}
