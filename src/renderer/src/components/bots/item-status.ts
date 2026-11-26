import type { ItemStatus } from '../../../../shared/domain/item'

/** The one status tone shared by the Items rail and the item detail dialog. */
export function itemStatusTone(status: ItemStatus): string {
  switch (status) {
    case 'needs_you':
      return 'bg-signal-weak text-signal'
    case 'working':
      return 'bg-info-weak text-info'
    case 'waiting':
      return 'bg-signal-weak/60 text-signal'
    case 'done':
      return 'bg-add-weak text-add'
    case 'canceled':
    case 'planned':
      return 'bg-muted text-muted-foreground'
  }
}
