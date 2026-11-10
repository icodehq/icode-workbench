import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { ReviewDecision, TaskStatus } from '../../../shared/domain/task'

/** A task as the chain graph needs it, including summaries outside the list page. */
export type TaskChainNode = {
  id: string
  title: string
  status: TaskStatus
  reviewDecision: ReviewDecision | null
  holdDependents: boolean
  /** True when the node came from a dependency summary, not the loaded list. */
  external: boolean
  /** Negative for blockers, 0 for the root, positive for dependents. */
  depth: number
  row: number
}

export type TaskChainEdge = { blockerId: string; dependentId: string }

export type TaskChain = {
  nodes: TaskChainNode[]
  edges: TaskChainEdge[]
  truncated: boolean
}

export const TASK_CHAIN_LIMIT = 40

function nodeFromTask(task: TaskRecordPayload, depth: number): TaskChainNode {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    reviewDecision: task.reviewDecision,
    holdDependents: task.holdDependents === true,
    external: false,
    depth,
    row: 0
  }
}

/**
 * The connected component around one task: its transitive blockers on the left,
 * its transitive dependents on the right.
 *
 * The loaded task list is the source of truth for edges; a blocker that fell
 * outside the list's 200-row page (or a dependent summary) becomes an external
 * node with no further edges. The walk is cycle-safe and bounded, because a
 * malformed database must not freeze the workbench.
 */
export function buildTaskChain(
  tasks: readonly TaskRecordPayload[],
  rootTaskId: string,
  limit = TASK_CHAIN_LIMIT
): TaskChain {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const root = byId.get(rootTaskId)
  if (!root) return { nodes: [], edges: [], truncated: false }

  const nodes = new Map<string, TaskChainNode>()
  nodes.set(root.id, nodeFromTask(root, 0))
  let truncated = false

  const addSummary = (
    summary: {
      id: string
      title: string
      status: TaskStatus
      reviewDecision?: ReviewDecision
      holdDependents?: boolean
    },
    depth: number
  ): boolean => {
    if (nodes.has(summary.id)) return false
    if (nodes.size >= limit) {
      truncated = true
      return false
    }
    nodes.set(summary.id, {
      id: summary.id,
      title: summary.title,
      status: summary.status,
      reviewDecision: summary.reviewDecision ?? null,
      holdDependents: summary.holdDependents === true,
      external: !byId.has(summary.id),
      depth,
      row: 0
    })
    return true
  }

  // Upstream: blockers of blocker, one depth per layer.
  let frontier = [root.id]
  for (let depth = -1; frontier.length > 0; depth -= 1) {
    const next: string[] = []
    for (const id of frontier) {
      const task = byId.get(id)
      if (!task) continue
      for (const dependency of task.dependencies ?? []) {
        if (addSummary(dependency, depth)) next.push(dependency.id)
      }
    }
    frontier = next
  }

  // Downstream: dependents of dependents.
  frontier = [root.id]
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const id of frontier) {
      const task = byId.get(id)
      if (!task) continue
      for (const dependent of task.dependents ?? []) {
        if (addSummary(dependent, depth)) next.push(dependent.id)
      }
    }
    frontier = next
  }

  const edges: TaskChainEdge[] = []
  const seen = new Set<string>()
  const addEdge = (blockerId: string, dependentId: string): void => {
    if (!nodes.has(blockerId) || !nodes.has(dependentId)) return
    const key = `${blockerId}\u0000${dependentId}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ blockerId, dependentId })
  }

  for (const node of nodes.values()) {
    const task = byId.get(node.id)
    if (!task) continue
    for (const dependency of task.dependencies ?? []) {
      addEdge(dependency.id, node.id)
    }
    // A dependent outside the loaded page is a summary on this task; its own
    // dependencies are unknown, so the reverse direction supplies the edge.
    for (const dependent of task.dependents ?? []) {
      addEdge(node.id, dependent.id)
    }
  }

  edges.sort(
    (left, right) =>
      left.blockerId.localeCompare(right.blockerId) ||
      left.dependentId.localeCompare(right.dependentId)
  )

  // Deterministic rows within each depth column.
  const columns = new Map<number, TaskChainNode[]>()
  for (const node of nodes.values()) {
    const column = columns.get(node.depth) ?? []
    column.push(node)
    columns.set(node.depth, column)
  }
  const ordered: TaskChainNode[] = []
  const depths = [...columns.keys()].sort((left, right) => left - right)
  for (const depth of depths) {
    const column = columns.get(depth) ?? []
    column.sort(
      (left, right) =>
        left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    )
    column.forEach((node, row) => {
      node.row = row
      ordered.push(node)
    })
  }

  return { nodes: ordered, edges, truncated }
}

/** Whether a blocker node has satisfied its gate, mirroring the dispatcher. */
export function chainEdgeSatisfied(node: TaskChainNode | undefined): boolean {
  if (!node) return false
  return (
    node.status === 'completed' &&
    (!node.holdDependents || node.reviewDecision === 'accepted')
  )
}
