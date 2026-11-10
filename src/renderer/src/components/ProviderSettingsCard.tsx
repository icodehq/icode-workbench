import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  PROVIDER_HARNESSES,
  type ProviderAuthStyle,
  type ProviderCreateInput,
  type ProviderHarness,
  type ProviderListPayload,
  type ProviderTestResult,
  type ProviderUpdateInput,
  type ProviderViewPayload
} from '../../../shared/schemas/provider'
import { harnessLabel } from '../../../shared/domain/harness'
import { presetsFor } from '../../../shared/provider-presets'
import { providerLaunchSpec } from '../../../shared/provider-launch'
import type { IpcResult } from '../../../shared/schemas/ipc'
import { callApi } from '../lib/api'
import { useT } from '../i18n/use-i18n'
import SettingsCard from './SettingsCard'

type Draft = {
  mode: 'create' | 'edit'
  id: string | null
  harness: ProviderHarness
  name: string
  baseUrl: string
  model: string
  apiKey: string
  authStyle: ProviderAuthStyle
  presetId: string
}

const MASK = '••••••••'

const inputClass =
  'h-8 w-full rounded-md border border-border bg-muted/40 px-2 text-[11.5px] text-foreground'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function invoke<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const result = await callApi(call)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function emptyDraft(harness: ProviderHarness): Draft {
  return {
    mode: 'create',
    id: null,
    harness,
    name: '',
    baseUrl: '',
    model: '',
    apiKey: '',
    authStyle: 'auth_token',
    presetId: ''
  }
}

function draftFrom(provider: ProviderViewPayload): Draft {
  return {
    mode: 'edit',
    id: provider.id,
    harness: provider.harness,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: '',
    authStyle: provider.authStyle ?? 'auth_token',
    presetId: ''
  }
}

function previewFor(draft: Draft): string {
  const spec = providerLaunchSpec({
    harness: draft.harness,
    baseUrl: draft.baseUrl || 'https://api.example.com',
    model: draft.model || 'model',
    authStyle: draft.harness === 'claude' ? draft.authStyle : null,
    // The preview is rendered in the DOM; never echo a key the user just typed.
    apiKey: MASK
  })
  return JSON.stringify({ args: spec.args, env: spec.env }, null, 2)
}

export default function ProviderSettingsCard(): React.JSX.Element {
  const t = useT()
  const [data, setData] = useState<ProviderListPayload>({
    providers: [],
    selections: [],
    secretStorage: { backend: 'unavailable', secure: false }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({})

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setData(await invoke(window.icode.providers.list()))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const selectedFor = (harness: ProviderHarness): string =>
    data.selections.find((entry) => entry.harness === harness)?.providerId ?? ''

  const providersFor = (harness: ProviderHarness): ProviderViewPayload[] =>
    data.providers.filter((entry) => entry.harness === harness)

  const presets = useMemo(
    () => (draft === null ? [] : presetsFor(draft.harness)),
    [draft]
  )

  const select = async (harness: ProviderHarness, providerId: string): Promise<void> => {
    setError(null)
    try {
      await invoke(
        window.icode.providers.select({
          harness,
          providerId: providerId === '' ? null : providerId
        })
      )
      await reload()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const remove = async (provider: ProviderViewPayload): Promise<void> => {
    setError(null)
    try {
      await invoke(window.icode.providers.remove({ providerId: provider.id }))
      setTestResults((current) => {
        const next = { ...current }
        delete next[provider.id]
        return next
      })
      await reload()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const openCreate = (harness: ProviderHarness): void => {
    setDraft(emptyDraft(harness))
    setError(null)
  }

  const openEdit = (provider: ProviderViewPayload): void => {
    setDraft(draftFrom(provider))
    setError(null)
  }

  const update = (patch: Partial<Draft>): void => {
    setDraft((current) => (current === null ? null : { ...current, ...patch }))
  }

  const choosePreset = (presetId: string): void => {
    const preset = presets.find((entry) => entry.id === presetId)
    if (preset === undefined) {
      update({ presetId: '' })
      return
    }
    update({
      presetId,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      authStyle: preset.authStyle ?? 'auth_token'
    })
  }

  const save = async (): Promise<void> => {
    if (draft === null) return
    if (
      draft.name.trim() === '' ||
      draft.baseUrl.trim() === '' ||
      draft.model.trim() === '' ||
      (draft.mode === 'create' && draft.apiKey.trim() === '')
    ) {
      setError(t('settings.providers.form.required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (draft.mode === 'create') {
        const input =
          draft.harness === 'claude'
            ? ({
                harness: 'claude',
                name: draft.name.trim(),
                baseUrl: draft.baseUrl.trim(),
                model: draft.model.trim(),
                apiKey: draft.apiKey,
                authStyle: draft.authStyle
              } satisfies ProviderCreateInput)
            : ({
                harness: draft.harness,
                name: draft.name.trim(),
                baseUrl: draft.baseUrl.trim(),
                model: draft.model.trim(),
                apiKey: draft.apiKey
              } satisfies ProviderCreateInput)
        await invoke(window.icode.providers.create(input))
      } else {
        if (draft.id === null) return
        const input: ProviderUpdateInput = {
          id: draft.id,
          harness: draft.harness,
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          ...(draft.apiKey.trim() === '' ? {} : { apiKey: draft.apiKey }),
          ...(draft.harness === 'claude' ? { authStyle: draft.authStyle } : {})
        }
        await invoke(window.icode.providers.update(input))
        if (draft.id !== null) {
          setTestResults((current) => {
            const next = { ...current }
            delete next[draft.id!]
            return next
          })
        }
      }
      setDraft(null)
      await reload()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const test = async (provider: ProviderViewPayload): Promise<void> => {
    setTestingId(provider.id)
    setError(null)
    try {
      const result = await invoke(window.icode.providers.test({ providerId: provider.id }))
      setTestResults((current) => ({ ...current, [provider.id]: result }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setTestingId(null)
    }
  }

  const storage = data.secretStorage
  const storageWarning = loading
    ? null
    : storage.backend === 'unavailable'
      ? t('settings.providers.storageUnavailable')
      : storage.backend === 'basic_text'
        ? t('settings.providers.storageWarning')
        : null

  return (
    <SettingsCard title={t('settings.providers.title')}>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        {t('settings.providers.description')}
      </p>
      {storageWarning !== null ? (
        <p
          className="mt-2 rounded-md border border-signal-line bg-signal-weak px-2 py-1.5 text-[10px] leading-relaxed text-signal"
          role="status"
          data-testid="provider-storage-warning"
        >
          {storageWarning}
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {PROVIDER_HARNESSES.map((harness) => {
          const providers = providersFor(harness)
          const selected = selectedFor(harness)
          const editing = draft !== null && draft.harness === harness
          return (
            <div key={harness} className="rounded-md border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[12px] font-medium text-foreground">
                  {harnessLabel(harness)}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="h-7 max-w-full rounded-md border border-border bg-muted/40 px-2 text-[11px] text-foreground"
                    value={selected}
                    onChange={(event) => void select(harness, event.target.value)}
                    disabled={loading}
                    data-testid={`provider-select-${harness}`}
                  >
                    <option value="">{t('settings.providers.native')}</option>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name} · {provider.model}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[10.5px] hover:bg-muted"
                    onClick={() => openCreate(harness)}
                    disabled={storage.backend === 'unavailable'}
                    data-testid={`provider-add-${harness}`}
                  >
                    {t('settings.providers.add')}
                  </button>
                </div>
              </div>

              {providers.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {providers.map((provider) => {
                    const isSelected = provider.id === selected
                    const result = testResults[provider.id]
                    return (
                      <li
                        key={provider.id}
                        className="rounded border border-border/60 bg-background/40 px-2 py-1.5 text-[10.5px]"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium text-foreground">{provider.name}</span>
                            <span className="ml-1 text-muted-foreground">{provider.baseUrl}</span>
                            <span className="ml-1 font-mono text-[9px] text-muted-foreground">
                              {provider.model}
                            </span>
                          </span>
                          {isSelected ? (
                            <span className="rounded-full border border-add/50 bg-add-weak px-1.5 py-0.5 text-[8.5px] text-add">
                              {t('settings.providers.selected')}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="text-[10px] text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(provider)}
                            data-testid={`provider-edit-${provider.id}`}
                          >
                            {t('settings.providers.edit')}
                          </button>
                          <button
                            type="button"
                            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                            onClick={() => void test(provider)}
                            disabled={testingId !== null}
                            data-testid={`provider-test-${provider.id}`}
                          >
                            {testingId === provider.id
                              ? t('settings.providers.testing')
                              : t('settings.providers.test')}
                          </button>
                          <button
                            type="button"
                            className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40"
                            onClick={() => void remove(provider)}
                            disabled={isSelected}
                            title={isSelected ? t('settings.providers.selectedDelete') : undefined}
                            data-testid={`provider-remove-${provider.id}`}
                          >
                            {t('settings.providers.remove')}
                          </button>
                        </div>
                        {result !== undefined ? (
                          <p
                            className={`mt-1 text-[9.5px] ${result.ok ? 'text-add' : 'text-signal'}`}
                            role="status"
                          >
                            {result.ok
                              ? t('settings.providers.testOk', {
                                  status: result.status ?? 0,
                                  ms: result.latencyMs
                                })
                              : t('settings.providers.testFailed', {
                                  message: result.message,
                                  ms: result.latencyMs
                                })}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {t('settings.providers.empty')}
                </p>
              )}

              {editing && draft !== null ? (
                <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
                  {draft.mode === 'create' ? (
                    <label className="text-[10.5px] text-muted-foreground sm:col-span-2">
                      {t('settings.providers.form.preset')}
                      <select
                        className={inputClass}
                        value={draft.presetId}
                        onChange={(event) => choosePreset(event.target.value)}
                        data-testid="provider-form-preset"
                      >
                        <option value="">{t('settings.providers.form.custom')}</option>
                        {presets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="text-[10.5px] text-muted-foreground">
                    {t('settings.providers.form.name')}
                    <input
                      className={inputClass}
                      value={draft.name}
                      onChange={(event) => update({ name: event.target.value })}
                      data-testid="provider-form-name"
                    />
                  </label>
                  <label className="text-[10.5px] text-muted-foreground">
                    {t('settings.providers.form.model')}
                    <input
                      className={inputClass}
                      value={draft.model}
                      onChange={(event) => update({ model: event.target.value })}
                      data-testid="provider-form-model"
                    />
                  </label>
                  <label className="text-[10.5px] text-muted-foreground sm:col-span-2">
                    {t('settings.providers.form.baseUrl')}
                    <input
                      className={inputClass}
                      value={draft.baseUrl}
                      onChange={(event) => update({ baseUrl: event.target.value })}
                      data-testid="provider-form-base-url"
                    />
                  </label>
                  <label className="text-[10.5px] text-muted-foreground sm:col-span-2">
                    {draft.mode === 'edit'
                      ? t('settings.providers.form.apiKeyEdit')
                      : t('settings.providers.form.apiKey')}
                    <input
                      className={inputClass}
                      type="password"
                      value={draft.apiKey}
                      onChange={(event) => update({ apiKey: event.target.value })}
                      placeholder={draft.mode === 'edit' ? t('settings.providers.keepKey') : 'sk-…'}
                      data-testid="provider-form-api-key"
                    />
                  </label>
                  {draft.harness === 'claude' ? (
                    <label className="text-[10.5px] text-muted-foreground sm:col-span-2">
                      {t('settings.providers.form.authStyle')}
                      <select
                        className={inputClass}
                        value={draft.authStyle}
                        onChange={(event) =>
                          update({ authStyle: event.target.value as ProviderAuthStyle })
                        }
                        data-testid="provider-form-auth-style"
                      >
                        <option value="auth_token">
                          {t('settings.providers.form.authToken')}
                        </option>
                        <option value="api_key">{t('settings.providers.form.apiKeyAuth')}</option>
                      </select>
                    </label>
                  ) : null}
                  <details className="sm:col-span-2">
                    <summary className="cursor-pointer text-[10px] text-muted-foreground">
                      {t('settings.providers.preview')}
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                      {previewFor(draft)}
                    </pre>
                    <p className="mt-1 text-[9px] text-muted-foreground">
                      {t('settings.providers.previewHint')}
                    </p>
                  </details>
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-md border border-border bg-foreground px-3 text-[10.5px] text-background disabled:opacity-40"
                      onClick={() => void save()}
                      disabled={saving || storage.backend === 'unavailable'}
                      data-testid="provider-form-save"
                    >
                      {saving
                        ? t('settings.providers.form.saving')
                        : t('settings.providers.form.save')}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[10.5px] hover:bg-muted"
                      onClick={() => setDraft(null)}
                    >
                      {t('settings.providers.form.cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {error !== null ? (
        <p className="mt-2 text-[10.5px] text-signal" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  )
}
