// @vitest-environment happy-dom

/*
 * The app shell recreates `onChanged` on every render (it is built from
 * `workspace` and `tasks`, which are fresh object literals). The hook must keep
 * that callback out of its effect dependencies, or the load effect re-runs on
 * every render and pins the renderer. These tests render the hook with a parent
 * that does exactly what App does.
 */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { IcodeApi } from '../../../shared/icode-api'
import type { IpcResult } from '../../../shared/schemas/ipc'
import type {
  ListRepoRemovalJobsResult,
  RepoRemovalJobSummary
} from '../../../shared/schemas/repo-removal'
import { useRemovalJobs } from './use-removal-jobs'

type RemovalJobsResult = IpcResult<ListRepoRemovalJobsResult>
type Deferred = {
  promise: Promise<RemovalJobsResult>
  resolve: (value: RemovalJobsResult) => void
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const listeners = new Set<() => void>()
let unsubscribed: Mock<() => void>
let notifySpy: Mock<() => void>
let onChangedSpy: Mock<() => void>
let rerender: (() => void) | null
let root: Root | null

beforeEach(() => {
  listeners.clear()
  unsubscribed = vi.fn()
  notifySpy = vi.fn()
  onChangedSpy = vi.fn()
  rerender = null
  root = null
})

afterEach(async () => {
  if (root !== null) {
    const mounted = root
    root = null
    await act(async () => {
      mounted.unmount()
    })
  }
  document.body.innerHTML = ''
  ;(window as unknown as { icode?: IcodeApi }).icode = undefined
  listeners.clear()
})

function installRepos(listRemovalJobs: () => Promise<RemovalJobsResult>): void {
  const repos = {
    listRemovalJobs,
    retryRemoval: vi.fn(),
    discardRemovalSnapshots: vi.fn(),
    onRemovalEvent: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        unsubscribed()
      }
    }
  }
  ;(window as unknown as { icode: IcodeApi }).icode = { repos } as unknown as IcodeApi
}

/** Mirrors App: new inline callbacks on every render. */
function Harness(): null {
  const [, setTick] = useState(0)
  rerender = () => setTick((tick) => tick + 1)
  useRemovalJobs({
    notify: () => notifySpy(),
    onChanged: () => onChangedSpy()
  })
  return null
}

async function mount(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
}

function pendingResult(): Deferred {
  let resolve!: (value: RemovalJobsResult) => void
  const promise = new Promise<RemovalJobsResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function never(): Promise<RemovalJobsResult> {
  return new Promise<RemovalJobsResult>(() => undefined)
}

function ok(jobs: RepoRemovalJobSummary[]): RemovalJobsResult {
  return { ok: true, value: { jobs } }
}

function removalJob(): RepoRemovalJobSummary {
  return {
    id: 'job-1',
    repoId: 'repo_00000000-0000-4000-8000-000000000000',
    repoName: 'yibei',
    repoPath: '/mnt/d/Development/Projects/yibei',
    status: 'completed',
    stage: 'done',
    worktreeCount: 0,
    snapshotCount: 1,
    attentionCount: 0,
    attempts: 0,
    error: null,
    canRetry: false,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('useRemovalJobs', () => {
  it('does not reload or resubscribe when the parent recreates its callbacks', async () => {
    const list = vi.fn(() => never())
    installRepos(list)

    await mount()
    expect(list).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(1)

    await act(async () => {
      rerender?.()
    })

    expect(list).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(1)
    expect(unsubscribed).not.toHaveBeenCalled()
  })

  it('reloads when the main process pushes a removal event', async () => {
    const list = vi.fn(() => never())
    installRepos(list)

    await mount()
    expect(list).toHaveBeenCalledTimes(1)

    act(() => {
      for (const listener of [...listeners]) listener()
    })

    expect(list).toHaveBeenCalledTimes(2)
  })

  it('reports onChanged only when the job signature changes', async () => {
    const pending: Deferred[] = []
    const list = vi.fn(() => {
      const next = pendingResult()
      pending.push(next)
      return next.promise
    })
    installRepos(list)

    await mount()
    expect(pending).toHaveLength(1)

    await act(async () => {
      pending[0]!.resolve(ok([]))
    })
    expect(onChangedSpy).not.toHaveBeenCalled()

    await act(async () => {
      for (const listener of [...listeners]) listener()
    })
    expect(pending).toHaveLength(2)

    await act(async () => {
      pending[1]!.resolve(ok([removalJob()]))
    })
    expect(onChangedSpy).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes once on unmount', async () => {
    installRepos(vi.fn(() => never()))

    await mount()
    const mounted = root!
    root = null
    await act(async () => {
      mounted.unmount()
    })

    expect(unsubscribed).toHaveBeenCalledTimes(1)
  })
})
