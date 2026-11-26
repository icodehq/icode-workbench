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
  size = 'md',
  color,
  image,
  mascot,
  outfit
}: {
  name: string
  status: AssistantStatus
  size?: 'sm' | 'md' | 'lg'
  color?: string
  image?: string | null
  mascot?: string | null
  outfit?: string | null
}): React.JSX.Element {
  const dimension = size === 'sm' ? 'h-5 w-5 text-[9px]' : size === 'lg' ? 'h-9 w-9 text-[14px]' : 'h-7 w-7 text-[11px]'
  const outfitRing: Record<string, string> = {
    sun: '#f59e0b',
    ocean: '#0ea5e9',
    forest: '#10b981',
    rose: '#f43f5e',
    violet: '#8b5cf6'
  }
  const ring = outfit === null || outfit === undefined ? undefined : outfitRing[outfit]
  return (
    <span
      className={`relative inline-flex shrink-0 rounded-full ${dimension}`}
      style={ring === undefined ? undefined : { boxShadow: `0 0 0 2px ${ring}` }}
    >
      <span
        className={`inline-flex h-full w-full items-center justify-center overflow-hidden rounded-full font-semibold ${
          image === undefined || image === null
            ? 'bg-accent/12 text-accent'
            : 'bg-muted'
        }`}
        style={
          image === undefined || image === null
            ? color === undefined
              ? undefined
              : { backgroundColor: `${color}22`, color }
            : undefined
        }
      >
        {image !== undefined && image !== null ? (
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : mascot !== undefined && mascot !== null && mascot.length > 0 ? (
          <span aria-hidden="true">{mascot}</span>
        ) : (
          name.slice(0, 1).toUpperCase()
        )}
      </span>
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${STATUS_CLASS[status]}`}
        aria-hidden="true"
      />
    </span>
  )
}
