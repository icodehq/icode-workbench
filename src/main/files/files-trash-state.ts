import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FileTrashOperation } from '../../shared/domain/workspace-files'

type TrashState = {
  version: 1
  sessions: Record<string, FileTrashOperation[]>
}

const EMPTY: TrashState = { version: 1, sessions: {} }

/**
 * Controller-side metadata for the app-managed session trash.
 *
 * The file bytes live beside the worktree on the host that owns it; this small
 * JSON file only says which operation ids exist and where each item came from.
 * Keeping it controller-side avoids writing a second protocol into the guest
 * file scripts, while still surviving a renderer or app restart.
 */
export class FilesTrashState {
  private state: TrashState = EMPTY
  private loadPromise: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string | null) {}

  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  private async load(): Promise<void> {
    if (this.filePath === null) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { version?: unknown }).version === 1 &&
        (parsed as { sessions?: unknown }).sessions !== null &&
        typeof (parsed as { sessions?: unknown }).sessions === 'object'
      ) {
        this.state = parsed as TrashState
      }
    } catch {
      // Missing or malformed metadata is the same as no trash history.
      this.state = EMPTY
    }
  }

  private save(): Promise<void> {
    if (this.filePath === null) return Promise.resolve()
    const snapshot = JSON.stringify(this.state)
    const path = this.filePath
    // Serialize writes so two deletes cannot interleave a rename. A failed
    // write does not poison the next one.
    const next = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${path}.tmp`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temporary, snapshot, 'utf8')
        await rename(temporary, path)
      })
    this.writeChain = next
    return next
  }

  async list(sessionId: string): Promise<FileTrashOperation[]> {
    await this.ensureLoaded()
    return [...(this.state.sessions[sessionId] ?? [])].sort(
      (left, right) => right.createdAt - left.createdAt
    )
  }

  async find(sessionId: string, opId: string): Promise<FileTrashOperation | null> {
    await this.ensureLoaded()
    return (
      (this.state.sessions[sessionId] ?? []).find((entry) => entry.opId === opId) ??
      null
    )
  }

  /** Records an operation before any bytes move, so a failed metadata write aborts cleanly. */
  async record(sessionId: string, operation: FileTrashOperation): Promise<void> {
    await this.ensureLoaded()
    const list = this.state.sessions[sessionId] ?? []
    this.state = {
      version: 1,
      sessions: {
        ...this.state.sessions,
        [sessionId]: [operation, ...list.filter((entry) => entry.opId !== operation.opId)]
      }
    }
    await this.save()
  }

  async replaceEntries(
    sessionId: string,
    opId: string,
    entries: FileTrashOperation['entries']
  ): Promise<void> {
    await this.ensureLoaded()
    const list = this.state.sessions[sessionId] ?? []
    const next = list
      .map((entry) => (entry.opId === opId ? { ...entry, entries } : entry))
      .filter((entry) => entry.entries.length > 0)
    const sessions = { ...this.state.sessions }
    if (next.length === 0) delete sessions[sessionId]
    else sessions[sessionId] = next
    this.state = { version: 1, sessions }
    await this.save()
  }

  async remove(sessionId: string, opId: string): Promise<void> {
    const list = await this.list(sessionId)
    await this.replaceEntries(
      sessionId,
      opId,
      list.find((entry) => entry.opId === opId)?.entries.slice(0, 0) ?? []
    )
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.ensureLoaded()
    if (!(sessionId in this.state.sessions)) return
    const sessions = { ...this.state.sessions }
    delete sessions[sessionId]
    this.state = { version: 1, sessions }
    await this.save()
  }

  async all(): Promise<Array<{ sessionId: string; operation: FileTrashOperation }>> {
    await this.ensureLoaded()
    return Object.entries(this.state.sessions).flatMap(([sessionId, operations]) =>
      operations.map((operation) => ({ sessionId, operation }))
    )
  }
}
