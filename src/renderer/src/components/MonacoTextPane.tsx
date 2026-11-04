import { useEffect, useRef, useState } from 'react'
import type * as MonacoTypes from 'monaco-editor'
import type { MonacoApi } from '../editor/monaco'

type Props = {
  path: string
  value: string
  readOnly: boolean
  testId: string
  ariaLabel: string
  onChange?: (value: string) => void
  /** Reveal this 1-based line when it changes, e.g. after conflict navigation. */
  revealLine?: number
}

type Handle = {
  editor: MonacoTypes.editor.IStandaloneCodeEditor
  model: MonacoTypes.editor.ITextModel
  monaco: MonacoApi
}

function themeFromDocument(): 'vs' | 'vs-dark' {
  const theme = document.documentElement.dataset.theme
  if (theme === 'light') return 'vs'
  if (theme === 'dark') return 'vs-dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs'
}

/**
 * One Monaco text pane for the merge editor.
 *
 * External value changes (accept actions, reset) are applied with a suppression
 * flag so they do not echo back as user edits. The read-only panes show the
 * whole stage; the editable Result pane is the only writable surface.
 */
export default function MonacoTextPane({
  path,
  value,
  readOnly,
  testId,
  ariaLabel,
  onChange,
  revealLine
}: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const handle = useRef<Handle | null>(null)
  const suppress = useRef(false)
  const changeRef = useRef(onChange)
  const instanceId = useRef(Math.random().toString(36).slice(2))
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  changeRef.current = onChange

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void import('../editor/monaco')
      .then(({ getMonaco, languageForPath }) => {
        if (cancelled || container.current === null) return
        const monaco = getMonaco()
        const model = monaco.editor.createModel(
          value,
          languageForPath(path),
          monaco.Uri.parse(
            `inmemory://icode-merge/${encodeURIComponent(path)}/${readOnly ? 'side' : 'result'}#${instanceId.current}`
          )
        )
        const editor = monaco.editor.create(container.current, {
          model,
          theme: themeFromDocument(),
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          overviewRulerLanes: 0,
          padding: { top: 6, bottom: 6 },
          ariaLabel
        })
        handle.current = { editor, model, monaco }
        ;(container.current as HTMLElement & { __adeEditor?: unknown }).__adeEditor = editor
        editor.onDidChangeModelContent(() => {
          if (suppress.current) return
          changeRef.current?.(model.getValue())
        })
        setState('ready')
      })
      .catch(() => {
        if (!cancelled) setState('failed')
      })
    return () => {
      cancelled = true
      const current = handle.current
      handle.current = null
      if (container.current !== null) {
        delete (container.current as HTMLElement & { __adeEditor?: unknown }).__adeEditor
      }
      current?.editor.dispose()
      current?.model.dispose()
    }
    // The model is rebuilt only when the identity of the pane changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, path, readOnly])

  useEffect(() => {
    const current = handle.current
    if (current === null || current.model.getValue() === value) return
    suppress.current = true
    current.model.setValue(value)
    suppress.current = false
  }, [value])

  useEffect(() => {
    const current = handle.current
    if (current === null || revealLine === undefined || revealLine < 1) return
    current.editor.revealLineInCenter(revealLine)
  }, [revealLine])

  useEffect(() => {
    if (state !== 'ready') return
    const observer = new MutationObserver(() => {
      const current = handle.current
      if (current !== null) current.monaco.editor.setTheme(themeFromDocument())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [state])

  return (
    <div className="relative h-full min-h-0">
      <div ref={container} className="absolute inset-0" data-testid={testId} />
      {state === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10.5px] text-muted-foreground">
          Loading…
        </div>
      ) : state === 'failed' ? (
        readOnly ? (
          <pre className="absolute inset-0 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] text-foreground">
            {value}
          </pre>
        ) : (
          <textarea
            className="absolute inset-0 h-full w-full resize-none bg-card p-2 font-mono text-[11px] text-foreground outline-none"
            aria-label={ariaLabel}
            data-testid={`${testId}-fallback`}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          />
        )
      ) : null}
    </div>
  )
}
