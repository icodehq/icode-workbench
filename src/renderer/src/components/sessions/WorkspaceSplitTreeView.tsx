import { useRef, type ReactNode } from 'react'
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  clampedRatio,
  type SplitBranch,
  type SplitLeaf,
  type SplitNode
} from '../../state/workspace-split'
import { useT } from '../../i18n/use-i18n'
import { usePanelResize } from '../../lib/use-panel-resize'

type Props = {
  node: SplitNode
  renderLeaf: (leaf: SplitLeaf) => ReactNode
  onResize: (branchId: string, ratio: number) => void
}

/**
 * Renders a worktree split tree. Branches are flex rows (side-by-side) or
 * columns (stacked); each leaf is a pane showing one worktree tab.
 */
export default function WorkspaceSplitTreeView({
  node,
  renderLeaf,
  onResize
}: Props): React.JSX.Element {
  if (node.kind === 'leaf') return <>{renderLeaf(node)}</>
  return <WorkspaceSplitBranchView node={node} renderLeaf={renderLeaf} onResize={onResize} />
}

function WorkspaceSplitBranchView({
  node,
  renderLeaf,
  onResize
}: {
  node: SplitBranch
  renderLeaf: (leaf: SplitLeaf) => ReactNode
  onResize: (branchId: string, ratio: number) => void
}): React.JSX.Element {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const firstRef = useRef<HTMLDivElement | null>(null)
  const dividerRef = useRef<HTMLDivElement | null>(null)
  const horizontal = node.direction === 'horizontal'
  const ratio = node.ratio

  const { handleProps, lastValueRef } = usePanelResize({
    kind: 'split',
    panelRef: containerRef,
    getStartValue: () => node.ratio,
    getScale: () => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect === undefined) return 0
      const span = horizontal ? rect.width : rect.height
      return span > 0 ? 1 / span : 0
    },
    clamp: clampedRatio,
    direction: 1,
    axis: horizontal ? 'x' : 'y',
    cursor: horizontal ? 'col-resize' : 'row-resize',
    apply: (next) => {
      if (firstRef.current !== null) {
        firstRef.current.style.flexBasis = `${next * 100}%`
      }
    },
    onLive: (next) => {
      dividerRef.current?.setAttribute('aria-valuenow', String(Math.round(next * 100)))
    },
    onCommit: (next) => onResize(node.id, next)
  })

  const negativeKey = horizontal ? 'ArrowLeft' : 'ArrowUp'
  const positiveKey = horizontal ? 'ArrowRight' : 'ArrowDown'

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1"
      style={{ flexDirection: horizontal ? 'row' : 'column' }}
    >
      <div
        ref={firstRef}
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flexGrow: 0, flexShrink: 0, flexBasis: `${ratio * 100}%` }}
      >
        <WorkspaceSplitTreeView node={node.first} renderLeaf={renderLeaf} onResize={onResize} />
      </div>
      <div
        ref={dividerRef}
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
        data-testid="session-split-divider"
        data-branch-id={node.id}
        data-direction={node.direction}
        {...handleProps}
        onKeyDown={(event) => {
          if (event.key !== negativeKey && event.key !== positiveKey) return
          event.preventDefault()
          const current = lastValueRef.current ?? ratio
          onResize(node.id, current + (event.key === positiveKey ? 0.02 : -0.02))
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspaceSplitTreeView node={node.second} renderLeaf={renderLeaf} onResize={onResize} />
      </div>
    </div>
  )
}
