import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import {
  containsRedactionPlaceholder,
  isCloneableRemoteInput,
  parseRemoteUrl
} from '../../../shared/domain/remote-url'
import type {
  RemoteSummaryPayload
} from '../../../shared/schemas/remotes'
import { localizeAppError } from '../../../shared/i18n'
import { callApi } from '../lib/api'
import { useLocale, useT } from '../i18n/use-i18n'
import RemoteProviderBadge from './RemoteProviderBadge'

type Props = {
  repoId: string
  repoName?: string
  /** Open directly on the add form (the Push to… no-remotes shortcut). */
  initialAdd?: boolean
  onClose: () => void
}

type FormState = { mode: 'add' } | { mode: 'edit'; name: string }

/**
 * Repository settings: the remotes Git stores for one checkout.
 *
 * The dialog is mounted by the surface that opens it (the project row or Source
 * Control) rather than globally. Both callers already know the repository, and
 * a local mount means closing the dialog cannot leave app-wide state behind.
 */
export default function RepositorySettingsDialog({
  repoId,
  repoName,
  initialAdd = false,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const localize = useCallback(
    (error: AppError): AppError => localizeAppError(error, locale),
    [locale]
  )

  const [remotes, setRemotes] = useState<RemoteSummaryPayload[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<AppError | null>(null)
  const [actionError, setActionError] = useState<AppError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(initialAdd ? { mode: 'add' } : null)
  const [name, setName] = useState('origin')
  const [url, setUrl] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<AppError | null>(null)
  const [fetching, setFetching] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    const result = await callApi(window.icode.remotes.list({ repoId }))
    if (current !== generation.current) return
    setLoading(false)
    if (!result.ok) {
      setListError(result.error)
      return
    }
    setListError(null)
    setRemotes(result.value)
  }, [repoId])

  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])

  const openAdd = (): void => {
    setForm({ mode: 'add' })
    // `origin` is the convention; if it is taken, `upstream` is the next most
    // recognizable name for a second remote.
    setName(remotes?.some((entry) => entry.name === 'origin') === true ? 'upstream' : 'origin')
    setUrl('')
    setFormError(null)
    setActionError(null)
    setNotice(null)
  }

  const openEdit = (remote: RemoteSummaryPayload): void => {
    setForm({ mode: 'edit', name: remote.name })
    setName(remote.name)
    // The stored URL is never sent back; the user types it again.
    setUrl('')
    setFormError(null)
    setActionError(null)
    setNotice(null)
  }

  const closeForm = (): void => {
    setForm(null)
    setFormError(null)
  }

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (form === null || formBusy) return
    const trimmedUrl = url.trim()
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setFormError(
        localize(
          makeAppError('INVALID_ARGUMENT', t('remotes.invalidName'), {
            messageKey: 'remotes.invalidName'
          })
        )
      )
      return
    }
    if (
      trimmedUrl.length === 0 ||
      !isCloneableRemoteInput(trimmedUrl) ||
      containsRedactionPlaceholder(trimmedUrl)
    ) {
      setFormError(
        localize(
          makeAppError('INVALID_ARGUMENT', t('remotes.invalidUrl'), {
            messageKey: 'remotes.invalidUrl'
          })
        )
      )
      return
    }
    setFormBusy(true)
    setFormError(null)
    const result =
      form.mode === 'add'
        ? await callApi(
            window.icode.remotes.add({ repoId, name: trimmedName, url: trimmedUrl })
          )
        : await callApi(
            window.icode.remotes.setUrl({ repoId, name: trimmedName, url: trimmedUrl })
          )
    setFormBusy(false)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setForm(null)
    setNotice(null)
    await load()
  }

  const fetchRemote = async (remote: RemoteSummaryPayload): Promise<void> => {
    if (fetching !== null || removing !== null) return
    setFetching(remote.name)
    setActionError(null)
    setNotice(null)
    const result = await callApi(window.icode.remotes.fetch({ repoId, name: remote.name }))
    setFetching(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setNotice(t('remotes.fetchDone', { name: remote.name }))
  }

  const removeRemote = async (remote: RemoteSummaryPayload): Promise<void> => {
    if (removing !== null || fetching !== null) return
    setRemoving(remote.name)
    setActionError(null)
    setNotice(null)
    const result = await callApi(window.icode.remotes.remove({ repoId, name: remote.name }))
    setRemoving(null)
    setConfirmRemove(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    await load()
  }

  const preview = parseRemoteUrl(url)
  const formProvider = preview?.provider ?? remotes?.find((entry) => entry.name === name)?.provider
  const editingRemote =
    form?.mode === 'edit' ? (remotes?.find((entry) => entry.name === form.name) ?? null) : null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('repositorySettings.title')}
      data-testid="repository-settings-dialog"
    >
      <div className="icode-modal flex max-h-[calc(100vh-3rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Settings2 size={15} className="text-muted-foreground" />
            <div>
              <h2 className="text-[15px] font-semibold">{t('repositorySettings.title')}</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {repoName === undefined
                  ? t('repositorySettings.subtitleGeneric')
                  : t('repositorySettings.subtitle', { repo: repoName })}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="repository-settings-close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('remotes.listTitle')}
            </h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                onClick={() => void load()}
                disabled={loading || formBusy}
                data-testid="remotes-refresh"
              >
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                {t('common.refresh')}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] hover:bg-muted disabled:opacity-50"
                onClick={openAdd}
                disabled={formBusy || removing !== null}
                data-testid="remote-add"
              >
                <Plus size={11} />
                {t('remotes.add')}
              </button>
            </div>
          </div>

          {loading && remotes === null ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              {t('repositorySettings.loading')}
            </div>
          ) : listError !== null ? (
            <div
              className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
              role="alert"
              data-testid="remotes-list-error"
            >
              <span className="font-medium">{localize(listError).message}</span>
              {localize(listError).detail ? (
                <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
                  {localize(listError).detail}
                </span>
              ) : null}
            </div>
          ) : remotes !== null && remotes.length === 0 && form === null ? (
            <div
              className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-3"
              data-testid="remotes-empty"
            >
              <p className="text-[12px] font-medium">{t('remotes.empty.title')}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t('remotes.empty.body')}
              </p>
            </div>
          ) : (
            <ul className="mt-3 grid gap-2" data-testid="remotes-list">
              {(remotes ?? []).map((remote) => (
                <li
                  key={remote.name}
                  className="rounded-md border border-border bg-background px-3 py-2"
                  data-testid={`remote-row-${remote.name}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium">{remote.name}</span>
                        <RemoteProviderBadge provider={remote.provider} />
                        {remote.hasCredentials ? (
                          <span
                            className="inline-flex items-center gap-1 rounded border border-signal-line bg-signal-weak px-1.5 py-0.5 text-[9.5px] text-signal"
                            title={t('remotes.credentialsWarning')}
                            data-testid={`remote-credentials-${remote.name}`}
                          >
                            <AlertTriangle size={9} />
                            {t('remotes.credentialsBadge')}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                        {remote.displayFetchUrl}
                      </p>
                      {remote.displayPushUrl !== null ? (
                        <p className="mt-0.5 break-all font-mono text-[9.5px] text-muted-foreground">
                          {t('remotes.pushUrl')}: {remote.displayPushUrl}
                        </p>
                      ) : null}
                      {remote.hasCredentials ? (
                        <p className="mt-1 text-[9.5px] leading-relaxed text-signal">
                          {t('remotes.credentialsWarning')}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {remote.webUrl !== null ? (
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('remotes.openInBrowser')}
                          aria-label={t('remotes.openInBrowser')}
                          onClick={() =>
                            void window.icode.window.openExternal({ url: remote.webUrl! })
                          }
                          data-testid={`remote-open-browser-${remote.name}`}
                        >
                          <ExternalLink size={12} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        onClick={() => void fetchRemote(remote)}
                        disabled={fetching !== null || removing !== null}
                        data-testid={`remote-fetch-${remote.name}`}
                      >
                        {fetching === remote.name ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <RefreshCw size={11} />
                        )}
                        {fetching === remote.name ? t('remotes.fetching') : t('remotes.fetch')}
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        title={t('remotes.edit')}
                        aria-label={t('remotes.edit')}
                        onClick={() => openEdit(remote)}
                        disabled={fetching !== null || removing !== null}
                        data-testid={`remote-edit-${remote.name}`}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                        title={t('remotes.remove')}
                        aria-label={t('remotes.remove')}
                        onClick={() => {
                          setActionError(null)
                          setNotice(null)
                          setConfirmRemove((current) =>
                            current === remote.name ? null : remote.name
                          )
                        }}
                        disabled={fetching !== null || removing !== null}
                        data-testid={`remote-remove-${remote.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>

                  {confirmRemove === remote.name ? (
                    <div
                      className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2"
                      data-testid={`remote-remove-confirm-${remote.name}`}
                    >
                      <p className="text-[11px] font-medium">
                        {t('remotes.removeConfirm', { name: remote.name })}
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                        {t('remotes.removeWarning')}
                      </p>
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          className="h-7 rounded border border-border px-2 text-[10.5px] hover:bg-muted"
                          onClick={() => setConfirmRemove(null)}
                          disabled={removing !== null}
                          data-testid={`remote-remove-cancel-${remote.name}`}
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1.5 rounded bg-destructive px-2 text-[10.5px] font-medium text-black hover:opacity-90 disabled:opacity-50"
                          onClick={() => void removeRemote(remote)}
                          disabled={removing !== null}
                          data-testid={`remote-remove-commit-${remote.name}`}
                        >
                          {removing === remote.name ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : null}
                          {t('remotes.removeConfirmAction')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {notice !== null ? (
            <p
              className="mt-3 flex items-center gap-1.5 text-[10.5px] text-add"
              role="status"
              data-testid="remotes-notice"
            >
              <Check size={11} />
              {notice}
            </p>
          ) : null}
          {actionError !== null ? (
            <div
              className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
              role="alert"
              data-testid="remotes-action-error"
            >
              <span className="font-medium">{localize(actionError).message}</span>
              {localize(actionError).detail ? (
                <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
                  {localize(actionError).detail}
                </span>
              ) : null}
            </div>
          ) : null}

          {form !== null ? (
            <form
              className="mt-4 rounded-md border border-border bg-muted/30 p-3"
              onSubmit={(event) => void save(event)}
              data-testid="remote-form"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-[12px] font-medium">
                  {form.mode === 'add' ? t('remotes.addTitle') : t('remotes.editTitle')}
                </h3>
                {formProvider !== undefined ? (
                  <RemoteProviderBadge provider={formProvider} />
                ) : null}
              </div>
              {form.mode === 'edit' ? (
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {t('remotes.redactedEdit')}
                </p>
              ) : null}
              {form.mode === 'edit' && editingRemote?.displayPushUrl !== null && editingRemote !== null ? (
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {t('remotes.pushUrlReadOnly')}
                </p>
              ) : null}
              <label className="mt-2 block text-[10.5px] font-medium text-muted-foreground">
                {t('remotes.name')}
                <input
                  className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none focus:border-accent disabled:opacity-60"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setFormError(null)
                  }}
                  placeholder={t('remotes.namePlaceholder')}
                  spellCheck={false}
                  disabled={form.mode === 'edit' || formBusy}
                  data-testid="remote-form-name"
                />
              </label>
              <label className="mt-2 block text-[10.5px] font-medium text-muted-foreground">
                {t('remotes.url')}
                <input
                  className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none focus:border-accent"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value)
                    setFormError(null)
                  }}
                  placeholder={t('remotes.urlPlaceholder')}
                  spellCheck={false}
                  disabled={formBusy}
                  autoFocus={form.mode === 'edit'}
                  data-testid="remote-form-url"
                />
              </label>
              {preview?.hasCredentials === true ? (
                <p className="mt-1.5 text-[10px] text-signal">
                  {t('remotes.credentialsWarning')}
                </p>
              ) : null}
              {formError !== null ? (
                <div
                  className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10.5px] text-destructive"
                  role="alert"
                  data-testid="remote-form-error"
                >
                  <span className="font-medium">{localize(formError).message}</span>
                  {localize(formError).detail ? (
                    <span className="mt-0.5 block break-all font-mono text-[9px] opacity-80">
                      {localize(formError).detail}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  className="h-7 rounded border border-border px-2.5 text-[10.5px] hover:bg-muted disabled:opacity-50"
                  onClick={closeForm}
                  disabled={formBusy}
                  data-testid="remote-form-cancel"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="inline-flex h-7 items-center gap-1.5 rounded bg-accent px-2.5 text-[10.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
                  disabled={formBusy}
                  data-testid="remote-form-save"
                >
                  {formBusy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  {t('remotes.save')}
                </button>
              </div>
            </form>
          ) : null}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            className="h-8 rounded-md border border-border px-3 text-[11.5px] hover:bg-muted"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
