import { describe, expect, it, vi } from 'vitest'

/**
 * Every request channel the product defines must be registered.
 *
 * This is a guard rather than a behaviour test: `register.ts` registers handlers
 * from one list, and the preload calls channels from the shared enum. Adding a
 * channel to the enum and its handler to the dispatcher while forgetting the
 * list produces a runtime `No handler registered for …` — which is exactly how
 * the repository folder picker failed on its first real launch. The assertion is
 * cheap and would have caught that before the app ever started.
 *
 * Electron is stubbed because importing the registration module loads it.
 */
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/ade-app',
    getPath: () => '/tmp/ade-profile'
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: vi.fn() }
}))

const { HANDLED_CHANNELS } = await import('./register')
const { IPC_CHANNELS } = await import('../../shared/schemas/ipc')

describe('IPC channel registration', () => {
  it('registers a handler for every request channel', () => {
    // Push-only channels travel main → renderer, so nothing invokes them.
    const pushOnly = new Set<string>([
      IPC_CHANNELS.sessionEvent,
      IPC_CHANNELS.taskEvent,
      IPC_CHANNELS.reposEvent,
      IPC_CHANNELS.viewCommand,
      IPC_CHANNELS.windowMaximizedEvent,
      IPC_CHANNELS.gitStatusEvent
    ])
    /**
     * Handled at the app entry point instead of here.
     *
     * `runtimeInfo` is registered directly by `src/main/index.ts` because it only
     * reports the running build. It is listed explicitly — with that file as the
     * evidence — so this guard still covers every other channel.
     */
    const registeredElsewhere = new Set<string>([IPC_CHANNELS.runtimeInfo])
    const requestChannels = Object.entries(IPC_CHANNELS)
      .filter(
        ([name, channel]) =>
          !pushOnly.has(channel) && !registeredElsewhere.has(channel) && !/Event$/u.test(name)
      )
      .map(([name, channel]) => ({ name, channel }))

    const missing = requestChannels.filter((entry) => !HANDLED_CHANNELS.includes(entry.channel))
    expect(missing.map((entry) => `${entry.name} (${entry.channel})`)).toEqual([])
  })

  it('does not register the same channel twice', () => {
    expect(new Set(HANDLED_CHANNELS).size).toBe(HANDLED_CHANNELS.length)
  })

  it('does not handle a channel that is not part of the contract', () => {
    const known = new Set<string>(Object.values(IPC_CHANNELS))
    expect(HANDLED_CHANNELS.filter((channel) => !known.has(channel))).toEqual([])
  })
})
