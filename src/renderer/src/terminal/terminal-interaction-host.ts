import type { SessionSummary } from '../../../shared/schemas/ipc'

/**
 * App services a terminal instance may use. Instances live outside React, so
 * these are injected once and read through the provider's stable proxy.
 */

export type TerminalNotice = {
  tone: 'info' | 'success' | 'error'
  message: string
}

export type TerminalInteractionHost = {
  /** Open a worktree-relative file in the Files surface. */
  openFile(path: string, line?: number): void
  openExternal(url: string): Promise<void>
  notify(notice: TerminalNotice): void
  getSession(sessionId: string): SessionSummary | null
  /** True only when the session-scoped file exists. */
  statFile(sessionId: string, path: string): Promise<boolean>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<boolean>
  sendToAgent(
    sessionId: string,
    text: string
  ): Promise<{ ok: true } | { ok: false; message: string }>
}

export type TerminalMetadata = {
  /** Live shell cwd once the host reports OSC 7; null before then. */
  cwd: string | null
  title: string | null
}

export type TerminalFindDirection = 'next' | 'previous'

export type TerminalFindOptions = {
  caseSensitive?: boolean
  regex?: boolean
}

export type TerminalInteractionState = {
  hasSelection: boolean
}

export type TerminalTranscriptOptions = {
  maxChars?: number
}

/**
 * Stable host for instances that outlive React views.
 *
 * App callbacks change identity as navigation state moves; the proxy reads the
 * current host at call time so terminals never need to be recreated.
 */
export function createTerminalInteractionHostProxy(
  getHost: () => TerminalInteractionHost | null
): TerminalInteractionHost {
  const current = (): TerminalInteractionHost | null => {
    try {
      return getHost()
    } catch {
      return null
    }
  }
  return {
    openFile: (path, line) => current()?.openFile(path, line),
    openExternal: async (url) => {
      await current()?.openExternal(url)
    },
    notify: (notice) => current()?.notify(notice),
    getSession: (sessionId) => current()?.getSession(sessionId) ?? null,
    statFile: async (sessionId, path) => (await current()?.statFile(sessionId, path)) ?? false,
    readClipboard: async () => (await current()?.readClipboard()) ?? '',
    writeClipboard: async (text) => (await current()?.writeClipboard(text)) ?? false,
    sendToAgent: async (sessionId, text) =>
      (await current()?.sendToAgent(sessionId, text)) ?? {
        ok: false,
        message: 'The terminal is not connected.'
      }
  }
}
