import { useEffect, useMemo, useRef, useState } from 'react'
import { History, X } from 'lucide-react'
import type * as MonacoTypes from 'monaco-editor'
import type {
  FileContentPayload,
  GitApplyPatchPayload,
  GitBlameLine,
  GitBlamePayload
} from '../../../shared/icode-api'
import type { FileDiffResult } from '../../../shared/schemas/changes'
import { callApi } from '../lib/api'
import { shortcutLabel } from '../lib/platform'
import { useT } from '../i18n/use-i18n'
import { translate, getLocale } from '../i18n/i18n-store'
import { formatDateTime } from '../../../shared/i18n'
import { monacoThemeForDocument, type MonacoApi } from '../editor/monaco'
import { lineDiff, quickDiffCounts, type LineChange } from '../editor/line-diff'
import { quickChangeForLine, quickDiffPatch } from '../editor/quick-diff-actions'
import {
  clearEditorBlameStatus,
  getEditorBlameStatus,
  setEditorBlameStatus
} from '../editor/editor-status-store'
import {
  loadScmSettings,
  saveScmSettings,
  subscribeScmSettings,
  type ScmSettings
} from '../scm/scm-settings'

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
  /** Opens Source Control History filtered to this file. */
  onHistory?: () => void
  /** HEAD text for quick diff; null/undefined means no baseline. */
  original?: string | null
  /** Replaces the buffer after a quick-diff revert changed the file on disk. */
  onQuickDiffChanged?: (text: string) => void
  /** Session whose worktree supplies blame and quick-diff actions. */
  sessionId?: string
  /**
   * `monaco` uses the bundled standalone editor; `plain` keeps the native
   * textarea. The task workbench stays on `plain` until Monaco acceptance is
   * complete there.
   */
  engine?: 'monaco' | 'plain'
}

const TAB_WIDTH = 2

type MonacoHandle = {
  editor: MonacoTypes.editor.IStandaloneCodeEditor
  model: MonacoTypes.editor.ITextModel
  monaco: MonacoApi
}

type CachedMonacoModel = {
  model: MonacoTypes.editor.ITextModel
  monaco: MonacoApi
}

/**
 * Models outlive the editor instance so switching tabs keeps undo history.
 *
 * Monaco stores the undo stack on the model, not the editor. Recreating a model
 * for every tab switch would silently throw that history away. Carets are kept
 * beside the models for the same reason.
 */
const monacoModels = new Map<string, CachedMonacoModel>()
const monacoCarets = new Map<string, { line: number; column: number }>()
const MONACO_MODEL_LIMIT = 20

function modelKey(sessionId: string | undefined, path: string): string {
  return `${sessionId ?? ''}\u0000${path}`
}

function evictOldMonacoModels(keep: string): void {
  if (monacoModels.size < MONACO_MODEL_LIMIT) return
  for (const key of monacoModels.keys()) {
    if (key === keep) continue
    const cached = monacoModels.get(key)
    monacoModels.delete(key)
    monacoCarets.delete(key)
    cached?.model.dispose()
    if (monacoModels.size < MONACO_MODEL_LIMIT) return
  }
}

type QuickPeekState = {
  phase: 'idle' | 'checking' | 'ready' | 'error'
  reason?: string
  gitPatch?: string
}

/**
 * A code editor with a Monaco primary path and a platform-native fallback.
 *
 * Monaco is imported lazily and configured with an inlined worker, so a
 * packaged offline window never fetches a CDN asset or a separate worker file.
 * If it fails to load, the textarea keeps editing available and a small banner
 * explains the fallback. Both paths share the header, save shortcut and
 * caret/goto-line behaviour.
 */
export default function CodeEditor({
  path,
  value,
  dirty,
  gotoLine,
  onChange,
  onSave,
  onClose,
  onHistory,
  original = null,
  onQuickDiffChanged,
  sessionId,
  engine = 'plain'
}: CodeEditorProps): React.JSX.Element {
  const t = useT()
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [monacoState, setMonacoState] = useState<'loading' | 'ready' | 'failed'>(
    engine === 'monaco' ? 'loading' : 'failed'
  )
  const [quickChanges, setQuickChanges] = useState<LineChange[]>([])
  const [peekIndex, setPeekIndex] = useState<number | null>(null)
  const [peekState, setPeekState] = useState<QuickPeekState>({ phase: 'idle' })
  const [peekNote, setPeekNote] = useState<string | null>(null)
  const [applyingQuick, setApplyingQuick] = useState(false)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const quickChangesRef = useRef<LineChange[]>([])
  quickChangesRef.current = quickChanges
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  const [blameLines, setBlameLines] = useState<GitBlameLine[]>([])
  const decorationIds = useRef<string[]>([])
  const blameDecorationIds = useRef<string[]>([])
  useEffect(() => subscribeScmSettings(setSettings), [])
  const container = useRef<HTMLDivElement | null>(null)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const gutter = useRef<HTMLDivElement | null>(null)
  const handle = useRef<MonacoHandle | null>(null)
  const contentListenerRef = useRef<MonacoTypes.IDisposable | null>(null)
  const suppressChange = useRef(false)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const valueRef = useRef(value)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  valueRef.current = value

  const lineCount = useMemo(() => value.split('\n').length, [value])
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_unused, index) => String(index + 1)),
    [lineCount]
  )

  // Monaco lifecycle: one editor per component, one cached model per file.
  // Callbacks and the latest value live in refs so typing does not recreate the
  // editor on every parent render; the model cache preserves undo per tab.
  useEffect(() => {
    if (engine !== 'monaco') {
      setMonacoState('failed')
      return
    }
    let cancelled = false
    setMonacoState('loading')
    const key = modelKey(sessionId, path)
    void import('../editor/monaco')
      .then(({ getMonaco, languageForPath }) => {
        if (cancelled || container.current === null) return
        const monaco = getMonaco()
        let cached = monacoModels.get(key)
        if (cached === undefined) {
          evictOldMonacoModels(key)
          const uri = monaco.Uri.parse(`inmemory://icode/${encodeURIComponent(key)}`)
          cached = {
            monaco,
            model: monaco.editor.createModel(valueRef.current, languageForPath(path), uri)
          }
          monacoModels.set(key, cached)
        }
        const model = cached.model
        if (valueRef.current !== model.getValue()) {
          suppressChange.current = true
          model.setValue(valueRef.current)
          suppressChange.current = false
        }
        const editor = monaco.editor.create(container.current, {
          model,
          theme: monacoThemeForDocument(),
          automaticLayout: true,
          fontFamily: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
          fontSize: 12,
          lineHeight: 18,
          tabSize: TAB_WIDTH,
          insertSpaces: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          renderWhitespace: 'selection',
          wordWrap: 'off',
          fixedOverflowWidgets: true,
          padding: { top: 8, bottom: 8 },
          overviewRulerLanes: 2,
          glyphMargin: true,
          folding: true
        })
        const contentListener = model.onDidChangeContent(() => {
          if (!suppressChange.current) onChangeRef.current(model.getValue())
        })
        editor.onDidChangeCursorPosition((event) => {
          const position = { line: event.position.lineNumber, column: event.position.column }
          monacoCarets.set(key, position)
          setCaret(position)
        })
        const rememberedCaret = monacoCarets.get(key)
        if (rememberedCaret !== undefined) {
          editor.setPosition({
            lineNumber: rememberedCaret.line,
            column: rememberedCaret.column
          })
          setCaret(rememberedCaret)
        }
        editor.onMouseDown((event) => {
          if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
          const line = event.target.position?.lineNumber ?? event.target.range?.startLineNumber
          if (line === undefined) return
          const index = quickChangeForLine(quickChangesRef.current, line)
          if (index !== null) setPeekIndex(index)
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current()
        })
        handle.current = { editor, model, monaco }
        decorationIds.current = []
        blameDecorationIds.current = []
        ;(container.current as HTMLElement & { __icodeEditor?: unknown }).__icodeEditor = editor
        contentListenerRef.current = contentListener
        setMonacoState('ready')
      })
      .catch(() => {
        if (!cancelled) setMonacoState('failed')
      })
    return () => {
      cancelled = true
      const current = handle.current
      handle.current = null
      contentListenerRef.current?.dispose()
      contentListenerRef.current = null
      if (container.current !== null) {
        delete (container.current as HTMLElement & { __icodeEditor?: unknown }).__icodeEditor
      }
      decorationIds.current = []
      blameDecorationIds.current = []
      current?.editor.dispose()
      // The model is owned by the cache, not the editor instance.
    }
  }, [engine, path, sessionId])

  // Parent-driven value changes (reload, save) update the model without
  // re-running the editor lifecycle or losing the caret.
  useEffect(() => {
    const current = handle.current
    if (current === null || current.model.getValue() === value) return
    const position = current.editor.getPosition()
    suppressChange.current = true
    current.model.setValue(value)
    if (position !== null) current.editor.setPosition(position)
    suppressChange.current = false
  }, [value])

  // Quick diff is debounced and bounded: typing never runs an unbounded diff
  // on the critical path, and very large file pairs skip decorations.
  useEffect(() => {
    if (engine !== 'monaco' || original === null) {
      setQuickChanges([])
      return
    }
    if (original.length + value.length > 8_000_000) {
      setQuickChanges([])
      return
    }
    const timer = window.setTimeout(() => setQuickChanges(lineDiff(original, value)), 180)
    return () => window.clearTimeout(timer)
  }, [engine, original, value])

  const peekChange = peekIndex !== null ? quickChanges[peekIndex] ?? null : null

  useEffect(() => {
    if (peekChange === null) {
      setPeekState({ phase: 'idle' })
      setPeekNote(null)
      setConfirmRevert(false)
      return
    }
    setPeekNote(null)
    setConfirmRevert(false)
    if (sessionId === undefined) {
      setPeekState({ phase: 'error', reason: t('editor.quickDiffNeedSession') })
      return
    }
    if (dirty) {
      setPeekState({ phase: 'ready', reason: t('editor.quickDiffSaveFirst') })
      return
    }
    let cancelled = false
    setPeekState({ phase: 'checking' })
    const request = (scope: 'staged' | 'unstaged') =>
      callApi<FileDiffResult>(
        window.icode.git.changeDiff({
          sessionId,
          path,
          scope,
          status: 'modified',
          binary: false,
          symlink: null,
          additions: null,
          deletions: null
        })
      )
    void (async (): Promise<void> => {
      const [staged, unstaged] = await Promise.all([request('staged'), request('unstaged')])
      if (cancelled) return
      const failure = (result: typeof staged): string | null => {
        if (!result.ok) return result.error.message
        return result.value.status === 'available' ? null : result.value.detail
      }
      const stagedFailure = failure(staged)
      if (stagedFailure !== null) {
        setPeekState({ phase: 'error', reason: stagedFailure })
        return
      }
      const stagedPatch =
        staged.ok && staged.value.status === 'available' ? staged.value.patch : ''
      if (stagedPatch.includes('@@ ')) {
        setPeekState({
          phase: 'ready',
          reason: t('editor.quickDiffAlreadyStaged')
        })
        return
      }
      const unstagedFailure = failure(unstaged)
      if (unstagedFailure !== null) {
        setPeekState({ phase: 'error', reason: unstagedFailure })
        return
      }
      const gitPatch =
        unstaged.ok && unstaged.value.status === 'available' ? unstaged.value.patch : ''
      if (!gitPatch.includes('@@ ')) {
        setPeekState({ phase: 'ready', reason: t('editor.quickDiffNoUnstaged') })
        return
      }
      setPeekState({ phase: 'ready', gitPatch })
    })()
    return () => {
      cancelled = true
    }
  }, [dirty, path, peekChange, sessionId])

  useEffect(() => {
    const current = handle.current
    if (current === null || monacoState !== 'ready') return
    const model = current.model
    const monaco = current.monaco
    const decorations: MonacoTypes.editor.IModelDeltaDecoration[] = []
    for (const change of quickChanges) {
      if (change.newCount > 0) {
        for (
          let line = change.newStart;
          line < change.newStart + change.newCount;
          line += 1
        ) {
          const safe = Math.min(Math.max(1, line), model.getLineCount())
          decorations.push({
            range: new monaco.Range(safe, 1, safe, model.getLineMaxColumn(safe)),
            options: {
              isWholeLine: true,
              linesDecorationsClassName:
                change.oldCount > 0 ? 'icode-quick-diff-modified' : 'icode-quick-diff-added',
              glyphMarginClassName: `icode-quick-diff-glyph ${
                change.oldCount > 0 ? 'icode-quick-diff-glyph-modified' : 'icode-quick-diff-glyph-added'
              }`,
              overviewRuler: {
                color:
                  change.oldCount > 0 ? 'rgba(88,166,255,0.85)' : 'rgba(63,185,80,0.85)',
                position: monaco.editor.OverviewRulerLane.Right
              }
            }
          })
        }
      } else if (change.oldCount > 0) {
        const safe = Math.min(Math.max(1, change.newAnchor), model.getLineCount())
        decorations.push({
          range: new monaco.Range(safe, 1, safe, model.getLineMaxColumn(safe)),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'icode-quick-diff-deleted',
            glyphMarginClassName: 'icode-quick-diff-glyph icode-quick-diff-glyph-deleted',
            overviewRuler: {
              color: 'rgba(248,81,73,0.85)',
              position: monaco.editor.OverviewRulerLane.Left
            }
          }
        })
      }
    }
    decorationIds.current = current.editor.deltaDecorations(
      decorationIds.current,
      decorations
    )
  }, [monacoState, quickChanges])

  // Blame for the file, fetched once per path while the annotation is enabled.
  useEffect(() => {
    if (
      engine !== 'monaco' ||
      !settings.inlineBlame ||
      sessionId === undefined ||
      monacoState !== 'ready' ||
      dirty
    ) {
      // Unsaved text cannot be blamed truthfully; the annotation returns after
      // the save writes the working file.
      setBlameLines([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void callApi<GitBlamePayload>(window.icode.git.blame({ sessionId, path })).then((result) => {
        if (cancelled) return
        if (result.ok && result.value.status === 'ok') setBlameLines(result.value.lines)
        else setBlameLines([])
      })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [dirty, engine, monacoState, path, sessionId, settings.inlineBlame, value])

  // The caret line owns one after-content decoration. It is replaced, never
  // accumulated, so switching lines does not leave stale blame behind.
  useEffect(() => {
    const current = handle.current
    if (current === null || monacoState !== 'ready') return
    if (!settings.inlineBlame) {
      blameDecorationIds.current = current.editor.deltaDecorations(
        blameDecorationIds.current,
        []
      )
      return
    }
    const info = blameLines.find((line) => line.line === caret.line)
    const decorations: MonacoTypes.editor.IModelDeltaDecoration[] = []
    if (info !== undefined) {
      const text = info.committed
        ? `${info.author} · ${relativeTime(info.authorTime)}${info.summary ? ` · ${info.summary}` : ''}`
        : t('editor.blameYou')
      const line = Math.min(Math.max(1, info.line), current.model.getLineCount())
      const column = current.model.getLineMaxColumn(line)
      // Monaco 0.57 does not render `after` content for an empty range at
      // line end; the whole-line range still places the annotation at the end.
      decorations.push({
        range: new current.monaco.Range(line, 1, line, column),
        options: {
          after: {
            content: `  ${text.slice(0, 160)}`,
            inlineClassName: 'icode-blame-inline'
          },
          hoverMessage: {
            value: `${info.oid.slice(0, 12)} · ${info.author} · ${formatDateTime(
              getLocale(),
              info.authorTime * 1000
            )}${info.summary ? `\n${info.summary}` : ''}`
          }
        }
      })
    }
    blameDecorationIds.current = current.editor.deltaDecorations(
      blameDecorationIds.current,
      decorations
    )
  }, [blameLines, caret, monacoState, settings.inlineBlame])

  // Publish the caret line for the global status bar. It is cleared when the
  // file closes, the buffer becomes dirty, or blame is disabled.
  useEffect(() => {
    const info =
      engine === 'monaco' && monacoState !== 'failed' && sessionId !== undefined
        ? blameLines.find((line) => line.line === caret.line)
        : undefined
    if (info === undefined) {
      clearEditorBlameStatus()
      return
    }
    setEditorBlameStatus({
      path,
      line: info.line,
      oid: info.oid,
      author: info.author,
      authorTime: info.authorTime,
      summary: info.summary,
      committed: info.committed
    })
  }, [blameLines, caret.line, engine, monacoState, path, sessionId])

  useEffect(() => {
    return () => {
      if (getEditorBlameStatus()?.path === path) clearEditorBlameStatus()
    }
  }, [path])

  // Follow the app appearance; the app writes data-theme on the root element.
  useEffect(() => {
    if (monacoState !== 'ready') return
    const observer = new MutationObserver(() => {
      const current = handle.current
      if (current !== null) current.monaco.editor.setTheme(monacoThemeForDocument())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [monacoState])

  useEffect(() => {
    if (gotoLine === null || gotoLine === undefined) return
    const current = handle.current
    if (current !== null) {
      const target = Math.max(1, Math.min(gotoLine, current.model.getLineCount()))
      current.editor.revealLineInCenter(target)
      current.editor.setPosition({ lineNumber: target, column: 1 })
      current.editor.focus()
      return
    }
    const element = textarea.current
    if (element === null) return
    const lines = value.split('\n')
    const target = Math.max(1, Math.min(gotoLine, lines.length))
    let offset = 0
    for (let index = 0; index < target - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1
    element.focus()
    element.setSelectionRange(offset, offset)
    setCaret({ line: target, column: 1 })
  }, [gotoLine, monacoState, value])

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

  const showMonaco = engine === 'monaco' && monacoState !== 'failed'
  const applyQuickChange = async (action: 'stage' | 'revert'): Promise<void> => {
    if (
      sessionId === undefined ||
      peekChange === null ||
      peekState.gitPatch === undefined ||
      applyingQuick
    ) {
      return
    }
    const built = quickDiffPatch(
      peekState.gitPatch,
      peekChange,
      action === 'stage' ? 'forward' : 'reverse'
    )
    if (built.status === 'error') {
      setPeekNote(built.error)
      return
    }
    setApplyingQuick(true)
    setPeekNote(null)
    try {
      const result = await callApi<GitApplyPatchPayload>(
        window.icode.git.applyPatch({
          sessionId,
          path,
          patch: built.patch,
          mode: action === 'stage' ? 'stage' : 'discard'
        })
      )
      if (!result.ok) {
        setPeekNote(result.error.message)
        return
      }
      if (result.value.status === 'unavailable') {
        setPeekNote(result.value.detail)
        return
      }
      if (action === 'stage') {
        setPeekNote(t('editor.quickDiffStagedNote'))
        setPeekState({
          phase: 'ready',
          reason: t('editor.quickDiffStagedReason')
        })
        return
      }
      const read = await callApi<FileContentPayload>(window.icode.files.read({ sessionId, path }))
      if (read.ok && read.value.status === 'ok') {
        onQuickDiffChanged?.(read.value.text)
      } else {
        setPeekNote(t('editor.quickDiffRevertedReload'))
      }
      setPeekIndex(null)
      setConfirmRevert(false)
    } finally {
      setApplyingQuick(false)
    }
  }

  const quickCounts = quickDiffCounts(quickChanges)
  const peekRemoved =
    peekChange !== null && peekChange.oldCount > 0 && original !== null
      ? original
          .split('\n')
          .slice(peekChange.oldStart - 1, peekChange.oldStart - 1 + peekChange.oldCount)
      : []
  const peekAdded =
    peekChange !== null && peekChange.newCount > 0
      ? value
          .split('\n')
          .slice(peekChange.newStart - 1, peekChange.newStart - 1 + peekChange.newCount)
      : []
  const peekRows = [
    ...peekRemoved.slice(0, 60).map((text, index) => ({
      kind: 'remove' as const,
      line: peekChange!.oldStart + index,
      text
    })),
    ...peekAdded.slice(0, 60).map((text, index) => ({
      kind: 'add' as const,
      line: peekChange!.newStart + index,
      text
    }))
  ]
  const peekPeekTruncated = peekRemoved.length > 60 || peekAdded.length > 60
  const peekCanApply =
    peekState.phase === 'ready' && peekState.gitPatch !== undefined && !applyingQuick
  const peekMessage = peekNote ?? peekState.reason

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="code-editor">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11px] text-foreground" data-testid="editor-path">
            {path}
          </span>
          {dirty ? (
            <span className="shrink-0 rounded bg-signal-weak px-1 text-[9px] text-signal" data-testid="editor-dirty">
              {t('editor.unsaved')}
            </span>
          ) : null}
          {showMonaco ? (
            <span className="shrink-0 rounded border border-border px-1 text-[8.5px] text-muted-foreground">
              Monaco
            </span>
          ) : null}
          {showMonaco && original !== null ? (
            <button
              type="button"
              className="shrink-0 rounded border border-border px-1 font-mono text-[8.5px] text-muted-foreground hover:bg-muted disabled:opacity-50"
              title={t('editor.reviewHead')}
              aria-pressed={peekIndex !== null}
              disabled={quickChanges.length === 0}
              data-testid="editor-quick-diff"
              onClick={() => setPeekIndex(0)}
            >
              <span className="text-add">+{quickCounts.additions}</span>{' '}
              <span className="text-destructive">−{quickCounts.deletions}</span>
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[9px] text-muted-foreground" data-testid="editor-caret">
            {caret.line}:{caret.column}
          </span>
          {onHistory ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onHistory}
              data-testid="files-open-history"
              title={t('editor.historyTitle')}
            >
              <History size={10} />
              {t('editor.history')}
            </button>
          ) : null}
          {showMonaco && sessionId !== undefined ? (
            <button
              type="button"
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                settings.inlineBlame
                  ? 'border-info/50 bg-info-weak text-info'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              aria-pressed={settings.inlineBlame}
              onClick={() =>
                saveScmSettings({ ...settings, inlineBlame: !settings.inlineBlame })
              }
              data-testid="editor-blame-toggle"
              title={t('editor.blameTitle')}
            >
              {t('editor.blame')}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onSave}
            data-testid="editor-save"
            title={t('editor.saveTitle', { shortcut: shortcutLabel('S') })}
          >
            {t('editor.save')}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onClose}
            data-testid="editor-close"
            title={t('editor.close')}
          >
            {t('editor.close')}
          </button>
        </div>
      </div>

      {engine === 'monaco' && monacoState === 'failed' ? (
        <p
          className="border-b border-signal/40 bg-signal-weak px-3 py-1 text-[10px] text-signal"
          data-testid="editor-monaco-fallback"
        >
          {t('editor.fallback')}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showMonaco ? (
          <div className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={container}
              className="absolute inset-0"
              data-testid="monaco-editor"
            />
            {monacoState === 'loading' ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
                {t('editor.loading')}
              </div>
            ) : null}
            {peekChange !== null && peekIndex !== null ? (
              <div
                className="absolute right-3 top-3 z-20 flex max-h-[72%] w-[min(560px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
                role="dialog"
                aria-label={t('editor.quickDiffAria')}
                data-testid="quick-diff-peek"
              >
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
                  <span className="text-[10.5px] font-medium text-foreground">
                    {t('editor.quickChange', {
                      index: peekIndex + 1,
                      count: quickChanges.length
                    })}
                  </span>
                  <span className="font-mono text-[9.5px] text-muted-foreground">
                    {peekChange.oldCount > 0 ? `−${String(peekChange.oldCount)}` : ''}{' '}
                    {peekChange.newCount > 0 ? `+${String(peekChange.newCount)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t('editor.closeQuickDiff')}
                    data-testid="quick-diff-close"
                    onClick={() => setPeekIndex(null)}
                  >
                    <X size={11} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[10.5px] leading-[1.55]">
                  {peekRows.length === 0 ? (
<p className="px-1 py-2 text-muted-foreground">
                      {t('editor.noVisibleLines')}
                    </p>
                  ) : (
                    peekRows.map((row, rowIndex) => (
                      <div key={`${row.kind}-${String(rowIndex)}`} className="flex gap-2">
                        <span className="w-8 shrink-0 text-right text-muted-foreground/70">
                          {row.line}
                        </span>
                        <span
                          className={`min-w-0 whitespace-pre${
                            row.kind === 'remove' ? ' text-destructive' : ' text-add'
                          }`}
                        >
                          {row.kind === 'remove' ? '−' : '+'} {row.text}
                        </span>
                      </div>
                    ))
                  )}
                  {peekPeekTruncated ? (
                    <p className="px-1 py-1 text-[9.5px] text-muted-foreground">
                      {t('editor.quickDiffTruncated')}
                    </p>
                  ) : null}
                </div>
                {peekState.phase === 'checking' ? (
                  <p className="shrink-0 border-t border-border px-2.5 py-1 text-[9.5px] text-muted-foreground">
                    {t('editor.checkingIndex')}
                  </p>
                ) : null}
                {peekMessage !== null && peekMessage !== undefined ? (
                  <p
                    className={`shrink-0 border-t border-border px-2.5 py-1 text-[9.5px] ${
                      peekState.phase === 'error' ? 'text-destructive' : 'text-muted-foreground'
                    }`}
                    data-testid="quick-diff-peek-status"
                  >
                    {peekMessage}
                  </p>
                ) : null}
                <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
                  {confirmRevert ? (
                    <>
                      <span className="text-[9.5px] text-destructive">
                        {t('editor.quickDiscardConfirm')}
                      </span>
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded border border-destructive bg-destructive px-1.5 py-0.5 text-[9.5px] text-white hover:opacity-90 disabled:opacity-50"
                          disabled={applyingQuick}
                          data-testid="quick-diff-revert-confirm"
                          onClick={() => void applyQuickChange('revert')}
                        >
                          {applyingQuick ? t('editor.reverting') : t('editor.revert')}
                        </button>
                        <button
                          type="button"
                          className="rounded px-1.5 py-0.5 text-[9.5px] text-muted-foreground hover:text-foreground"
                          data-testid="quick-diff-revert-cancel"
                          onClick={() => setConfirmRevert(false)}
                        >
                          {t('common.cancel')}
                        </button>
                      </span>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rounded border border-border px-1.5 py-0.5 text-[9.5px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={!peekCanApply}
                        data-testid="quick-diff-stage"
                        onClick={() => void applyQuickChange('stage')}
                      >
                        {applyingQuick ? t('editor.applying') : t('editor.stageChange')}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-destructive/40 px-1.5 py-0.5 text-[9.5px] text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={!peekCanApply}
                        data-testid="quick-diff-revert"
                        onClick={() => setConfirmRevert(true)}
                      >
                        {t('editor.revertChange')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <>
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
                if (event.key === 'Tab') {
                  event.preventDefault()
                  const element = event.currentTarget
                  const start = element.selectionStart
                  const end = element.selectionEnd
                  const next = `${value.slice(0, start)}${' '.repeat(TAB_WIDTH)}${value.slice(end)}`
                  onChange(next)
                  window.requestAnimationFrame(() => {
                    element.setSelectionRange(start + TAB_WIDTH, start + TAB_WIDTH)
                  })
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}


function relativeTime(seconds: number): string {
  if (seconds <= 0) return ''
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (delta < 60) return translate('relative.justNow')
  if (delta < 3600) {
    return translate('relative.minutesAgo', { count: Math.floor(delta / 60) })
  }
  if (delta < 86_400) {
    return translate('relative.hoursAgo', { count: Math.floor(delta / 3600) })
  }
  if (delta < 86_400 * 30) {
    return translate('relative.daysAgo', { count: Math.floor(delta / 86_400) })
  }
  return formatDateTime(getLocale(), seconds * 1000, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
