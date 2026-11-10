import { useMemo } from 'react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { TaskStatus } from '../../../shared/domain/task'
import { translate } from '../i18n/i18n-store'
import { useT } from '../i18n/use-i18n'
import {
  buildTaskChain,
  chainEdgeSatisfied,
  type TaskChainNode
} from './task-chain'

const NODE_W = 176
const NODE_H = 68
const GAP_X = 52
const GAP_Y = 14
const PAD = 16

function statusLabel(status: TaskStatus): string {
  return translate(`task.status.${status}`)
}

function statusTone(status: TaskStatus): string {
  if (status === 'failed') return 'text-destructive'
  if (status === 'completed') return 'text-add'
  if (status === 'running' || status === 'dispatching') return 'text-info'
  if (status === 'waiting') return 'text-signal'
  return 'text-muted-foreground'
}

function dotTone(status: TaskStatus): string {
  if (status === 'failed') return 'bg-destructive'
  if (status === 'completed') return 'bg-add'
  if (status === 'running' || status === 'dispatching') return 'bg-info'
  if (status === 'waiting') return 'bg-signal'
  return 'bg-muted-foreground'
}

/**
 * A read-only view of one task's chain: blockers to the left, dependents to the
 * right. This is a map, not an editor; the list and the dependency card own
 * every mutation.
 */
export default function TaskChainGraph({
  tasks,
  rootTaskId,
  onSelectTask
}: {
  tasks: readonly TaskRecordPayload[]
  rootTaskId: string
  onSelectTask: (taskId: string) => void
}): React.JSX.Element {
  const t = useT()
  const chain = useMemo(() => buildTaskChain(tasks, rootTaskId), [rootTaskId, tasks])

  if (chain.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-[11.5px] text-muted-foreground">
        {t('taskGraph.missing')}
      </div>
    )
  }

  const depths = [...new Set(chain.nodes.map((node) => node.depth))].sort(
    (left, right) => left - right
  )
  const columns = new Map<number, TaskChainNode[]>()
  for (const node of chain.nodes) {
    const column = columns.get(node.depth) ?? []
    column.push(node)
    columns.set(node.depth, column)
  }
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length))
  const minDepth = depths[0] ?? 0
  const maxDepth = depths[depths.length - 1] ?? 0
  const columnCount = maxDepth - minDepth + 1
  const width = PAD * 2 + columnCount * NODE_W + Math.max(0, columnCount - 1) * GAP_X
  const maxHeight = maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y
  const height = PAD * 2 + maxHeight

  const positions = new Map<string, { x: number; y: number }>()
  for (const depth of depths) {
    const column = columns.get(depth) ?? []
    const columnHeight = column.length * NODE_H + Math.max(0, column.length - 1) * GAP_Y
    const startY = PAD + (maxHeight - columnHeight) / 2
    column.forEach((node, row) => {
      positions.set(node.id, {
        x: PAD + (depth - minDepth) * (NODE_W + GAP_X),
        y: startY + row * (NODE_H + GAP_Y)
      })
    })
  }
  const nodeById = new Map(chain.nodes.map((node) => [node.id, node]))

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background p-3" data-testid="task-chain-graph">
      <div className="relative" style={{ width, height }}>
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={width}
          height={height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="chain-arrow-add"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="fill-add" />
            </marker>
            <marker
              id="chain-arrow-bad"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="fill-destructive" />
            </marker>
            <marker
              id="chain-arrow-wait"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {chain.edges.map((edge) => {
            const source = positions.get(edge.blockerId)
            const target = positions.get(edge.dependentId)
            if (!source || !target) return null
            const blocker = nodeById.get(edge.blockerId)
            const satisfied = chainEdgeSatisfied(blocker)
            const stopped = blocker?.status === 'failed' || blocker?.status === 'cancelled'
            const tone = satisfied ? 'add' : stopped ? 'bad' : 'wait'
            const x1 = source.x + NODE_W
            const y1 = source.y + NODE_H / 2
            const x2 = target.x - 1
            const y2 = target.y + NODE_H / 2
            const bend = Math.max(28, (x2 - x1) * 0.45)
            const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
            return (
              <path
                key={`${edge.blockerId}-${edge.dependentId}`}
                d={d}
                fill="none"
                strokeWidth="1.5"
                strokeDasharray={blocker?.holdDependents ? '5 4' : undefined}
                className={
                  tone === 'add'
                    ? 'stroke-add'
                    : tone === 'bad'
                      ? 'stroke-destructive'
                      : 'stroke-muted-foreground/60'
                }
                markerEnd={`url(#chain-arrow-${tone})`}
              />
            )
          })}
        </svg>

        {chain.nodes.map((node) => {
          const point = positions.get(node.id)
          if (!point) return null
          const root = node.id === rootTaskId
          return (
            <button
              key={node.id}
              type="button"
              className={`absolute flex flex-col gap-1 rounded-lg border bg-card px-2.5 py-2 text-left shadow-sm transition-colors ${
                root ? 'border-accent outline outline-2 outline-accent/40' : 'border-border'
              } ${node.external ? 'cursor-default border-dashed' : 'cursor-pointer hover:border-muted-foreground'}`}
              style={{
                width: NODE_W,
                height: NODE_H,
                left: 0,
                top: 0,
                transform: `translate(${point.x}px, ${point.y}px)`
              }}
              onClick={node.external ? undefined : () => onSelectTask(node.id)}
              title={node.title}
              data-testid={`task-chain-node-${node.id}`}
            >
              <span className="flex min-w-0 items-start gap-1.5">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dotTone(node.status)}`} />
                <span className="line-clamp-2 min-w-0 text-[10.5px] font-medium leading-tight text-foreground">
                  {node.title}
                </span>
              </span>
              <span className="mt-auto flex items-center gap-1.5 text-[9px] text-muted-foreground">
                <span className={statusTone(node.status)}>{statusLabel(node.status)}</span>
                {node.reviewDecision === 'pending' && node.status === 'completed' ? (
                  <span className="rounded bg-signal-weak px-1 text-signal">
                    {t('taskGraph.review')}
                  </span>
                ) : null}
                {node.external ? (
                  <span className="rounded bg-muted px-1">{t('taskGraph.external')}</span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>

      <p className="mt-2 px-1 text-[10px] text-muted-foreground">
        {chain.nodes.length === 1
          ? t('taskGraph.onlyTask')
          : t('taskGraph.hint')}
        {chain.truncated ? ` ${t('taskGraph.truncated')}` : ''}
      </p>
    </div>
  )
}
