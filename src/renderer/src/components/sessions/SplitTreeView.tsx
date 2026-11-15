import { useRef, useState, type ReactNode } from 'react'
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  type SplitBranch,
  type SplitNode
} from '../../state/session-split'
import { useT } from '../../i18n/use-i18n'

type Props = {
  node: SplitNode
  renderLeaf: (sessionId: string) => ReactNode
  onResize: (branchId: string, ratio: number) => void
}

/**
 * Renders a split tree. Branches are flex rows (side-by-side) or columns
 * (stacked); each child can itself be a branch, so any nesting works. The
 * divider mutates only its own branch's ratio and pins it.
 */
export default function SplitTreeView({ node, renderLeaf, onResize }: Props): React.JSX.Element {
  if (node.kind === 'leaf') return <>{renderLeaf(node.sessionId)}</>
  return <SplitBranchView node={node} renderLeaf={renderLeaf} onResize={onResize} />
}

function SplitBranchView({
  node,
  renderLeaf,
  onResize
}: {
  node: SplitBranch
  renderLeaf: (sessionId: string) => ReactNode
  onResize: (branchId: string, ratio: number) => void
}): React.JSX.Element {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragRatioRef = useRef<number | null>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const horizontal = node.direction === 'horizontal'
  // The live divider position stays local until release, so the tree state and
  // its persisted copy only change once per drag.
  const ratio = dragRatio ?? node.ratio

  const ratioAt = (clientX: number, clientY: number): number | null => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return null
    return horizontal ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height
  }

  const updateDrag = (clientX: number, clientY: number): void => {
    const next = ratioAt(clientX, clientY)
    if (next === null) return
    dragRatioRef.current = next
    setDragRatio(next)
  }

  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateDrag(event.clientX, event.clientY)
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    updateDrag(event.clientX, event.clientY)
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const committed = dragRatioRef.current
    dragRatioRef.current = null
    setDragRatio(null)
    if (committed !== null) onResize(node.id, committed)
  }

  const negativeKey = horizontal ? 'ArrowLeft' : 'ArrowUp'
  const positiveKey = horizontal ? 'ArrowRight' : 'ArrowDown'

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1"
      style={{ flexDirection: horizontal ? 'row' : 'column' }}
    >
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flexGrow: 0, flexShrink: 0, flexBasis: `${ratio * 100}%` }}
      >
        <SplitTreeView node={node.first} renderLeaf={renderLeaf} onResize={onResize} />
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={t('session.resizeSplit')}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(SPLIT_MIN_RATIO * 100)}
        aria-valuemax={Math.round(SPLIT_MAX_RATIO * 100)}
        tabIndex={0}
        className={`shrink-0 bg-border/70 transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none ${
          horizontal ? 'w-[3px] cursor-col-resize' : 'h-[3px] cursor-row-resize'
        }`}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={(event) => {
          if (event.key !== negativeKey && event.key !== positiveKey) return
          event.preventDefault()
          onResize(node.id, ratio + (event.key === positiveKey ? 0.02 : -0.02))
        }}
        data-testid="session-split-divider"
        data-branch-id={node.id}
        data-direction={node.direction}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SplitTreeView node={node.second} renderLeaf={renderLeaf} onResize={onResize} />
      </div>
    </div>
  )
}
