import { useEffect, useRef, useState, type ReactNode } from 'react'
import type * as MonacoTypes from 'monaco-editor'
import type { MonacoApi } from '../editor/monaco'

type Props = {
  path: string
  original: string
  modified: string
  /** Rendered when Monaco cannot load, and as the loading placeholder. */
  fallback: ReactNode
}

type Handle = {
  editor: MonacoTypes.editor.IStandaloneDiffEditor
  original: MonacoTypes.editor.ITextModel
  modified: MonacoTypes.editor.ITextModel
  monaco: MonacoApi
}

function themeFromDocument(): 'vs' | 'vs-dark' {
  const theme = document.documentElement.dataset.theme
  if (theme === 'light') return 'vs'
  if (theme === 'dark') return 'vs-dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs'
}

/**
 * Read-only side-by-side Monaco diff for committed files.
 *
 * The unified renderer remains the fallback and stays the working-tree diff
 * because it carries line notes. This view owns two models per file and
 * disposes them on path change or unmount.
 */
export default function MonacoDiffView({
  path,
  original,
  modified,
  fallback
}: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const handle = useRef<Handle | null>(null)
  const instanceId = useRef(Math.random().toString(36).slice(2))
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void import('../editor/monaco')
      .then(({ getMonaco, languageForPath }) => {
        if (cancelled || container.current === null) return
        const monaco = getMonaco()
        const language = languageForPath(path)
        const originalModel = monaco.editor.createModel(
          original,
          language,
          monaco.Uri.parse(
            `inmemory://icode-diff/${encodeURIComponent(path)}/old#${instanceId.current}`
          )
        )
        const modifiedModel = monaco.editor.createModel(
          modified,
          language,
          monaco.Uri.parse(
            `inmemory://icode-diff/${encodeURIComponent(path)}/new#${instanceId.current}`
          )
        )
        const editor = monaco.editor.createDiffEditor(container.current, {
          theme: themeFromDocument(),
          readOnly: true,
          automaticLayout: true,
          renderSideBySide: true,
          ignoreTrimWhitespace: false,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          renderOverviewRuler: true,
          padding: { top: 8, bottom: 8 }
        })
        editor.setModel({ original: originalModel, modified: modifiedModel })
        handle.current = { editor, original: originalModel, modified: modifiedModel, monaco }
        ;(container.current as HTMLElement & { __adeDiff?: unknown }).__adeDiff = editor
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
        delete (container.current as HTMLElement & { __adeDiff?: unknown }).__adeDiff
      }
      current?.editor.dispose()
      current?.original.dispose()
      current?.modified.dispose()
    }
  }, [modified, original, path])

  useEffect(() => {
    if (state !== 'ready') return
    const observer = new MutationObserver(() => {
      const current = handle.current
      if (current !== null) current.monaco.editor.setTheme(themeFromDocument())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [state])

  if (state === 'failed') return <>{fallback}</>

  return (
    <div className="relative h-full min-h-0">
      <div ref={container} className="absolute inset-0" data-testid="monaco-diff" />
      {state === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          Loading diff…
        </div>
      ) : null}
    </div>
  )
}
