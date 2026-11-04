import type { ExecutionTarget } from '../../shared/domain/repository'
import { fromWslUncPath, parseWslUnc, toWslUncPath } from '../wsl/unc-path'

/**
 * Choosing a repository folder with the platform's own dialog.
 *
 * The dialog is injected rather than imported so this module stays a pure
 * decision: what to start the dialog at, and what the answer means for the
 * execution target. Only the composition root touches Electron, and the tests
 * below can drive every branch without a real shell window.
 *
 * The target is never inferred from the picked path. A Windows picker browsing a
 * distro's filesystem answers with a Windows spelling; translating it back is
 * safe only because it is checked against the distro that was asked for.
 */

export type FolderDialogResult = { canceled: boolean; filePaths: string[] }

export type FolderDialogOptions = {
  title: string
  defaultPath?: string
  properties: ['openDirectory']
}

export type PickFolderResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  /**
   * The dialog could not be offered, or its answer cannot be used for this
   * target. `reason` is stable so the renderer can choose its wording, and
   * `detail` is a sentence the user can act on.
   */
  | {
      status: 'unavailable'
      reason: 'not_windows' | 'guest_home_unknown' | 'dialog_failed' | 'wrong_filesystem'
      detail: string
    }

export type FolderPickerDeps = {
  platform?: NodeJS.Platform
  showOpenDialog: (options: FolderDialogOptions) => Promise<FolderDialogResult>
  /** The machine's home directory, used as the local dialog's starting point. */
  localHome: () => string
  /** The distro's `$HOME`, read inside the distro. `null` when it could not be read. */
  readGuestHome: (distro: string) => Promise<string | null>
}

export type PickFolderOptions = {
  /**
   * For a WSL target, where the project is stored.
   *
   * `wsl` browses the distro's own filesystem through `\\wsl.localhost`.
   * `windows` opens the native Windows dialog so a project on C:/D:/… can be
   * selected; the caller translates the Windows spelling into the distro.
   */
  source?: 'wsl' | 'windows'
}

export class RepositoryFolderPicker {
  constructor(private readonly deps: FolderPickerDeps) {}

  async pick(
    target: ExecutionTarget,
    options: PickFolderOptions = {}
  ): Promise<PickFolderResult> {
    const platform = this.deps.platform ?? process.platform
    if (target.kind === 'local') return this.pickLocal()

    if (options.source === 'windows') return this.pickWindowsForWsl(target)

    /*
     * A WSL target can only be browsed by Windows: `\\wsl.localhost` is a Windows
     * shell namespace. Elsewhere there is no native way to show that filesystem,
     * and inventing one would be the fragile workaround this flow avoids — so the
     * limitation is stated instead of worked around.
     */
    if (platform !== 'win32') {
      return {
        status: 'unavailable',
        reason: 'not_windows',
        detail:
          'Browsing a distro folder needs Windows. Enter the Linux path by hand on this machine.'
      }
    }

    const home = await this.deps.readGuestHome(target.distro).catch(() => null)
    if (home === null || home.trim().length === 0) {
      return {
        status: 'unavailable',
        reason: 'guest_home_unknown',
        detail: `${target.distro} did not report a home directory, so the picker has nowhere to start. Enter the Linux path by hand, or check that the distro is installed.`
      }
    }

    const start = toWslUncPath(home, target.distro)
    if (start === null) {
      return {
        status: 'unavailable',
        reason: 'guest_home_unknown',
        detail: `${target.distro} reported a home directory that is not a Linux path.`
      }
    }

    let picked: FolderDialogResult
    try {
      picked = await this.deps.showOpenDialog({
        title: `Select a folder inside ${target.distro}`,
        defaultPath: start,
        properties: ['openDirectory']
      })
    } catch (error) {
      return { status: 'unavailable', reason: 'dialog_failed', detail: messageOf(error) }
    }
    const chosen = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (chosen === null) return { status: 'cancelled' }

    const translation = fromWslUncPath(chosen, target.distro)
    if (translation.kind === 'linux') return { status: 'selected', path: translation.path }
    if (translation.kind === 'windows-drive') {
      /*
       * A drive path selected from this dialog is still a candidate for a WSL
       * project. Windows denies browsing the mounted drive through
       * `\\wsl.localhost`, so the Windows spelling is the only one the native
       * dialog can return; the project-folder service translates it with
       * `wslpath`. Returning it here is not acceptance — a wrong or unmounted
       * drive is rejected by that resolver before it is recorded.
       */
      return { status: 'selected', path: chosen }
    }
    if (translation.kind === 'other-distro') {
      return {
        status: 'unavailable',
        reason: 'wrong_filesystem',
        detail: `That folder is inside ${translation.distro}, not ${target.distro}.`
      }
    }
    return {
      status: 'unavailable',
      reason: 'wrong_filesystem',
      detail: `Choose a folder inside \\\\wsl.localhost\\${target.distro}, which is where ${target.distro} keeps its files.`
    }
  }

  /**
   * Browses the Windows filesystem for a project that will run in a WSL distro.
   *
   * A native dialog is the only reliable way to see Windows drives: the WSL UNC
   * namespace denies access to `/mnt/<drive>`, so asking the WSL browser to
   * enter that mount produces an access-denied dead end. The returned Windows
   * path is translated by the service, never registered as-is.
   */
  private async pickWindowsForWsl(
    target: Extract<ExecutionTarget, { kind: 'wsl' }>
  ): Promise<PickFolderResult> {
    const platform = this.deps.platform ?? process.platform
    if (platform !== 'win32') {
      return {
        status: 'unavailable',
        reason: 'not_windows',
        detail:
          'Choosing a Windows folder needs Windows. Enter the Linux path by hand on this machine.'
      }
    }

    let picked: FolderDialogResult
    try {
      picked = await this.deps.showOpenDialog({
        title: `Select a Windows folder to use in ${target.distro}`,
        defaultPath: this.deps.localHome(),
        properties: ['openDirectory']
      })
    } catch (error) {
      return { status: 'unavailable', reason: 'dialog_failed', detail: messageOf(error) }
    }
    const chosen = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (chosen === null) return { status: 'cancelled' }
    return { status: 'selected', path: chosen }
  }

  private async pickLocal(): Promise<PickFolderResult> {
    let picked: FolderDialogResult
    try {
      picked = await this.deps.showOpenDialog({
        title: 'Select a Git repository folder',
        defaultPath: this.deps.localHome(),
        properties: ['openDirectory']
      })
    } catch (error) {
      return { status: 'unavailable', reason: 'dialog_failed', detail: messageOf(error) }
    }
    const chosen = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (chosen === null) return { status: 'cancelled' }

    /*
     * The local dialog can be navigated into a distro through Windows' own
     * `\\wsl.localhost` namespace. Registering that folder as *local* would put a
     * distro path on this machine's execution target, so it is refused with the
     * correction instead of being accepted because the shell allowed it.
     */
    const wslPick = parseWslUnc(chosen)
    if (wslPick !== null) {
      return {
        status: 'unavailable',
        reason: 'wrong_filesystem',
        detail: `That folder is inside ${wslPick.distro}. Choose WSL and ${wslPick.distro} instead, so it is registered with the right execution target.`
      }
    }

    // The dialog answers with the platform's own absolute path; it is handed on
    // unchanged so the repository service sees exactly what the user chose.
    return { status: 'selected', path: chosen }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
