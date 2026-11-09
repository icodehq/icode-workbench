import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import {
  HARNESS_DEFINITIONS,
  HARNESS_IDS,
  harnessLabel,
  type HarnessDetection,
  type HarnessId
} from '../../../shared/domain/harness'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { repositoryPreparationView } from '../lib/repository-preparation'
import type { CreateSessionRequest } from '../state/use-workspace'
import { useT } from '../i18n/use-i18n'
import type { Translator } from '../i18n/i18n-store'

type Props = {
  repos: RepositorySummary[]
  activeRepoId: string | null
  harnesses: HarnessDetection[]
  harnessLoading: boolean
  harnessError: AppError | null
  creating: boolean
  onClose: () => void
  onCreate: (input: CreateSessionRequest) => Promise<boolean>
  /** Re-detect for one repository's execution target (`repoId` omitted = this machine). */
  onRefreshHarnesses: (force: boolean, repoId?: string | null) => Promise<void>
}

function detectionTone(state: HarnessDetection['state']): string {
  if (state === 'available') return 'text-add'
  if (state === 'detection_failed') return 'text-signal'
  return 'text-muted-foreground'
}

function detectionLabel(state: HarnessDetection['state'], t: Translator): string {
  if (state === 'available') return t('common.available')
  if (state === 'detection_failed') return t('common.probeFailed')
  return t('common.unavailable')
}

/** A group heading that says what the actions below it will do. */
function SectionHeading({
  title,
  hint,
  testId
}: {
  title: string
  hint: string
  testId: string
}): React.JSX.Element {
  return (
    <div className="px-1 pt-1" data-testid={testId}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
        {title}
      </p>
      <p className="mt-0.5 text-[10.5px] text-muted-foreground">{hint}</p>
    </div>
  )
}

/**
 * One selectable Harness.
 *
 * `labelOverride` exists for the only case where the Harness name is misleading:
 * on a WSL repository the `shell` Harness is the WSL terminal (Path A), not the
 * desktop's own shell.
 */
function HarnessRow({
  entry,
  selected,
  onSelect,
  labelOverride
}: {
  entry: HarnessDetection
  selected: boolean
  onSelect: () => void
  labelOverride?: string | undefined
}): React.JSX.Element {
  const t = useT()
  const selectable = entry.state === 'available'
  const isSelected = selected && selectable
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        isSelected ? 'border-accent/70 bg-accent/10' : 'border-border bg-background'
      } ${selectable ? '' : 'opacity-70'}`}
    >
      <button
        type="button"
        className={`flex w-full items-center justify-between gap-2 text-left ${
          selectable ? 'cursor-pointer' : 'cursor-not-allowed'
        }`}
        onClick={() => {
          if (selectable) onSelect()
        }}
        disabled={!selectable}
        data-testid={`harness-option-${entry.harness}`}
        data-harness-state={entry.state}
        data-selected={isSelected ? 'true' : 'false'}
      >
        <span className="flex items-center gap-2">
          <span
            className={`flex h-4 w-4 items-center justify-center rounded-full border ${
              isSelected ? 'border-accent bg-accent text-accent-ink' : 'border-border'
            }`}
          >
            {isSelected ? <Check size={10} /> : null}
          </span>
          <span className="text-[12.5px] font-medium">
            {labelOverride ?? HARNESS_DEFINITIONS[entry.harness].label}
          </span>
        </span>
        <span className={`text-[10px] ${detectionTone(entry.state)}`}>
          {detectionLabel(entry.state, t)}
          {entry.state === 'available' && entry.version ? ` · ${entry.version}` : ''}
        </span>
      </button>
      {entry.state !== 'available' ? (
        <p className="mt-1 pl-6 text-[10.5px] text-muted-foreground">{entry.message}</p>
      ) : null}
      <details className="mt-1 pl-6">
        <summary className="cursor-pointer text-[10.5px] text-muted-foreground hover:text-foreground">
          {t('newSession.diagnostics')}
        </summary>
        <dl className="mt-1 space-y-0.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
          <div>
            {t('newSession.diagPath', {
              path: entry.diagnostics.resolvedPath ?? t('newSession.notResolved')
            })}
          </div>
          <div>
            {t('newSession.diagProbe', { outcome: entry.diagnostics.outcome })}
            {entry.diagnostics.exitCode === null
              ? ''
              : t('newSession.diagExit', { code: entry.diagnostics.exitCode })}
            {t('newSession.diagDuration', { duration: entry.diagnostics.durationMs })}
          </div>
          {entry.diagnostics.stderrTail ? (
            <div className="whitespace-pre-wrap break-all">
              {t('newSession.diagStderr', { text: entry.diagnostics.stderrTail })}
            </div>
          ) : null}
        </dl>
      </details>
    </div>
  )
}

export default function NewSessionDialog({
  repos,
  activeRepoId,
  harnesses,
  harnessLoading,
  harnessError,
  creating,
  onClose,
  onCreate,
  onRefreshHarnesses
}: Props): React.JSX.Element {
  const t = useT()
  const available = useMemo(
    () => harnesses.filter((harness) => harness.state === 'available'),
    [harnesses]
  )
  const [repoId, setRepoId] = useState(activeRepoId ?? repos[0]?.id ?? '')
  const [harness, setHarness] = useState<HarnessId | null>(available[0]?.harness ?? null)
  const [title, setTitle] = useState('')

  const selectedRepo = repos.find((repo) => repo.id === repoId) ?? null
  const preparation = selectedRepo === null ? null : repositoryPreparationView(selectedRepo)
  const repoTarget = selectedRepo?.target ?? null
  const targetLabel =
    repoTarget === null
      ? t('newSession.thisMachine')
      : repoTarget.kind === 'wsl'
        ? `WSL ${repoTarget.distro}`
        : t('newSession.thisMachine')
  const agents = useMemo(() => harnesses.filter((entry) => entry.harness !== 'shell'), [harnesses])
  const shellEntry = harnesses.find((entry) => entry.harness === 'shell') ?? null

  /**
   * Ask for the *selected repository's* Harnesses.
   *
   * On open and whenever the repository changes: a WSL repository and a local one
   * do not share an answer, and the list is what the user chooses from.
   */
  const requested = useRef<string | null>(null)
  useEffect(() => {
    if (repoId.length === 0) return
    if (requested.current === repoId) return
    requested.current = repoId
    void onRefreshHarnesses(false, repoId)
  }, [repoId, onRefreshHarnesses])

  useEffect(() => {
    if (harness !== null && available.some((entry) => entry.harness === harness)) return
    // Prefer a Coding Agent when one exists; the terminal is the fallback, not the
    // default, because "New session" has historically meant "start an Agent".
    const preferred = available.find((entry) => entry.harness !== 'shell')
    setHarness(preferred?.harness ?? available[0]?.harness ?? null)
  }, [available, harness])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (creating || harness === null || repoId.length === 0) return
    const ok = await onCreate({
      repoId,
      harness,
      ...(title.trim().length > 0 ? { title: title.trim() } : {})
    })
    if (ok) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('newSession.title')}
    >
      <form
        className="icode-modal flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold">{t('newSession.title')}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('newSession.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <label className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('newSession.repository')}
          </label>
          <select
            className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2.5 text-[12.5px] outline-none focus:border-accent"
            value={repoId}
            onChange={(event) => setRepoId(event.target.value)}
            data-testid="new-session-repo"
          >
            {repos.map((repo) => {
              const blocked = repositoryPreparationView(repo)
              return (
                <option key={repo.id} value={repo.id} disabled={blocked !== null}>
                  {repo.displayName}
                  {repo.target.kind === 'wsl'
                    ? t('newSession.repoOptionWsl', { distro: repo.target.distro })
                    : ''}{' '}
                  — {repo.path}
                  {blocked === null ? '' : t('newSession.repoOptionBlocked', { reason: blocked.label })}
                </option>
              )
            })}
          </select>
          <p className="mt-1.5 text-[10.5px] text-muted-foreground" data-testid="new-session-target">
            {repoTarget?.kind === 'wsl'
              ? t('newSession.targetWsl', { distro: repoTarget.distro })
              : t('newSession.targetLocal')}
          </p>
          {preparation !== null ? (
            <div
              className={`mt-2 rounded-md border px-3 py-2 text-[11px] ${
                preparation.kind === 'failed'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-signal-line bg-signal-weak text-signal'
              }`}
              data-testid="new-session-preparation"
            >
              <span className="font-medium">{preparation.label}</span>
              <span className="mt-0.5 block text-[10.5px] opacity-80">
                {preparation.kind === 'failed'
                  ? t('newSession.preparationFailed', {
                      detail:
                        preparation.detail ?? t('projects.preparation.failedDetail')
                    })
                  : t('newSession.preparationPreparing')}
              </span>
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('newSession.action')}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              onClick={() => void onRefreshHarnesses(true)}
              disabled={harnessLoading}
              data-testid="harness-redetect"
            >
              <RefreshCw size={11} className={harnessLoading ? 'animate-spin' : ''} />
              {t('newSession.detectAgain')}
            </button>
          </div>

          {harnessError ? (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {t('newSession.detectionFailed', { message: harnessError.message })}
              <button
                type="button"
                className="ml-1 underline"
                onClick={() => void onRefreshHarnesses(true)}
              >
                {t('newSession.retry')}
              </button>
            </div>
          ) : null}

          <div className="mt-2 space-y-1.5" data-testid="harness-list">
            {harnessLoading && harnesses.length === 0
              ? HARNESS_IDS.map((id) => (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    {t('newSession.checking', {
                      harness: harnessLabel(id),
                      target: targetLabel
                    })}
                  </div>
                ))
              : (
                  <>
                    {/**
                     * Two actions, not one list.
                     *
                     * An Agent session runs *inside* the execution target: on this
                     * machine, or on the managed WSL host for a WSL repository. A
                     * Terminal session is always a local desktop terminal — for WSL
                     * it is `wsl.exe` on this desktop, in the chosen distro (Path A).
                     * Presenting them as one undifferentiated list is what made the
                     * two indistinguishable.
                     */}
                    <SectionHeading
                      title={t('newSession.codingAgent')}
                      hint={
                        repoTarget?.kind === 'wsl'
                          ? t('newSession.agentHintWsl', { distro: repoTarget.distro })
                          : t('newSession.agentHintLocal')
                      }
                      testId="agent-section"
                    />
                    {agents.map((entry) => (
                      <HarnessRow
                        key={entry.harness}
                        entry={entry}
                        selected={harness === entry.harness}
                        onSelect={() => setHarness(entry.harness)}
                      />
                    ))}
                    {agents.length === 0 && !harnessLoading ? (
                      <p className="px-1 text-[10.5px] text-muted-foreground">
                        {t('newSession.noAgentFor', { target: targetLabel })}
                      </p>
                    ) : null}

                    <SectionHeading
                      title={t('newSession.terminal')}
                      hint={
                        repoTarget?.kind === 'wsl'
                          ? t('newSession.terminalHintWsl', { distro: repoTarget.distro })
                          : t('newSession.terminalHintLocal')
                      }
                      testId="terminal-section"
                    />
                    {shellEntry ? (
                      <HarnessRow
                        entry={shellEntry}
                        selected={harness === 'shell'}
                        onSelect={() => setHarness('shell')}
                        labelOverride={
                          repoTarget?.kind === 'wsl' ? t('newSession.wslTerminal') : undefined
                        }
                      />
                    ) : (
                      <p className="px-1 text-[10.5px] text-muted-foreground">
                        {harnessLoading
                          ? t('newSession.checkingTerminal')
                          : t('newSession.noTerminal')}
                      </p>
                    )}
                  </>
                )}
          </div>

          {!harnessLoading && !agents.some((entry) => entry.state === 'available') ? (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-signal-line bg-signal-weak px-3 py-2 text-[11px] text-signal">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {repoTarget?.kind === 'wsl'
                  ? t('newSession.noAgentAvailableWsl', { distro: repoTarget.distro })
                  : t('newSession.noAgentAvailableLocal')}
              </span>
            </div>
          ) : null}

          <label className="mt-4 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('newSession.titleLabel')}{' '}
            <span className="normal-case tracking-normal">{t('newSession.optional')}</span>
          </label>
          <input
            className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2.5 text-[12.5px] outline-none focus:border-accent"
            placeholder={
              harness === null
                ? t('newSession.chooseHarness')
                : `${harnessLabel(harness)} · ${
                    repos.find((repo) => repo.id === repoId)?.displayName ??
                    t('newSession.repositoryFallback')
                  }`
            }
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="session-title-input"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-[10.5px] text-muted-foreground">
            {t('newSession.availableCount', {
              available: available.length,
              total: harnesses.length || HARNESS_IDS.length
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border h-9 px-3 text-[12px] hover:bg-muted"
              onClick={onClose}
            >
              {t('newSession.cancel')}
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent h-9 px-3.5 text-[12.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
              disabled={
                creating ||
                harness === null ||
                repoId.length === 0 ||
                preparation !== null
              }
              data-testid="create-session-submit"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : null}
              {t('newSession.start')}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
