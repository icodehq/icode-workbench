import { HostRequestError } from '../host/host-client'
import type { HostTarget } from './host-gateway'
import type {
  CreateOrAttachPayload,
  HostEvent,
  ListSessionsPayload,
  SessionInfo,
  TerminalSnapshot
} from '../../shared/host-protocol'
import type { HostGateway } from './host-gateway'

export type FakeSession = {
  info: SessionInfo
  snapshot: TerminalSnapshot
}

function emptySnapshot(cols: number, rows: number): TerminalSnapshot {
  return {
    data: '',
    cols,
    rows,
    seq: 0,
    alternateScreen: false,
    cursor: { x: 0, y: 0 },
    scrollbackLines: 0,
    truncated: false
  }
}

/**
 * Deterministic host double for orchestration tests. It mirrors incarnation
 * semantics and emits the same events as the real host protocol.
 */
export class FakeHostGateway implements HostGateway {
  readonly sessions = new Map<string, FakeSession>()
  readonly calls = {
    createOrAttach: [] as Array<{
      sessionId: string
      attachOnly: boolean
      command: string
      cwd: string
      args: string[]
      /** Which host served the call: `local` or the distro's registration. */
      host: string
    }>,
    write: [] as Array<{ sessionId: string; incarnationId: string; data: string }>,
    resize: [] as Array<{
      sessionId: string
      incarnationId: string
      cols: number
      rows: number
      host: string
    }>,
    kill: [] as Array<{ sessionId: string; host: string }>,
    listSessions: 0
  }

  reachable = true
  /**
   * Fail only one host, so multi-host reconciliation can be tested. `null` fails
   * everything through `reachable`.
   */
  failForTarget: 'local' | 'wsl' | null = null
  failNextSpawn: Error | null = null
  private nextPid = 6000
  private nextIncarnation = 1
  private listeners = new Set<(event: HostEvent) => void>()

  private assertTarget(target?: HostTarget): void {
    if (this.failForTarget === null) return
    const isLocal = target === undefined || target.kind === 'local'
    if (this.failForTarget === 'local' ? isLocal : !isLocal) {
      throw new HostRequestError('HOST_CONNECT_FAILED', 'Fake host is unreachable for this target')
    }
  }

  private ensureReachable(): void {
    if (!this.reachable) {
      throw new HostRequestError('HOST_CONNECT_FAILED', 'Fake host is unreachable')
    }
  }

  seedSession(
    sessionId: string,
    options: { status?: SessionInfo['status']; exitCode?: number | null; cols?: number; rows?: number } = {}
  ): FakeSession {
    const info: SessionInfo = {
      sessionId,
      incarnationId: `incarnation${String(this.nextIncarnation++).padStart(7, '0')}`,
      ptyPid: this.nextPid++,
      cwd: process.cwd(),
      command: '/bin/bash',
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      status: options.status ?? 'live',
      exitCode: options.exitCode ?? null,
      stopRequested: false,
      createdAt: Date.now()
    }
    const session = { info, snapshot: emptySnapshot(info.cols, info.rows) }
    this.sessions.set(sessionId, session)
    return session
  }

  async createOrAttach(params: {
    sessionId: string
    cwd: string
    command: string
    args?: string[]
    cols: number
    rows: number
    attachOnly?: boolean
  }, target?: HostTarget): Promise<CreateOrAttachPayload> {
    this.assertTarget(target)
    this.ensureReachable()
    this.calls.createOrAttach.push({
      sessionId: params.sessionId,
      attachOnly: params.attachOnly === true,
      command: params.command,
      cwd: params.cwd,
      args: params.args ?? [],
      host:
        target === undefined || target.kind === 'local'
          ? 'local'
          : `wsl:${target.distro}:${target.distroId ?? ''}`
    })

    const existing = this.sessions.get(params.sessionId)
    const finished = existing && (existing.info.status === 'exited' || existing.info.status === 'failed')

    if (existing && !finished) {
      return { ...existing.info, created: false, snapshot: existing.snapshot }
    }
    if (params.attachOnly) {
      if (existing) {
        return { ...existing.info, created: false, snapshot: existing.snapshot }
      }
      throw new HostRequestError('SESSION_NOT_FOUND', 'Session is not known to the host')
    }
    if (this.failNextSpawn) {
      const error = this.failNextSpawn
      this.failNextSpawn = null
      throw error
    }

    const info: SessionInfo = {
      sessionId: params.sessionId,
      incarnationId: `incarnation${String(this.nextIncarnation++).padStart(7, '0')}`,
      ptyPid: this.nextPid++,
      cwd: params.cwd,
      command: params.command,
      cols: params.cols,
      rows: params.rows,
      status: 'live',
      exitCode: null,
      stopRequested: false,
      createdAt: Date.now()
    }
    const session = { info, snapshot: emptySnapshot(params.cols, params.rows) }
    this.sessions.set(params.sessionId, session)
    this.emit({
      type: 'event',
      event: 'spawned',
      sessionId: info.sessionId,
      incarnationId: info.incarnationId,
      ptyPid: info.ptyPid
    })
    return { ...info, created: true, snapshot: session.snapshot }
  }

  async write(
    sessionId: string,
    incarnationId: string,
    data: string,
    _target?: HostTarget
  ): Promise<void> {
    this.ensureReachable()
    const session = this.sessions.get(sessionId)
    if (!session) throw new HostRequestError('SESSION_NOT_FOUND', 'Unknown session')
    if (session.info.incarnationId !== incarnationId) {
      throw new HostRequestError('STALE_INCARNATION', 'Stale incarnation')
    }
    if (session.info.status !== 'live') {
      throw new HostRequestError('BAD_REQUEST', 'Session is not live')
    }
    this.calls.write.push({ sessionId, incarnationId, data })
  }

  async resize(
    sessionId: string,
    incarnationId: string,
    cols: number,
    rows: number,
    target?: HostTarget
  ): Promise<void> {
    this.assertTarget(target)
    this.ensureReachable()
    const session = this.sessions.get(sessionId)
    if (!session) throw new HostRequestError('SESSION_NOT_FOUND', 'Unknown session')
    if (session.info.incarnationId !== incarnationId) {
      throw new HostRequestError('STALE_INCARNATION', 'Stale incarnation')
    }
    session.info.cols = cols
    session.info.rows = rows
    this.calls.resize.push({
      sessionId,
      incarnationId,
      cols,
      rows,
      host: target === undefined || target.kind === 'local' ? 'local' : `wsl:${target.distro}`
    })
  }

  async kill(sessionId: string, target?: HostTarget): Promise<void> {
    this.assertTarget(target)
    this.ensureReachable()
    const session = this.sessions.get(sessionId)
    if (!session) throw new HostRequestError('SESSION_NOT_FOUND', 'Unknown session')
    this.calls.kill.push({
      sessionId,
      host: target === undefined || target.kind === 'local' ? 'local' : `wsl:${target.distro}`
    })
    session.info.stopRequested = true
    // Mirror node-pty: a kill surfaces SIGHUP (129), not a clean zero exit.
    this.finish(sessionId, 129, true)
  }

  async listSessions(target?: HostTarget): Promise<ListSessionsPayload> {
    this.assertTarget(target)
    this.ensureReachable()
    this.calls.listSessions += 1
    return {
      hostPid: 6000,
      startedAt: 1,
      sessions: [...this.sessions.values()].map((session) => ({ ...session.info })),
      liveSessions: [...this.sessions.values()].filter((session) => session.info.status === 'live')
        .length,
      connectedClients: 1
    }
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  disconnect(): void {
    this.listeners.clear()
  }

  emitData(sessionId: string, data: string, incarnationId?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown fake session ${sessionId}`)
    session.snapshot = { ...session.snapshot, seq: session.snapshot.seq + 1, data: session.snapshot.data + data }
    this.emit({
      type: 'event',
      event: 'data',
      sessionId,
      incarnationId: incarnationId ?? session.info.incarnationId,
      seq: session.snapshot.seq,
      data
    })
  }

  finish(sessionId: string, exitCode: number, requested = sessionRequested(this, sessionId)): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown fake session ${sessionId}`)
    session.info.status = requestIsClean(exitCode, requested) ? 'exited' : 'failed'
    session.info.exitCode = exitCode
    session.info.stopRequested = requested
    this.emit({
      type: 'event',
      event: 'exit',
      sessionId,
      incarnationId: session.info.incarnationId,
      exitCode,
      ...(requested ? { requested: true } : {})
    })
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function sessionRequested(host: FakeHostGateway, sessionId: string): boolean {
  return host.sessions.get(sessionId)?.info.stopRequested === true
}

function requestIsClean(exitCode: number, requested: boolean): boolean {
  return exitCode === 0 || requested
}
