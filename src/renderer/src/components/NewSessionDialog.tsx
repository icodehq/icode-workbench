import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import {
  harnessLabel,
  isAgentHarness,
  type HarnessDetection,
  type HarnessId
} from '../../../shared/domain/harness'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { repositoryPreparationView } from '../lib/repository-preparation'
import {
  groupStartFromRefs,
  startFromGroupLabelKey,
  startFromValue
} from '../lib/start-from-refs'
import type { CreateSessionRequest } from '../state/use-workspace'
import { useBranchRefs } from '../state/use-branch-refs'
import { useT } from '../i18n/use-i18n'

type Props = {
  repos: RepositorySummary[]
  activeRepoId: string | null
  /**
   * The checkout implied by the entry point: the default checkout, an existing
   * worktree, or null for a fresh worktree. The dialog does not offer a choice;
   * switching checkouts is done by opening the dialog from that row.
   */
  initialCheckout: { kind: 'default' } | { kind: 'worktree'; worktreeId: string } | null
  harnesses: HarnessDetection[]
  harnessLoading: boolean
  harnessError: AppError | null
  onClose: () => void
  onCreate: (input: CreateSessionRequest) => Promise<boolean>
  /** Re-detect for one repository's execution target (`repoId` omitted = this machine). */
  onRefreshHarnesses: (force: boolean, repoId?: string | null) => Promise<void>
}

const FIELD =
  'w-full rounded-md border border-border bg-background px-2.5 py-2 text-[12px] outline-none focus:border-accent disabled:opacity-60'

/** One label/control row; the label column is fixed so the controls align. */
function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/**
 * The new-session form.
 *
 * Deliberately short: the repository and checkout come from the row the dialog
 * was opened from, so the only choices are the Harness, the start ref and name
 * for a fresh worktree, and an optional session title. Diagnostics are only
 * rendered when detection actually fails.
 */
export default function NewSessionDialog({
  repos,
  activeRepoId,
  initialCheckout,
  harnesses,
  harnessLoading,
  harnessError,
  onClose,
  onCreate,
  onRefreshHarnesses
}: Props): React.JSX.Element {
  const t = useT()
  const repoId = activeRepoId ?? repos[0]?.id ?? ''
  const selectedRepo = repos.find((repo) => repo.id === repoId) ?? null
  const repoTarget = selectedRepo?.target ?? null
  const targetLabel =
    repoTarget === null
      ? t('newSession.thisMachine')
      : repoTarget.kind === 'wsl'
        ? `WSL ${repoTarget.distro}`
        : t('newSession.thisMachine')
  const isDefaultCheckout = initialCheckout?.kind === 'default'
  const worktreeId = initialCheckout?.kind === 'worktree' ? initialCheckout.worktreeId : null
  const createsWorktree = initialCheckout === null

  const available = useMemo(
    () => harnesses.filter((entry) => entry.state === 'available'),
    [harnesses]
  )
  const launchOptions = useMemo(() => {
    const agents = available.filter((entry) => entry.harness !== 'shell')
    const shell = available.find((entry) => entry.harness === 'shell') ?? null
    return shell === null ? agents : [...agents, shell]
  }, [available])

  const [harness, setHarness] = useState<HarnessId | null>(() => {
    const preferred = available.find((entry) => entry.harness !== 'shell')
    return preferred?.harness ?? available[0]?.harness ?? null
  })
  const [title, setTitle] = useState('')
  const [startFrom, setStartFrom] = useState('')
  const [branchName, setBranchName] = useState('')

  const branchRefs = useBranchRefs(createsWorktree && repoId.length > 0 ? repoId : null)
  const preparation = selectedRepo === null ? null : repositoryPreparationView(selectedRepo)

  /*
   * Ask for the selected repository's Harnesses once per repository. A WSL
   * repository and a local one do not share an answer.
   */
  const requested = useRef<string | null>(null)
  useEffect(() => {
    if (repoId.length === 0) return
    if (requested.current === repoId) return
    requested.current = repoId
    void onRefreshHarnesses(false, repoId)
  }, [repoId, onRefreshHarnesses])

  useEffect(() => {
    if (harness !== null && launchOptions.some((entry) => entry.harness === harness)) return
    // Prefer a Coding Agent; the terminal is the fallback, not the default.
    const preferred = launchOptions.find((entry) => entry.harness !== 'shell')
    setHarness(preferred?.harness ?? launchOptions[0]?.harness ?? null)
  }, [launchOptions, harness])

  const submitted = useRef(false)
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (submitted.current || harness === null || repoId.length === 0) return
    submitted.current = true
    /*
     * The dialog must not block on the create round trip: on WSL that is the
     * whole multi-second pipeline. The App wrapper owns the request, renders a
     * pending surface, and reports failures with a Retry that preserves these
     * values. Closing here is what makes the click feel immediate.
     */
    void onCreate({
      repoId,
      harness,
      ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      ...(isDefaultCheckout
        ? { checkout: 'default' as const }
        : worktreeId !== null
          ? { worktreeId }
          : {
              ...(startFrom.length > 0 ? { startFrom } : {}),
              ...(branchName.trim().length > 0 ? { branchName: branchName.trim() } : {})
            })
    })
    onClose()
  }

  const noHarness = !harnessLoading && launchOptions.length === 0
  const titlePlaceholder =
    harness === null
      ? t('newSession.chooseHarness')
      : `${harnessLabel(harness)} · ${
          selectedRepo?.displayName ?? t('newSession.repositoryFallback')
        }`

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('newSession.title')}
    >
      <form
        className="icode-modal w-full max-w-md overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onSubmit={submit}
        data-testid="new-session-dialog"
        data-checkout={isDefaultCheckout ? 'default' : worktreeId !== null ? 'worktree' : 'new'}
        data-worktree-id={worktreeId ?? undefined}
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold">{t('newSession.title')}</h2>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="new-session-close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <Field label={t('newSession.agent')}>
            <select
              className={FIELD}
              value={harness ?? ''}
              onChange={(event) => setHarness(event.target.value as HarnessId)}
              disabled={launchOptions.length === 0}
              data-testid="new-session-agent"
            >
              {launchOptions.length === 0 || harness === null ? (
                <option value="">
                  {harnessLoading ? '…' : t('common.unavailable')}
                </option>
              ) : null}
              {launchOptions.map((entry) => (
                <option
                  key={entry.harness}
                  value={entry.harness}
                  data-testid={`harness-option-${entry.harness}`}
                  data-harness-state={entry.state}
                >
                  {entry.harness === 'shell'
                    ? repoTarget?.kind === 'wsl'
                      ? t('newSession.wslTerminal')
                      : t('newSession.terminal')
                    : harnessLabel(entry.harness)}
                </option>
              ))}
            </select>
          </Field>

          {createsWorktree ? (
            <>
              <Field label={t('newSession.startFrom')}>
                <select
                  className={FIELD}
                  value={startFrom}
                  onChange={(event) => setStartFrom(event.target.value)}
                  disabled={branchRefs.loading}
                  data-testid="new-session-start-from"
                >
                  <option value="">
                    {t('newSession.currentBranch', {
                      branch: selectedRepo?.currentBranch ?? 'HEAD'
                    })}
                  </option>
                  {groupStartFromRefs(branchRefs.refs).map((group) => (
                    <optgroup key={group.kind} label={t(startFromGroupLabelKey(group.kind))}>
                      {group.refs.map((ref) => (
                        <option key={ref.fullName} value={startFromValue(ref)}>
                          {ref.name}
                          {ref.primaryHead ? ' ★' : ''}
                          {ref.worktreePath !== null
                            ? ` · ${t('newSession.branchInUse')}`
                            : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>

              <Field label={t('newSession.branchName')}>
                <input
                  className={FIELD}
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  placeholder={t('newSession.branchNamePlaceholder')}
                  spellCheck={false}
                  data-testid="new-session-branch-name"
                />
              </Field>
            </>
          ) : null}

          <Field label={t('newSession.sessionName')}>
            <input
              className={FIELD}
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={titlePlaceholder}
              autoFocus
              data-testid="session-title-input"
            />
          </Field>

          {preparation !== null ? (
            <div
              className={`rounded-md border px-2.5 py-2 text-[10.5px] ${
                preparation.kind === 'failed'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-signal-line bg-signal-weak text-signal'
              }`}
              data-testid="new-session-preparation"
            >
              <span className="font-medium">{preparation.label}</span>
              <span className="mt-0.5 block opacity-80">
                {preparation.kind === 'failed'
                  ? t('newSession.preparationFailed', {
                      detail:
                        preparation.detail ?? t('projects.preparation.failedDetail')
                    })
                  : t('newSession.preparationPreparing')}
              </span>
            </div>
          ) : null}

          {isDefaultCheckout && harness !== null && isAgentHarness(harness) ? (
            <p
              className="flex items-start gap-1.5 text-[10.5px] text-signal"
              data-testid="new-session-shared-checkout-warning"
            >
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>{t('newSession.sharedCheckoutWarning')}</span>
            </p>
          ) : null}

          {harnessError !== null ? (
            <p className="text-[10.5px] text-destructive">
              {t('newSession.detectionFailed', { message: harnessError.message })}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void onRefreshHarnesses(true, repoId)}
              >
                {t('newSession.retry')}
              </button>
            </p>
          ) : null}

          {noHarness && harnessError === null ? (
            <p className="flex items-start gap-1.5 text-[10.5px] text-signal">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                {t('newSession.noHarnessAvailable', { target: targetLabel })}{' '}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 underline"
                  onClick={() => void onRefreshHarnesses(true, repoId)}
                >
                  <RefreshCw size={10} />
                  {t('newSession.detectAgain')}
                </button>
              </span>
            </p>
          ) : null}

          {harnessLoading && launchOptions.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <Loader2 size={11} className="animate-spin" />
              {t('newSession.checking', {
                harness: t('newSession.codingAgent'),
                target: targetLabel
              })}
            </p>
          ) : null}

          {createsWorktree && branchRefs.error !== null ? (
            <p className="text-[10.5px] text-destructive">{t('newSession.branchRefsFailed')}</p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            className="rounded-md border border-border h-9 px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
            data-testid="new-session-cancel"
          >
            {t('newSession.cancel')}
          </button>
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
            disabled={
              harness === null ||
              repoId.length === 0 ||
              (preparation !== null && !isDefaultCheckout)
            }
            data-testid="create-session-submit"
          >
            {t('newSession.start')}
          </button>
        </div>
      </form>
    </div>
  )
}
