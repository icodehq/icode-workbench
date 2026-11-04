/**
 * Durable W4 state: the Windows-side holder record and the Guest Host record.
 *
 * Two identities, never one:
 *
 *   - The **holder** is a Windows process. Its evidence is a Windows PID, a
 *     creation time and a command line. Only that PID may ever reach a Windows
 *     process API.
 *   - The **Guest Host** is a Linux process. Its evidence is the guest boot
 *     instance plus `/proc/<pid>/stat` start ticks. Its PID is meaningful only
 *     inside the distro and never crosses into a Windows process call.
 *
 * Every record is `unverifiable`-capable: a field the machine cannot supply is
 * `null`, and `null` never silently means "fine". Each parser rejects a record
 * it cannot fully understand rather than repairing it, because a repaired record
 * would let a later layer trust evidence that was never recorded.
 */

/** Windows-side holder evidence state. Never collapse these three. */
export type WslHolderState = 'live' | 'exited' | 'unverifiable'

/** Guest Host evidence state. `stale_boot` is a fourth, distinct answer. */
export type WslGuestHostState = 'live' | 'exited' | 'stale_boot' | 'unverifiable'

export type WslHolderRecord = {
  version: 1
  /** Registry name as validated by W2. */
  distro: string
  /** Lxss registration GUID; the holder belongs to one registration. */
  distroId: string
  /** Windows process id. */
  windowsPid: number
  /** Windows process creation time (epoch ms); null when the table could not say. */
  creationTimeMs: number | null
  startedAtMs: number
}

export type WslGuestHostRecord = {
  version: 1
  distroId: string
  /** `<bootId>:<pid1 start ticks>` — one distro boot instance. */
  distroInstance: string
  /** Guest PID. Scoped to `distroInstance`; never a Windows PID. */
  pid: number
  /** `/proc/<pid>/stat` field 22: distinguishes a reused PID inside one boot. */
  startTicks: string
  /** ICODE_HOST_DIR inside the distro. */
  hostDir: string
  socket: string
  protocolVersion: number
  hostVersion: string
  /** Artifact version + Host bundle hash: the deployed build this Host runs. */
  buildFingerprint: string
  artifactVersion: string
  recordedAtMs: number
}

/** What `meta.json` inside the distro says, as read in one guest execution. */
export type GuestHostMeta = {
  pid: number
  startedAt: number
  protocolVersion: number
  hostVersion: string
  socket: string
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseWslHolderRecord(text: string): WslHolderRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const fields = asRecord(parsed)
  if (!fields) return null
  const distro = asString(fields.distro)
  const distroId = asString(fields.distroId)
  const windowsPid = fields.windowsPid
  const creationTimeMs = fields.creationTimeMs
  const startedAtMs = fields.startedAtMs
  if (
    fields.version !== 1 ||
    distro === null ||
    distroId === null ||
    !isPositiveInt(windowsPid) ||
    !isPositiveInt(startedAtMs)
  ) {
    return null
  }
  if (creationTimeMs !== null && !isPositiveInt(creationTimeMs)) return null
  return {
    version: 1,
    distro,
    distroId,
    windowsPid,
    creationTimeMs: creationTimeMs === null ? null : creationTimeMs,
    startedAtMs
  }
}

export function parseWslGuestHostRecord(text: string): WslGuestHostRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const fields = asRecord(parsed)
  if (!fields) return null
  const distroId = asString(fields.distroId)
  const distroInstance = asString(fields.distroInstance)
  const startTicks = asString(fields.startTicks)
  const hostDir = asString(fields.hostDir)
  const socket = asString(fields.socket)
  const hostVersion = asString(fields.hostVersion)
  const buildFingerprint = asString(fields.buildFingerprint)
  const artifactVersion = asString(fields.artifactVersion)
  if (
    fields.version !== 1 ||
    distroId === null ||
    distroInstance === null ||
    startTicks === null ||
    hostDir === null ||
    socket === null ||
    hostVersion === null ||
    buildFingerprint === null ||
    artifactVersion === null ||
    !isPositiveInt(fields.pid) ||
    !isPositiveInt(fields.protocolVersion) ||
    !isPositiveInt(fields.recordedAtMs) ||
    !/^\d+$/u.test(startTicks)
  ) {
    return null
  }
  return {
    version: 1,
    distroId,
    distroInstance,
    pid: fields.pid,
    startTicks,
    hostDir,
    socket,
    protocolVersion: fields.protocolVersion,
    hostVersion,
    buildFingerprint,
    artifactVersion,
    recordedAtMs: fields.recordedAtMs
  }
}

/**
 * Parses the Host's own `meta.json`, which is written by existing Host code
 * (`writeMeta`) and therefore is the protocol's record, not a W4 invention.
 */
export function parseGuestHostMeta(text: string): GuestHostMeta | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const fields = asRecord(parsed)
  if (!fields) return null
  const socket = asString(fields.socket)
  const hostVersion = asString(fields.hostVersion)
  if (
    socket === null ||
    hostVersion === null ||
    !isPositiveInt(fields.pid) ||
    !isPositiveInt(fields.startedAt) ||
    !isPositiveInt(fields.protocolVersion)
  ) {
    return null
  }
  return {
    pid: fields.pid,
    startedAt: fields.startedAt,
    protocolVersion: fields.protocolVersion,
    hostVersion,
    socket
  }
}

/**
 * Whether a stored Guest Host record may be adopted for a boot instance.
 *
 * The boot comparison is the whole point of `distroInstance`: a restart leaves
 * every prior record describing a process that no longer exists, and adopting it
 * would report a dead Host as ready.
 */
export function guestRecordMatchesBoot(
  record: WslGuestHostRecord,
  identity: { distroInstance: string; distroId: string }
): boolean {
  return (
    record.distroInstance === identity.distroInstance && record.distroId === identity.distroId
  )
}
