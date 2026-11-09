import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import type {
  FileContentPayload,
  GitConflictFilePayload,
  GitConflictSide
} from '../../../shared/icode-api'
import { callApi } from '../lib/api'
import {
  parseConflictBlocks,
  replaceConflictBlock,
  type ConflictBlock,
  type MergeChoice
} from '../review/merge-conflicts'
import MonacoTextPane from './MonacoTextPane'

type Props = {
  sessionId: string
  path: string
  /** Writes the result and stages the resolved path; refreshes Source Control. */
  onResolve: (text: string) => Promise<{ ok: boolean; message?: string }>
  onShowDiff: () => void
}

type Sides = {
  base: GitConflictSide | null
  current: GitConflictSide
  incoming: GitConflictSide
}

import { useT, useTp } from '../i18n/use-i18n'

export default function MergeEditor({
  sessionId,
  path,
  onResolve,
  onShowDiff
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const [sides, setSides] = useState<Sides | null>(null)
  const [resultText, setResultText] = useState('')
  const [initialResult, setInitialResult] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showBase, setShowBase] = useState(true)
  const [active, setActive] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSaveError(null)
    setSides(null)
    setResultText('')
    setInitialResult('')
    setActive(0)
    void (async (): Promise<void> => {
      const [conflict, result] = await Promise.all([
        callApi<GitConflictFilePayload>(
          window.icode.git.conflictFile({ sessionId, path })
        ),
        callApi<FileContentPayload>(window.icode.files.read({ sessionId, path }))
      ])
      if (cancelled) return
      if (!conflict.ok) {
        setLoadError(conflict.error.message)
        setLoading(false)
        return
      }
      if (conflict.value.status !== 'ok') {
        setLoadError(conflict.value.detail)
        setLoading(false)
        return
      }
      if (!result.ok) {
        setLoadError(result.error.message)
        setLoading(false)
        return
      }
      if (result.value.status !== 'ok') {
        setLoadError(result.value.detail)
        setLoading(false)
        return
      }
      const value = conflict.value
      if (
        value.current.binary ||
        value.incoming.binary ||
        value.base?.binary === true ||
        value.current.tooLarge ||
        value.incoming.tooLarge ||
        value.base?.tooLarge === true ||
        result.value.binary ||
        result.value.tooLarge
      ) {
        setLoadError(
          t('merge.binaryStagesFailed')
        )
        setLoading(false)
        return
      }
      setSides({ base: value.base, current: value.current, incoming: value.incoming })
      setResultText(result.value.text)
      setInitialResult(result.value.text)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [path, sessionId])

  const blocks = useMemo(() => parseConflictBlocks(resultText), [resultText])
  const activeBlock: ConflictBlock | null =
    blocks.length === 0 ? null : blocks[Math.min(active, blocks.length - 1)] ?? null

  useEffect(() => {
    if (active >= blocks.length && blocks.length > 0) setActive(blocks.length - 1)
    if (blocks.length === 0 && active !== 0) setActive(0)
  }, [active, blocks.length])

  const labels = blocks[0]
  const currentLabel = labels?.currentLabel ?? 'Current'
  const baseLabel = labels?.baseLabel ?? 'Base'
  const incomingLabel = labels?.incomingLabel ?? 'Incoming'

  const applyChoice = (choice: MergeChoice): void => {
    if (activeBlock === null) return
    setSaveError(null)
    setResultText((current) => replaceConflictBlock(current, activeBlock, choice))
  }

  const go = (delta: number): void => {
    if (blocks.length === 0) return
    setActive((current) => {
      const next = current + delta
      return (next + blocks.length) % blocks.length
    })
  }

  const save = async (): Promise<void> => {
    if (saving || loading || sides === null || blocks.length > 0 || loadError !== null) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await onResolve(resultText)
      if (!result.ok) setSaveError(result.message ?? t('merge.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
      <span className="min-w-0 truncate font-mono text-[11px] text-foreground">{path}</span>
      <span
        className="rounded-sm border border-destructive/40 bg-destructive/10 px-1 text-[9px] font-semibold uppercase text-destructive"
        data-testid="merge-conflict-count"
      >
        {blocks.length === 0 ? t('merge.resolved') : tp('merge.conflicts', blocks.length)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {sides?.base ? (
          <button
            type="button"
            className={`rounded border px-1.5 py-0.5 text-[9.5px] ${
              showBase
                ? 'border-signal-line bg-signal-weak text-signal'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
            aria-pressed={showBase}
            data-testid="merge-toggle-base"
            onClick={() => setShowBase((value) => !value)}
          >
            {t('merge.base')}
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="merge-reset"
          onClick={() => {
            setResultText(initialResult)
            setSaveError(null)
            setActive(0)
          }}
        >
          <RotateCcw size={10} />
          {t('merge.reset')}
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="merge-show-diff"
          onClick={onShowDiff}
        >
          {t('merge.showDiff')}
        </button>
        <button
          type="button"
          className="rounded border border-signal-line bg-signal px-2 py-0.5 text-[9.5px] font-medium text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={saving || loading || sides === null || blocks.length > 0 || loadError !== null}
          title={
            blocks.length > 0
              ? t('merge.resolveBeforeStage')
              : t('merge.resolveMarkers')
          }
          data-testid="merge-save"
          onClick={() => void save()}
        >
          {saving ? t('files.saving') : t('merge.saveStage')}
        </button>
      </span>
    </div>
  )

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="merge-editor">
        {header}
        <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
          <Loader2 size={12} className="mr-2 animate-spin" />
          {t('merge.readingStages')}
        </div>
      </div>
    )
  }

  if (loadError !== null || sides === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="merge-editor">
        {header}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-md border border-destructive/40 bg-card p-4 text-center">
            <AlertTriangle size={16} className="mx-auto text-destructive" />
            <p className="mt-2 text-[12px] font-medium text-destructive">{t('merge.unavailable')}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {loadError ?? t('merge.stagesFailed')}
            </p>
            <button
              type="button"
              className="mt-3 rounded border border-border px-2 py-1 text-[10.5px] hover:bg-muted"
              onClick={onShowDiff}
            >
              {t('merge.showDiff')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const paneLabel = (prefix: string, label: string): string =>
    label === prefix ? prefix : `${prefix} · ${label}`
  const panes: Array<{ key: string; label: string; text: string; testId: string }> = []
  if (showBase && sides.base !== null) {
    panes.push({
      key: 'base',
      label: paneLabel('Base', baseLabel),
      text: sides.base.text,
      testId: 'merge-pane-base'
    })
  }
  panes.push(
    {
      key: 'current',
      label: paneLabel('Current', currentLabel),
      text: sides.current.text,
      testId: 'merge-pane-current'
    },
    {
      key: 'incoming',
      label: paneLabel('Incoming', incomingLabel),
      text: sides.incoming.text,
      testId: 'merge-pane-incoming'
    }
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="merge-editor">
      {header}
      <div
        className={`grid min-h-0 flex-[0_0_38%] border-b border-border ${
          panes.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
        }`}
      >
        {panes.map((pane) => (
          <section key={pane.key} className="flex min-w-0 flex-col border-r border-border last:border-r-0">
            <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              {pane.label}
            </div>
            <div className="min-h-0 flex-1">
              <MonacoTextPane
                path={path}
                value={pane.text}
                readOnly
                testId={pane.testId}
                ariaLabel={pane.label}
              />
            </div>
          </section>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-card px-2 py-1.5">
        <button
          type="button"
          className="rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={blocks.length === 0}
          data-testid="merge-prev"
          aria-label={t('merge.previousConflict')}
          onClick={() => go(-1)}
        >
          <ChevronLeft size={11} />
        </button>
        <button
          type="button"
          className="rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={blocks.length === 0}
          data-testid="merge-next"
          aria-label={t('merge.nextConflict')}
          onClick={() => go(1)}
        >
          <ChevronRight size={11} />
        </button>
        <span className="ml-1 font-mono text-[10px] text-muted-foreground" data-testid="merge-active-conflict">
          {blocks.length === 0
              ? t('merge.noMarkers')
              : `${String(active + 1)} / ${String(blocks.length)}`}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-[9.5px] hover:bg-muted disabled:opacity-40"
            disabled={activeBlock === null}
            data-testid="merge-accept-current"
            onClick={() => applyChoice('current')}
          >
            {t('merge.acceptCurrent')}
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-[9.5px] hover:bg-muted disabled:opacity-40"
            disabled={activeBlock === null}
            data-testid="merge-accept-incoming"
            onClick={() => applyChoice('incoming')}
          >
            {t('merge.acceptIncoming')}
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-[9.5px] hover:bg-muted disabled:opacity-40"
            disabled={activeBlock === null}
            data-testid="merge-accept-both"
            onClick={() => applyChoice('both')}
          >
            {t('merge.acceptBoth')}
          </button>
        </span>
      </div>

      {saveError !== null ? (
        <div
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[10px] text-destructive"
          data-testid="merge-error"
        >
          {saveError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-2 py-1">
          <span className="text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('merge.result')}
          </span>
          <span className="text-[9.5px] text-muted-foreground">
            {blocks.length > 0
              ? t('merge.resolveMarkers')
              : t('merge.noMarkersLeft')}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <MonacoTextPane
            path={path}
            value={resultText}
            readOnly={false}
            testId="merge-result"
            ariaLabel={t('merge.resultAria')}
            onChange={(value) => {
              setSaveError(null)
              setResultText(value)
            }}
            revealLine={activeBlock?.startLine}
          />
        </div>
      </div>
    </div>
  )
}
