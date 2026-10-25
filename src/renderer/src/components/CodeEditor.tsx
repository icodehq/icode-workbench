import { useEffect, useMemo, useRef, useState } from 'react'

export type CodeEditorProps = {
  /** Worktree-relative path, shown in the header. */
  path: string
  value: string
  /** True when there are unsaved edits. */
  dirty: boolean
  /** Caret requested by a navigation action (search hit, quick open). */
  gotoLine?: number | null
  onChange: (next: string) => void
  onSave: () => void
  onClose: () => void
}

const TAB_WIDTH = 2

/**
 * A code editor that keeps the platform's own text handling.
 *
 * A textarea is used rather than a virtualised editor because everything a
 * developer needs here — real selection, IME, undo, accessibility, find-in-page
 * — comes from the control the OS and Chromium already implement. The gutter and
 * the keyboard affordances are added around it, and the text layer is never
 * overlaid, so what you see is exactly what you edit.
 */
export default function CodeEditor({
  path,
  value,
  dirty,
  gotoLine,
  onChange,
  onSave,
  onClose
}: CodeEditorProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const gutter = useRef<HTMLDivElement | null>(null)
  const [caret, setCaret] = useState({ line: 1, column: 1 })

  const lineCount = useMemo(() => value.split('\n').length, [value])
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_unused, index) => String(index + 1)),
    [lineCount]
  )

  // A navigation request moves the caret to a 1-based line and reveals it.
  useEffect(() => {
    if (gotoLine === null || gotoLine === undefined) return
    const element = textarea.current
    if (!element) return
    const lines = value.split('\n')
    const target = Math.max(1, Math.min(gotoLine, lines.length))
    let offset = 0
    for (let index = 0; index < target - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1
    element.focus()
    element.setSelectionRange(offset, offset)
    setCaret({ line: target, column: 1 })
  }, [gotoLine, value])

  const syncScroll = (): void => {
    const element = textarea.current
    if (element && gutter.current) gutter.current.scrollTop = element.scrollTop
  }

  const updateCaret = (): void => {
    const element = textarea.current
    if (!element) return
    const upToCaret = element.value.slice(0, element.selectionStart)
    const lines = upToCaret.split('\n')
    setCaret({ line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="code-editor">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11px] text-foreground" data-testid="editor-path">
            {path}
          </span>
          {dirty ? (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] text-amber-400" data-testid="editor-dirty">
              unsaved
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[9px] text-muted-foreground" data-testid="editor-caret">
            {caret.line}:{caret.column}
          </span>
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onSave}
            data-testid="editor-save"
            title="Save (Ctrl/Cmd+S)"
          >
            Save
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onClose}
            data-testid="editor-close"
            title="Close file"
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={gutter}
          className="shrink-0 select-none overflow-hidden border-r border-border bg-muted/30 px-2 py-2 text-right font-mono text-[11px] leading-[18px] text-muted-foreground"
          aria-hidden="true"
          data-testid="editor-gutter"
        >
          {lineNumbers.map((number) => (
            <div key={number} className={Number(number) === caret.line ? 'text-foreground' : ''}>
              {number}
            </div>
          ))}
        </div>

        <textarea
          ref={textarea}
          value={value}
          spellCheck={false}
          wrap="off"
          className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[11px] leading-[18px] text-foreground outline-none"
          data-testid="editor-textarea"
          onChange={(event) => {
            onChange(event.target.value)
            updateCaret()
          }}
          onScroll={syncScroll}
          onKeyUp={updateCaret}
          onClick={updateCaret}
          onKeyDown={(event) => {
            const meta = event.metaKey || event.ctrlKey
            if (meta && event.key.toLowerCase() === 's') {
              event.preventDefault()
              onSave()
              return
            }
            // Indent with spaces so the file stays consistent with the project.
            if (event.key === 'Tab') {
              event.preventDefault()
              const element = event.currentTarget
              const start = element.selectionStart
              const end = element.selectionEnd
              const padding = ' '.repeat(TAB_WIDTH)
              const next = `${element.value.slice(0, start)}${padding}${element.value.slice(end)}`
              onChange(next)
              requestAnimationFrame(() => {
                element.setSelectionRange(start + TAB_WIDTH, start + TAB_WIDTH)
              })
            }
          }}
        />
      </div>
    </div>
  )
}
