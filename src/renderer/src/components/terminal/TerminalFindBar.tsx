import { useEffect, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from 'lucide-react'
import { useT } from '../../i18n/use-i18n'
import type { TerminalFindDirection } from '../../terminal/terminal-interaction-host'

type Props = {
  open: boolean
  onClose: () => void
  find: (
    query: string,
    direction: TerminalFindDirection,
    options: { caseSensitive: boolean; regex: boolean }
  ) => boolean
  clearFind: () => void
  initialCaseSensitive?: boolean
  initialRegex?: boolean
}

/**
 * Find-in-scrollback overlay. The instance owns the search addon; this view
 * owns the query and keyboard navigation.
 */
export default function TerminalFindBar({
  open,
  onClose,
  find,
  clearFind,
  initialCaseSensitive = false,
  initialRegex = false
}: Props): React.JSX.Element | null {
  const t = useT()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(initialCaseSensitive)
  const [regex, setRegex] = useState(initialRegex)

  useEffect(() => {
    if (!open) return
    const input = inputRef.current
    input?.focus()
    input?.select()
  }, [open])

  useEffect(() => {
    if (!open) return
    if (query.length === 0) {
      clearFind()
      return
    }
    find(query, 'next', { caseSensitive, regex })
  }, [caseSensitive, clearFind, find, open, query, regex])

  if (!open) return null

  const close = (): void => {
    clearFind()
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    const modifier = event.metaKey || event.ctrlKey
    if (modifier && event.key.toLowerCase() === 'g') {
      event.preventDefault()
      find(query, event.shiftKey ? 'previous' : 'next', { caseSensitive, regex })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      find(query, event.shiftKey ? 'previous' : 'next', { caseSensitive, regex })
    }
  }

  const navigate = (direction: TerminalFindDirection): void => {
    if (query.length > 0) find(query, direction, { caseSensitive, regex })
  }

  return (
    <div
      className="absolute right-2 top-2 z-30 flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 text-[11px] shadow-sm"
      data-testid="terminal-find-bar"
      role="search"
    >
      <input
        ref={inputRef}
        className="h-6 w-44 min-w-0 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:border-accent"
        value={query}
        placeholder={t('terminal.find.placeholder')}
        aria-label={t('terminal.find.placeholder')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted ${
          caseSensitive ? 'text-accent' : 'text-muted-foreground'
        }`}
        aria-label={t('terminal.find.caseSensitive')}
        aria-pressed={caseSensitive}
        title={t('terminal.find.caseSensitive')}
        onClick={() => setCaseSensitive((current) => !current)}
      >
        <CaseSensitive size={13} />
      </button>
      <button
        type="button"
        className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted ${
          regex ? 'text-accent' : 'text-muted-foreground'
        }`}
        aria-label={t('terminal.find.regex')}
        aria-pressed={regex}
        title={t('terminal.find.regex')}
        onClick={() => setRegex((current) => !current)}
      >
        <Regex size={13} />
      </button>
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        aria-label={t('terminal.find.previous')}
        title={t('terminal.find.previous')}
        onClick={() => navigate('previous')}
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        aria-label={t('terminal.find.next')}
        title={t('terminal.find.next')}
        onClick={() => navigate('next')}
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        aria-label={t('terminal.find.close')}
        title={t('terminal.find.close')}
        onClick={close}
      >
        <X size={13} />
      </button>
    </div>
  )
}
