import type { AssistantStatus } from '../../../shared/domain/assistant'

const STATUS_CLASS: Record<AssistantStatus, string> = {
  working: 'bg-info animate-pulse',
  idle: 'bg-add',
  offline: 'bg-muted-foreground',
  error: 'bg-destructive'
}

export default function AssistantAvatar({
  name,
  status,
  size = 'md'
}: {
  name: string
  status: AssistantStatus
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const dimension = size === 'sm' ? 'h-5 w-5 text-[9px]' : size === 'lg' ? 'h-9 w-9 text-[14px]' : 'h-7 w-7 text-[11px]'
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full bg-accent/12 font-semibold text-accent ${dimension}`}>
      {name.slice(0, 1).toUpperCase()}
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${STATUS_CLASS[status]}`}
        aria-hidden="true"
      />
    </span>
  )
}
