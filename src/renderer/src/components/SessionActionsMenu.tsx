import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Info, Moon, RotateCcw, Sunrise, Trash2 } from 'lucide-react'

type Props = {
  live: boolean
  sleeping: boolean
  canSleep: boolean
  canWake: boolean
  wakeDescription: string
  sleepDisabledReason: string
  restartDisabled: boolean
  restartReason: string
  removeDisabled: boolean
  removeReason: string
  onDetails: () => void
  onSleep: () => void
  onWake: () => void
  onRestart: () => void
  onRemove: () => void
}

function MenuItem({
  icon,
  label,
  description,
  testId,
  destructive = false,
  disabled = false,
  title,
  onClick
}: {
  icon: React.ReactNode
  label: string
  description: string
  testId: string
  destructive?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-muted'
      }`}
      disabled={disabled}
      title={title}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

/**
 * The only session lifecycle surface in the compact header.
 *
 * The old six-icon row made Restart look like Refresh and Stop look like
 * "interrupt the agent". One labelled menu gives each action a name and a
 * description; Remove is the only way to end a session and it stops a live PTY
 * first, so "Stop" is not a user-facing concept.
 */
export default function SessionActionsMenu({
  live,
  sleeping,
  canSleep,
  canWake,
  wakeDescription,
  sleepDisabledReason,
  restartDisabled,
  restartReason,
  removeDisabled,
  removeReason,
  onDetails,
  onSleep,
  onWake,
  onRestart,
  onRemove
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const run = (action: () => void): void => {
    setOpen(false)
    action()
  }

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11px] text-foreground hover:bg-muted"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Session actions"
        onClick={() => setOpen((current) => !current)}
        data-testid="session-menu"
      >
        Session
        <ChevronDown size={12} />
      </button>

      {open ? (
        <div
          className="absolute right-0 top-9 z-50 w-64 rounded-md border border-border bg-card p-1.5 text-foreground shadow-xl"
          role="menu"
          aria-label="Session actions"
          data-testid="session-menu-popover"
        >
          <MenuItem
            icon={<Info size={13} />}
            label="Session details"
            description="Worktree, process and activity"
            testId="session-details-open"
            onClick={() => run(onDetails)}
          />
          {live && !sleeping ? (
            <MenuItem
              icon={<Moon size={13} />}
              label="Sleep session"
              description={wakeDescription}
              testId="sleep-session"
              disabled={!canSleep}
              title={sleepDisabledReason}
              onClick={() => run(onSleep)}
            />
          ) : null}
          {sleeping ? (
            <MenuItem
              icon={<Sunrise size={13} />}
              label="Wake session"
              description={wakeDescription}
              testId="wake-session"
              disabled={!canWake}
              onClick={() => run(onWake)}
            />
          ) : null}
          {!sleeping ? (
            <MenuItem
              icon={<RotateCcw size={13} />}
              label="Restart session"
              description="Keep this worktree; start a new process"
              testId="restart-session"
              disabled={restartDisabled}
              title={restartReason}
              onClick={() => run(onRestart)}
            />
          ) : null}
          <div className="my-1 h-px bg-border" />
          <MenuItem
            icon={<Trash2 size={13} />}
            label="Remove session…"
            description="Delete this session; its branch is kept"
            testId="remove-session"
            destructive
            disabled={removeDisabled}
            title={removeReason}
            onClick={() => run(onRemove)}
          />
        </div>
      ) : null}
    </span>
  )
}
