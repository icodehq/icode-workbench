import { describe, expect, it, vi } from 'vitest'
import {
  RepositoryFolderPicker,
  type FolderDialogOptions,
  type FolderDialogResult
} from './folder-picker'
import type { ExecutionTarget } from '../../shared/domain/repository'

/**
 * Choosing a repository folder.
 *
 * The dialog is a stub here on purpose: what needs proving is the decision — what
 * the dialog is opened at, how a cancelled dialog is reported, and that a pick
 * from the wrong filesystem is refused rather than adopted as a repository path.
 */

const LOCAL: ExecutionTarget = { kind: 'local' }
const WSL: ExecutionTarget = { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: 'reg-1' }

function picker(options: {
  answer: FolderDialogResult | Error
  guestHome?: string | null
  platform?: NodeJS.Platform
}) {
  const showOpenDialog = vi.fn(async (_options: FolderDialogOptions) => {
    if (options.answer instanceof Error) throw options.answer
    return options.answer
  })
  const readGuestHome = vi.fn(async () => options.guestHome ?? null)
  const instance = new RepositoryFolderPicker({
    platform: options.platform ?? 'win32',
    showOpenDialog,
    localHome: () => 'C:\\Users\\tester',
    readGuestHome
  })
  return { instance, showOpenDialog, readGuestHome }
}

describe('local repositories', () => {
  it('opens a directory dialog at the user home and returns the chosen path', async () => {
    const { instance, showOpenDialog } = picker({
      answer: { canceled: false, filePaths: ['D:\\Development\\w87-local'] }
    })
    const result = await instance.pick(LOCAL)

    expect(result).toEqual({ status: 'selected', path: 'D:\\Development\\w87-local' })
    const options = showOpenDialog.mock.calls[0]![0]
    expect(options.properties).toEqual(['openDirectory'])
    expect(options.defaultPath).toBe('C:\\Users\\tester')
    // A local target must not reach into any distro to ask what to show.
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
  })

  it('reports cancellation without inventing a path', async () => {
    const { instance } = picker({ answer: { canceled: true, filePaths: [] } })
    expect(await instance.pick(LOCAL)).toEqual({ status: 'cancelled' })
  })

  it('refuses a distro folder reached through the local picker', async () => {
    // The Windows shell lets this dialog wander into \\wsl.localhost; recording
    // that as a local repository would put a distro path on this machine.
    const { instance } = picker({
      answer: { canceled: false, filePaths: ['\\\\wsl.localhost\\Ubuntu-26.04\\home\\you\\repo'] }
    })
    const result = await instance.pick(LOCAL)
    if (result.status !== 'unavailable') throw new Error('expected a refusal')
    expect(result.reason).toBe('wrong_filesystem')
    expect(result.detail).toContain('Ubuntu-26.04')
    expect(result.detail).toContain('Choose WSL')
  })

  it('reports a dialog failure as unavailable', async () => {
    const { instance } = picker({ answer: new Error('shell unavailable') })
    const result = await instance.pick(LOCAL)
    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') {
      expect(result.reason).toBe('dialog_failed')
      expect(result.detail).toContain('shell unavailable')
    }
  })
})

describe('WSL repositories', () => {
  it('starts the dialog inside that distro and returns a Linux path', async () => {
    const { instance, showOpenDialog, readGuestHome } = picker({
      answer: { canceled: false, filePaths: ['\\\\wsl.localhost\\Ubuntu-26.04\\home\\you\\repo'] },
      guestHome: '/home/you'
    })
    const result = await instance.pick(WSL)

    expect(readGuestHome).toHaveBeenCalledWith('Ubuntu-26.04')
    expect(showOpenDialog.mock.calls[0]![0].defaultPath).toBe(
      '\\\\wsl.localhost\\Ubuntu-26.04\\home\\you'
    )
    // The Windows spelling is never what gets registered.
    expect(result).toEqual({ status: 'selected', path: '/home/you/repo' })
  })

  it('returns a Windows drive pick for the path resolver', async () => {
    /*
     * Windows denies browsing `\\wsl.localhost\<distro>\mnt\d`, so a drive pick
     * is the only spelling the native WSL dialog can produce for a project on
     * D:. Returning it is not acceptance: the project-folder service translates
     * it with `wslpath` and rejects an unmounted drive before registration.
     */
    const { instance } = picker({
      answer: { canceled: false, filePaths: ['D:\\Development\\w87-local'] },
      guestHome: '/home/you'
    })
    expect(await instance.pick(WSL)).toEqual({
      status: 'selected',
      path: 'D:\\Development\\w87-local'
    })
  })

  it('browses Windows drives for a WSL target without asking for the guest home', async () => {
    const { instance, showOpenDialog, readGuestHome } = picker({
      answer: { canceled: false, filePaths: ['D:\\Development\\w87-local'] },
      guestHome: null
    })
    const result = await instance.pick(WSL, { source: 'windows' })

    expect(result).toEqual({ status: 'selected', path: 'D:\\Development\\w87-local' })
    expect(readGuestHome).not.toHaveBeenCalled()
    expect(showOpenDialog.mock.calls[0]![0].defaultPath).toBe('C:\\Users\\tester')
    expect(showOpenDialog.mock.calls[0]![0].title).toContain('Ubuntu-26.04')
  })

  it('states the Windows-only limitation for the Windows drive source', async () => {
    const { instance, showOpenDialog } = picker({
      answer: { canceled: false, filePaths: [] },
      guestHome: '/home/you',
      platform: 'linux'
    })
    const result = await instance.pick(WSL, { source: 'windows' })
    expect(showOpenDialog).not.toHaveBeenCalled()
    if (result.status !== 'unavailable') throw new Error('expected a refusal')
    expect(result.reason).toBe('not_windows')
  })

  it('refuses a folder in a different distro and names it', async () => {
    const { instance } = picker({
      answer: { canceled: false, filePaths: ['\\\\wsl.localhost\\Debian\\home\\you'] },
      guestHome: '/home/you'
    })
    const result = await instance.pick(WSL)
    if (result.status !== 'unavailable') throw new Error('expected a refusal')
    expect(result.reason).toBe('wrong_filesystem')
    expect(result.detail).toContain('Debian')
    expect(result.detail).toContain('Ubuntu-26.04')
  })

  it('does not open a dialog when the distro cannot report its home', async () => {
    const { instance, showOpenDialog } = picker({
      answer: { canceled: false, filePaths: [] },
      guestHome: null
    })
    const result = await instance.pick(WSL)
    expect(showOpenDialog).not.toHaveBeenCalled()
    if (result.status !== 'unavailable') throw new Error('expected a refusal')
    expect(result.reason).toBe('guest_home_unknown')
    expect(result.detail).toContain('by hand')
  })

  it('states the platform limitation rather than faking a browser on other OSes', async () => {
    const { instance, showOpenDialog } = picker({
      answer: { canceled: false, filePaths: [] },
      guestHome: '/home/you',
      platform: 'linux'
    })
    const result = await instance.pick(WSL)
    expect(showOpenDialog).not.toHaveBeenCalled()
    if (result.status !== 'unavailable') throw new Error('expected a refusal')
    expect(result.reason).toBe('not_windows')
    expect(result.detail).toContain('by hand')
  })

  it('reports cancellation', async () => {
    const { instance } = picker({ answer: { canceled: true, filePaths: [] }, guestHome: '/home/you' })
    expect(await instance.pick(WSL)).toEqual({ status: 'cancelled' })
  })
})
