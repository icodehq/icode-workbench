import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { isSendEnter, useAutosizeTextarea } from '../../lib/composer-input'
import { useT } from '../../i18n/use-i18n'

type SpeechAlternative = { transcript: string }
type SpeechResult = { 0?: SpeechAlternative }
type SpeechEvent = { results: ArrayLike<SpeechResult> }
type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechWindow = {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}

/**
 * The writing surface shared by a bot's home chat and a group room.
 *
 * It follows the composer these surfaces were modelled on: a rounded card, an
 * editor that grows to eight lines, drafts that survive a reload, IME-safe
 * Enter, a primary Send that becomes Stop while a turn runs with nothing typed,
 * and a queue line for messages held until the agent is free.
 */
export default function ChatComposer({
  textareaRef,
  value,
  onChange,
  onSelect,
  onSend,
  onStop,
  onKeyDown,
  working = false,
  sending = false,
  disabled = false,
  blocked = false,
  placeholder,
  footerLeft,
  footerRight,
  menu,
  attachments = [],
  commands,
  contextUsage = null,
  onAttachFiles,
  onRemoveAttachment,
  queued,
  queuedLabel,
  testIds
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onSelect?: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void
  /** Called by Enter, the primary button, or the parent. */
  onSend: () => void
  onStop?: () => void
  /** Mention/command menus get the key first; return true when they used it. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  working?: boolean
  sending?: boolean
  disabled?: boolean
  /** The draft cannot be sent yet (for example an unknown mention). */
  blocked?: boolean
  placeholder: string
  footerLeft?: ReactNode
  footerRight?: ReactNode
  /** A picker shown above the card, in the composer's own positioning context. */
  menu?: ReactNode
  /** Files already picked for this message, shown as chips. */
  attachments?: Array<{ id: string; name: string; path: string; preview?: string | null }>
  /** Built-ins shown when the draft starts with a slash. */
  commands?: Array<{ name: string; run: () => void }>
  /** Last prompt size against the limit; the ring mirrors the session's usage. */
  contextUsage?: { used: number; max: number } | null
  onAttachFiles?: (files: File[]) => void
  onRemoveAttachment?: (id: string) => void
  queued?: number
  queuedLabel?: string
  testIds?: { textarea: string; send: string }
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const t = useT()
  const [dictating, setDictating] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [commandDismissed, setCommandDismissed] = useState(false)
  const dictationBase = useRef('')
  const dictation = useRef<SpeechRecognitionLike | null>(null)
  const speech =
    typeof window === 'undefined'
      ? null
      : ((window as unknown as SpeechWindow).SpeechRecognition ??
        (window as unknown as SpeechWindow).webkitSpeechRecognition ??
        null)
  const startDictation = (): void => {
    if (speech === null) return
    if (dictating) {
      dictation.current?.stop()
      return
    }
    const recognition = new speech()
    recognition.lang = document.documentElement.lang || navigator.language
    recognition.interimResults = true
    recognition.continuous = false
    dictationBase.current = value
    recognition.onresult = (event) => {
      let transcript = ''
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index]?.[0]?.transcript ?? ''
      }
      const base = dictationBase.current
      onChange(
        `${base}${base.length > 0 && !base.endsWith(' ') ? ' ' : ''}${transcript}`
      )
    }
    recognition.onend = () => setDictating(false)
    recognition.onerror = () => setDictating(false)
    dictation.current = recognition
    setDictating(true)
    try {
      recognition.start()
    } catch {
      setDictating(false)
    }
  }
  useEffect(() => () => dictation.current?.stop(), [])
  useAutosizeTextarea(textareaRef, value, 160)
  const commandQuery =
    commands !== undefined && value.startsWith('/') && !/\s/.test(value)
      ? value.toLocaleLowerCase()
      : null
  const commandMatches =
    commandQuery === null
      ? []
      : commands!.filter((command) =>
          command.name.toLocaleLowerCase().startsWith(commandQuery)
        )
  const showCommands = commandMatches.length > 0 && !commandDismissed
  useEffect(() => {
    setCommandIndex(0)
    setCommandDismissed(false)
  }, [value])
  const chooseCommand = (index: number): void => {
    const command = commandMatches[index]
    if (command === undefined) return
    onChange('')
    command.run()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const empty = value.trim().length === 0 && attachments.length === 0
  const stops = working && empty && onStop !== undefined

  useEffect(() => {
    if (!stops) return
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const field = textareaRef.current
      if (field === null || document.activeElement !== field) return
      event.preventDefault()
      onStop?.()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onStop, stops, textareaRef])

  const primary = (): void => {
    if (stops) {
      onStop?.()
    } else {
      onSend()
    }
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <div
      ref={root}
      className="relative shrink-0 border-t border-border bg-card px-3 pb-3 pt-2"
    >
      {showCommands ? (
        <div className="absolute bottom-full left-3 z-20 mb-1 w-56 overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl">
          {commandMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`flex w-full items-center px-2 py-1.5 text-left font-mono text-[11px] ${
                commandIndex === index ? 'bg-muted' : 'hover:bg-muted'
              }`}
              onMouseDown={(event) => {
                event.preventDefault()
                chooseCommand(index)
              }}
            >
              {command.name}
            </button>
          ))}
        </div>
      ) : null}
      {menu !== undefined ? (
        <div className="absolute bottom-full left-3 z-20 mb-1">{menu}</div>
      ) : null}
      <div className="mx-auto w-full max-w-3xl">
        {queued !== undefined && queued > 0 && queuedLabel !== undefined ? (
          <div className="mb-1 px-1 text-[10px] text-muted-foreground">{queuedLabel}</div>
        ) : null}
        <div
          className="rounded-xl border border-border bg-background p-1.5 shadow-xs transition-colors focus-within:border-line-strong"
          onDragOver={(event) => {
            if (onAttachFiles === undefined) return
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
          }}
          onDrop={(event) => {
            if (onAttachFiles === undefined) return
            const files = Array.from(event.dataTransfer.files)
            if (files.length === 0) return
            event.preventDefault()
            onAttachFiles(files)
          }}
        >
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-1 px-1 pb-1 pt-0.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[9.5px] text-foreground"
                  title={attachment.path}
                >
                  {attachment.preview ? (
                    <img
                      src={attachment.preview}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <Paperclip size={9} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{attachment.name}</span>
                  {onRemoveAttachment !== undefined ? (
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => onRemoveAttachment(attachment.id)}
                      aria-label="Remove attachment"
                    >
                      <X size={8} />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onSelect={onSelect}
            onPaste={(event) => {
              if (onAttachFiles === undefined) return
              const files = Array.from(event.clipboardData.files)
              if (files.length === 0) return
              event.preventDefault()
              onAttachFiles(files)
            }}
            onKeyDown={(event) => {
              if (showCommands) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setCommandIndex(
                    (current) =>
                      (current + step + commandMatches.length) % commandMatches.length
                  )
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  chooseCommand(commandIndex)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setCommandDismissed(true)
                  return
                }
              }
              if (onKeyDown?.(event) === true) return
              if (isSendEnter(event)) {
                event.preventDefault()
                onSend()
              }
            }}
            data-testid={testIds?.textarea}
          />
          <div className="flex items-center gap-1.5 pt-0.5">
            {onAttachFiles !== undefined ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? [])
                    event.target.value = ''
                    if (files.length > 0) onAttachFiles(files)
                  }}
                />
                <button
                  type="button"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  disabled={disabled}
                  onClick={() => fileInput.current?.click()}
                  aria-label="Attach files"
                  title="Attach files"
                  data-composer-attach=""
                >
                  <Paperclip size={13} />
                </button>
              </>
            ) : null}
            {speech !== null ? (
              <button
                type="button"
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 ${
                  dictating
                    ? 'text-destructive'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                disabled={disabled}
                onClick={startDictation}
                aria-label={
                  dictating ? t('composer.stopDictation') : t('composer.dictate')
                }
                title={dictating ? t('composer.stopDictation') : t('composer.dictate')}
                data-composer-dictate=""
              >
                <Mic size={13} />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">{footerLeft}</div>
            {contextUsage !== null && contextUsage.max > 0 ? (
              (() => {
                const percent = Math.max(
                  0,
                  Math.min(100, Math.round((contextUsage.used / contextUsage.max) * 100))
                )
                const radius = 6
                const circumference = 2 * Math.PI * radius
                return (
                  <span
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
                    title={t('composer.contextUsage', { percent: String(percent) })}
                    aria-label={t('composer.contextUsage', {
                      percent: String(percent)
                    })}
                    data-composer-context-usage={percent}
                  >
                    <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90">
                      <circle
                        cx="8"
                        cy="8"
                        r={radius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="text-border"
                      />
                      <circle
                        cx="8"
                        cy="8"
                        r={radius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray={circumference}
                        strokeDashoffset={circumference * (1 - percent / 100)}
                        strokeLinecap="round"
                        className={percent >= 90 ? 'text-destructive' : 'text-accent'}
                      />
                    </svg>
                  </span>
                )
              })()
            ) : null}
            {footerRight}
            <button
              type="button"
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                stops
                  ? 'border border-border bg-card text-foreground hover:bg-muted'
                  : 'bg-accent text-accent-ink hover:opacity-90'
              } disabled:cursor-not-allowed disabled:opacity-40`}
              disabled={
                disabled || blocked || sending || (!stops && empty)
              }
              onClick={primary}
              aria-label={stops ? 'Stop' : 'Send'}
              title={stops ? 'Stop' : 'Send'}
              data-testid={testIds?.send}
              data-composer-primary={stops ? 'stop' : 'send'}
            >
              {sending && !stops ? (
                <Loader2 size={14} className="animate-spin" />
              ) : stops ? (
                <Square size={12} />
              ) : (
                <ArrowUp size={15} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
