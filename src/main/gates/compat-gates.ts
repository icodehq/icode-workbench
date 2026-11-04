import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { HostSupervisor } from '../host/host-supervisor'
import type { HostClient } from '../host/host-client'
import type { HostEvent } from '../../shared/host-protocol'
import type { ActivityHookEvent } from '../../shared/domain/activity'
import { activitySocketPath } from '../activity/endpoint'
import { installClaudeHooks } from '../activity/claude-hooks'
import { ActivityHookServer } from '../activity/hook-server'
import { createHarnessDetector } from '../harness/harness-detector'
import { resolvedShellCommand } from '../harness/default-shell'

const SHELL = resolvedShellCommand()
// The marker command is valid in bash, zsh, PowerShell, and cmd. Bash-only
// flags such as --noprofile would break the other shells.
const SHELL_ARGS: string[] = []

export function artifactDir(): string {
  return process.env.ICODE_GATE_ARTIFACTS ?? join(process.cwd(), 'artifacts', 'work1')
}

function writeEvidence(name: string, value: unknown): string {
  const dir = artifactDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

function runtimeFacts(): Record<string, unknown> {
  return {
    capturedAt: new Date().toISOString(),
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    modules: process.versions.modules,
    chrome: process.versions.chrome ?? null,
    sqlite: process.versions.sqlite ?? null,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export type SqliteProbe = {
  dbPath: string
  journalMode: string
  sqliteVersion: string
  committedRows: number
  rolledBackRows: number
  integrity: string
}

export function runSqliteProbe(dbPath: string): SqliteProbe {
  mkdirSync(dirname(dbPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  const db = new DatabaseSync(dbPath)
  try {
    const journal = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string }
    db.exec('CREATE TABLE gate_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('BEGIN')
    db.prepare('INSERT INTO gate_rows (id, value) VALUES (?, ?)').run(1, 'one')
    db.prepare('INSERT INTO gate_rows (id, value) VALUES (?, ?)').run(2, 'two')
    db.exec('COMMIT')

    db.exec('BEGIN')
    db.prepare('INSERT INTO gate_rows (id, value) VALUES (?, ?)').run(3, 'rolled-back')
    db.exec('ROLLBACK')

    const count = db.prepare('SELECT COUNT(*) AS count FROM gate_rows').get() as { count: number }
    const rolled = db
      .prepare('SELECT COUNT(*) AS count FROM gate_rows WHERE id = 3')
      .get() as { count: number }
    const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    return {
      dbPath,
      journalMode: journal.journal_mode ?? 'unknown',
      sqliteVersion: version.version,
      committedRows: Number(count.count),
      rolledBackRows: Number(rolled.count),
      integrity: integrity.integrity_check
    }
  } finally {
    db.close()
  }
}

export type PtyProbe = {
  shell: string
  ptyPid: number
  output: string
  exitCode: number
  signal?: number
}

export async function runPtyProbe(cwd: string): Promise<PtyProbe> {
  return new Promise((resolve, reject) => {
    const term = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    let output = ''
    const timer = setTimeout(() => {
      try {
        term.kill()
      } catch {
        // already gone
      }
      reject(new Error(`PTY probe timed out. Output so far: ${JSON.stringify(output.slice(-500))}`))
    }, 10_000)
    term.onData((data) => {
      output += data
    })
    term.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      resolve({
        shell: SHELL,
        ptyPid: term.pid,
        output,
        exitCode,
        ...(signal ? { signal } : {})
      })
    })
    // PowerShell's line editor treats \n as a continuation; a PTY Enter is \r.
    term.write(`echo GOT:hello; exit 7${process.platform === 'win32' ? '\r' : '\n'}`)
  })
}

function waitForEvent(
  client: HostClient,
  predicate: (event: HostEvent) => boolean,
  timeoutMs = 10_000
): Promise<HostEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('Timed out waiting for terminal host event'))
    }, timeoutMs)
    const off = client.onEvent((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      off()
      resolve(event)
    })
  })
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

type HostStartEvidence = {
  hostPid: number
  socket: string
  sessionId: string
  incarnationId: string
  ptyPid: number
  marker: string
}

async function startHostSession(
  supervisor: HostSupervisor,
  sessionId: string,
  marker: string
): Promise<{ client: HostClient; session: HostStartEvidence }> {
  const client = await supervisor.ensure()
  const info = await client.createOrAttach({
    sessionId,
    cwd: process.cwd(),
    command: SHELL,
    args: SHELL_ARGS,
    cols: 100,
    rows: 30
  })
  assert(info.status === 'live', `Session did not become live (status=${info.status})`)
  assert(info.ptyPid > 0, 'Host did not report a PTY pid')
  const event = waitForEvent(
    client,
    (event) =>
      event.event === 'data' &&
      event.sessionId === sessionId &&
      event.incarnationId === info.incarnationId &&
      event.data.includes(marker)
  )
  await client.write(sessionId, info.incarnationId, `echo ${marker}; sleep 300\n`)
  await event
  assert(client.info, 'Host client is missing handshake info')
  return {
    client,
    session: {
      hostPid: client.info.hostPid,
      socket: supervisor.socketPath,
      sessionId,
      incarnationId: info.incarnationId,
      ptyPid: info.ptyPid,
      marker,
    }
  }
}

function failed(error: unknown): { error: string; detail?: string; stack?: string } {
  const detail =
    error && typeof error === 'object' && 'detail' in error
      ? (error as { detail?: unknown }).detail
      : undefined
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
  }
}

/** Check 1: SQLite inside the Electron main process. */
export async function gateSqlite(): Promise<void> {
  try {
    const probe = runSqliteProbe(join(artifactDir(), 'sqlite', 'icode-gate.db'))
    assert(probe.journalMode.toLowerCase() === 'wal', `Expected WAL, got ${probe.journalMode}`)
    assert(probe.committedRows === 2, `Expected 2 committed rows, got ${probe.committedRows}`)
    assert(probe.rolledBackRows === 0, 'Rolled-back row is visible')
    assert(probe.integrity === 'ok', `Integrity check failed: ${probe.integrity}`)
    writeEvidence('sqlite-gate.json', { ok: true, runtime: runtimeFacts(), probe })
    app.exit(0)
  } catch (error) {
    writeEvidence('sqlite-gate.json', { ok: false, runtime: runtimeFacts(), ...failed(error) })
    app.exit(1)
  }
  await new Promise<void>(() => {})
}

/** Checks 3a: start a detached host session, then exit the Electron app. */
export async function gateHostStart(): Promise<void> {
  try {
    const supervisor = new HostSupervisor(process.env.ICODE_HOST_DIR)
    const sessionId = `gate-host-${Date.now()}`
    const marker = `ICODE_GATE_HOST_MARKER_${randomUUID().slice(0, 8)}`
    const { client, session } = await startHostSession(supervisor, sessionId, marker)
    writeEvidence('host-start.json', {
      ok: true,
      runtime: runtimeFacts(),
      hostDir: supervisor.directory,
      logPath: supervisor.logPath,
      session
    })
    client.close()
    app.exit(0)
  } catch (error) {
    writeEvidence('host-start.json', { ok: false, runtime: runtimeFacts(), ...failed(error) })
    app.exit(1)
  }
  await new Promise<void>(() => {})
}

/** Check 4: a fresh Electron app reattaches without spawning a duplicate. */
export async function gateReattach(): Promise<void> {
  try {
    const start = readJson<{ ok: boolean; session: HostStartEvidence }>(
      join(artifactDir(), 'host-start.json')
    )
    assert(start.ok, 'host-start evidence is not ok')
    const supervisor = new HostSupervisor(process.env.ICODE_HOST_DIR)
    const client = await supervisor.ensure()
    assert(client.info, 'No host info after connect')
    const before = await client.listSessions()
    const entries = before.sessions.filter((session) => session.sessionId === start.session.sessionId)
    assert(entries.length === 1, `Expected exactly one host session, got ${entries.length}`)

    const attached = await client.createOrAttach({
      sessionId: start.session.sessionId,
      cwd: process.cwd(),
      command: SHELL,
      args: SHELL_ARGS,
      cols: 100,
      rows: 30,
      attachOnly: true
    })
    assert(attached.created === false, 'Reattach created a new PTY')
    assert(
      attached.incarnationId === start.session.incarnationId,
      `Incarnation changed: ${start.session.incarnationId} -> ${attached.incarnationId}`
    )
    assert(
      attached.ptyPid === start.session.ptyPid,
      `PTY pid changed: ${start.session.ptyPid} -> ${attached.ptyPid}`
    )

    const marker = `ICODE_GATE_REATTACH_MARKER_${randomUUID().slice(0, 8)}`
    const event = waitForEvent(
      client,
      (item) =>
        item.event === 'data' &&
        item.sessionId === start.session.sessionId &&
        item.incarnationId === attached.incarnationId &&
        item.data.includes(marker)
    )
    await client.write(start.session.sessionId, attached.incarnationId, `echo ${marker}\n`)
    await event

    const after = await client.listSessions()
    const afterEntries = after.sessions.filter(
      (session) => session.sessionId === start.session.sessionId
    )
    assert(afterEntries.length === 1, `Session duplicated after reattach: ${afterEntries.length}`)

    writeEvidence('reattach.json', {
      ok: true,
      runtime: runtimeFacts(),
      hostDir: supervisor.directory,
      originalHostPid: start.session.hostPid,
      reattachedHostPid: client.info.hostPid,
      sessionId: start.session.sessionId,
      originalIncarnationId: start.session.incarnationId,
      reattachedIncarnationId: attached.incarnationId,
      originalPtyPid: start.session.ptyPid,
      reattachedPtyPid: attached.ptyPid,
      created: attached.created,
      hostSessions: after.sessions.length,
      reattachMarker: marker
    })
    client.close()
    app.exit(0)
  } catch (error) {
    writeEvidence('reattach.json', { ok: false, runtime: runtimeFacts(), ...failed(error) })
    app.exit(1)
  }
  await new Promise<void>(() => {})
}

async function detectClaudeForGate(): Promise<{
  state: string
  version: string | null
  resolvedPath: string
}> {
  const detection = await createHarnessDetector().detect('claude')
  if (detection.state !== 'available') {
    const message = (detection as { message?: string }).message ?? 'unavailable'
    throw new Error(`Claude was not discovered through the login environment: ${message}`)
  }
  const resolvedPath = detection.resolvedPath ?? ''
  assert(resolvedPath.length > 0, 'Claude detection returned no resolved path')
  const expected = process.env.ICODE_GATE_HARNESS_DIR
  if (expected && expected.length > 0) {
    assert(
      resolvedPath.startsWith(expected),
      `Claude resolved outside the fake bin directory: ${resolvedPath}`
    )
  }
  return { state: detection.state, version: detection.version, resolvedPath }
}

type ActivityHookEvidence = {
  event: string
  sessionId: string
  incarnationId: string
  claudeSessionId: string | null
  delivered: boolean
  socket: string
}

/**
 * Runs the actual packaged hook command from the generated settings file.
 *
 * This proves the part a unit test cannot: a packaged Electron executable is
 * started as Node, reads Claude's stdin, and reaches the activity socket. The
 * turn-end command detaches with nohup on macOS, so the parent shell exits
 * before the event arrives.
 */
async function runActivityHookProbe(): Promise<ActivityHookEvidence> {
  const sessionId = `gate-activity-${Date.now()}`
  const incarnationId = `gate-incarnation-${randomUUID().slice(0, 8)}`
  const socketPath = activitySocketPath({ userDataDir: app.getPath('userData') })
  const installed = installClaudeHooks({
    directory: join(app.getPath('userData'), 'agent-hooks'),
    execPath: process.execPath,
    electronRunAsNode: true,
    platform: process.platform
  })
  const settings = JSON.parse(readFileSync(installed.settingsPath, 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  const command = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command
  assert(typeof command === 'string' && command.length > 0, 'Hook settings have no Stop command')

  let resolveEvent: ((event: ActivityHookEvent) => void) | null = null
  const received = new Promise<ActivityHookEvent>((resolve) => {
    resolveEvent = resolve
  })
  const server = new ActivityHookServer({
    socketPath,
    ingest: (event) => {
      resolveEvent?.(event)
      return 'accepted'
    }
  })
  await server.start()
  try {
    const child = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ICODE_ACTIVITY_SOCKET: socketPath,
        ICODE_SESSION_ID: sessionId,
        ICODE_SESSION_INCARNATION: incarnationId
      },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.stdin.end(
      JSON.stringify({ session_id: 'gate-claude-session', prompt_id: 'gate-prompt' })
    )
    const event = await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('Turn-end hook did not reach the activity socket')),
          5000
        ).unref()
      })
    ])
    assert(event.event === 'Stop', `Expected a Stop hook, got ${event.event}`)
    assert(event.sessionId === sessionId, 'Hook reported the wrong session')
    assert(event.incarnationId === incarnationId, 'Hook reported the wrong incarnation')
    return {
      event: event.event,
      sessionId,
      incarnationId,
      claudeSessionId: event.claudeSessionId ?? null,
      delivered: true,
      socket: socketPath
    }
  } finally {
    await server.stop()
  }
}

/** Check 5: packaged executable runs SQLite, native PTY, and the unpacked host. */
export async function runPackagedSmoke(): Promise<void> {
  const evidencePath = process.env.ICODE_GATE_EVIDENCE ?? join(artifactDir(), 'packaged-smoke.json')
  try {
    const sqlite = runSqliteProbe(join(app.getPath('userData'), 'icode-gate.db'))
    assert(sqlite.journalMode.toLowerCase() === 'wal', 'Packaged SQLite is not in WAL mode')
    assert(sqlite.committedRows === 2, 'Packaged SQLite committed-row count is wrong')
    assert(sqlite.rolledBackRows === 0, 'Packaged SQLite rollback failed')

    const directPty = await runPtyProbe(app.getPath('userData'))
    assert(directPty.exitCode === 7, `Packaged PTY exited ${directPty.exitCode}, expected 7`)
    assert(directPty.output.includes('GOT:hello'), 'Packaged PTY did not echo the marker')

    // macOS acceptance adds the Finder-launched login environment, a second
    // client that reattaches to the same PTY, and the real hook command.
    const loginEnvironment = {
      shell: process.env.SHELL ?? null,
      path: process.env.PATH ?? null,
      lang: process.env.LANG ?? null
    }
    const claude =
      process.env.ICODE_GATE_EXPECT_CLAUDE === '1' ? await detectClaudeForGate() : null
    const activity =
      process.env.ICODE_GATE_EXPECT_ACTIVITY === '1' ? await runActivityHookProbe() : null

    const supervisor = new HostSupervisor()
    const sessionId = `gate-packaged-${Date.now()}`
    const marker = `ICODE_GATE_PACKAGED_MARKER_${randomUUID().slice(0, 8)}`
    const { client, session } = await startHostSession(supervisor, sessionId, marker)

    let reattach: { created: boolean; incarnationId: string; ptyPid: number } | null = null
    if (process.env.ICODE_GATE_EXPECT_REATTACH === '1') {
      const second = new HostSupervisor()
      const secondClient = await second.ensure()
      try {
        const attached = await secondClient.createOrAttach({
          sessionId,
          cwd: process.cwd(),
          command: SHELL,
          args: SHELL_ARGS,
          cols: 100,
          rows: 30,
          attachOnly: true
        })
        assert(attached.created === false, 'Reattach created a new PTY')
        assert(
          attached.incarnationId === session.incarnationId,
          'Reattach changed the PTY incarnation'
        )
        assert(attached.ptyPid === session.ptyPid, 'Reattach changed the PTY pid')
        reattach = {
          created: attached.created,
          incarnationId: attached.incarnationId,
          ptyPid: attached.ptyPid
        }
      } finally {
        secondClient.close()
      }
    }

    await client.kill(sessionId)
    await client.shutdown()

    mkdirSync(dirname(evidencePath), { recursive: true })
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          ok: true,
          runtime: runtimeFacts(),
          sqlite,
          loginEnvironment,
          claude,
          activity,
          directPty: {
            shell: directPty.shell,
            ptyPid: directPty.ptyPid,
            exitCode: directPty.exitCode,
            sawMarker: directPty.output.includes('GOT:hello')
          },
          host: {
            hostPid: session.hostPid,
            socket: supervisor.socketPath,
            sessionId: session.sessionId,
            incarnationId: session.incarnationId,
            ptyPid: session.ptyPid,
            marker: session.marker,
            hostEntry: supervisor.hostEntryPath,
            reattach
          },
          evidencePath
        },
        null,
        2
      )}\n`
    )
    app.exit(0)
  } catch (error) {
    mkdirSync(dirname(evidencePath), { recursive: true })
    const payload = { ok: false, runtime: runtimeFacts(), ...failed(error) }
    writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`)
    app.exit(1)
  }
  await new Promise<void>(() => {})
}
