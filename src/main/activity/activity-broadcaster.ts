import { BrowserWindow, Notification } from 'electron'
import type { ActivityTransition } from './activity-service'
import { IPC_CHANNELS } from '../../shared/schemas/ipc'
import type { ActivityEvent } from '../../shared/schemas/activity'

export type ActivityBroadcasterOptions = {
  /** Test seam; production uses `Notification`. */
  notify?: (title: string, body: string, sessionId: string) => void
  isAnyWindowFocused?: () => boolean
  /** Test seam; production sends to every BrowserWindow. */
  send?: (event: ActivityEvent) => void
  log?: (message: string) => void
}

/**
 * Pushes activity to renderers and raises at most one OS notification per
 * logical transition into `done` or `waiting`, and only while no iCode window has
 * focus. Duplicate hook delivery cannot notify twice because the service only
 * reports an `attention` value for an accepted state change.
 */
export class ActivityBroadcaster {
  private readonly notify: (title: string, body: string, sessionId: string) => void
  private readonly isAnyWindowFocused: () => boolean
  private readonly send: (event: ActivityEvent) => void
  private readonly log: (message: string) => void
  private lastAttention = new Map<string, { fingerprint: string; at: number }>()

  constructor(options: ActivityBroadcasterOptions = {}) {
    this.isAnyWindowFocused =
      options.isAnyWindowFocused ??
      (() => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()))
    this.log = options.log ?? ((message) => process.stderr.write(`[icode] ${message}\n`))
    this.send =
      options.send ??
      ((event) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed() || window.webContents.isDestroyed()) continue
          window.webContents.send(IPC_CHANNELS.sessionEvent, event)
        }
      })
    this.notify =
      options.notify ??
      ((title, body, sessionId) => {
        if (!Notification.isSupported()) return
        const notification = new Notification({ title, body })
        notification.on('click', () => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window || window.isDestroyed()) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          window.webContents.send(IPC_CHANNELS.sessionEvent, {
            type: 'activity-focus',
            sessionId
          })
        })
        notification.show()
      })
  }

  handle(transition: ActivityTransition, title: string): void {
    this.broadcast(transition)
    if (transition.attention === null) return
    if (this.isAnyWindowFocused()) {
      this.lastAttention.delete(transition.sessionId)
      return
    }

    // One notification per logical transition: a repeated identical attention
    // state that keeps its timestamp is not a new event.
    const fingerprint = `${transition.attention}:${String(transition.next.since)}`
    const previous = this.lastAttention.get(transition.sessionId)
    if (previous && previous.fingerprint === fingerprint) return
    this.lastAttention.set(transition.sessionId, { fingerprint, at: Date.now() })

    const body =
      transition.attention === 'done'
        ? transition.next.outcome === 'failed'
          ? 'The agent stopped with an error.'
          : 'The agent finished.'
        : transition.next.toolName && transition.next.toolName !== ''
          ? `Waiting for you · ${transition.next.toolName}`
          : 'The agent needs your input.'

    try {
      this.notify(title, body, transition.sessionId)
    } catch (error) {
      this.log(`activity notification failed: ${String(error)}`)
    }
  }

  forget(sessionId: string): void {
    this.lastAttention.delete(sessionId)
  }

  private broadcast(transition: ActivityTransition): void {
    const event: ActivityEvent = {
      type: 'activity',
      sessionId: transition.sessionId as ActivityEvent['sessionId'],
      activity: transition.next
    }
    try {
      this.send(event)
    } catch (error) {
      this.log(`activity broadcast failed: ${String(error)}`)
    }
  }
}
