import { useEffect, useState } from 'react'
import SettingsCard from '../components/SettingsCard'
import { useT } from '../i18n/use-i18n'
import {
  loadScmSettings,
  subscribeScmSettings,
  updateScmSettings,
  type ScmSettings
} from './scm-settings'

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex items-start justify-between gap-4 border-b border-border/60 py-2 text-[11.5px] last:border-b-0">
      <span className="min-w-0">
        <span className="block text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-[10px] text-muted-foreground">{hint}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  testId
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  testId?: string
}): React.JSX.Element {
  return (
    <input
      type="checkbox"
      className="h-3.5 w-3.5 accent-signal"
      checked={checked}
      aria-label={label}
      data-testid={testId}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}

function BranchProtectionInput({
  value,
  onChange
}: {
  value: string[]
  onChange: (patterns: string[]) => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState(value.join(', '))
  useEffect(() => {
    setDraft(value.join(', '))
  }, [value])
  const commit = (): void => {
    const patterns = draft
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .slice(0, 100)
    onChange(patterns)
    setDraft(patterns.join(', '))
  }
  return (
    <input
      value={draft}
      placeholder={t('scmSettings.branchPlaceholder')}
      className="h-7 w-44 rounded border border-border bg-card px-1.5 text-[10.5px] text-foreground"
      data-testid="scm-setting-branch-protection"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
    />
  )
}

export default function ScmSettingsCard(): React.JSX.Element {
  const t = useT()
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  useEffect(() => subscribeScmSettings(setSettings), [])
  const update = (patch: Partial<ScmSettings>): void => {
    setSettings((current) => updateScmSettings(current, patch))
  }

  return (
    <SettingsCard title={t('scmSettings.title')}>
      <p className="mb-2 max-w-2xl text-[10.5px] leading-relaxed text-muted-foreground">
        {t('scmSettings.description')}
      </p>
      <div className="grid gap-x-6 md:grid-cols-2">
        <div>
          <Field
            label={t('scmSettings.smartCommit')}
            hint={t('scmSettings.smartCommitHint')}
          >
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.smartCommit}
              onChange={(event) => update({ smartCommit: event.target.value as ScmSettings['smartCommit'] })}
              data-testid="scm-setting-smart-commit"
            >
              <option value="off">{t('scmSettings.off')}</option>
              <option value="all">{t('scmSettings.allChanges')}</option>
              <option value="tracked">{t('scmSettings.trackedChanges')}</option>
            </select>
          </Field>
          <Field label={t('scmSettings.untracked')} hint={t('scmSettings.untrackedHint')}>
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.untrackedMode}
              onChange={(event) =>
                update({ untrackedMode: event.target.value as ScmSettings['untrackedMode'] })
              }
              data-testid="scm-setting-untracked"
            >
              <option value="separate">{t('scmSettings.separateGroup')}</option>
              <option value="mixed">{t('scmSettings.mixed')}</option>
              <option value="hidden">{t('scmSettings.hidden')}</option>
            </select>
          </Field>
          <Field label={t('scmSettings.defaultView')}>
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.viewMode}
              onChange={(event) => update({ viewMode: event.target.value as ScmSettings['viewMode'] })}
            >
              <option value="list">{t('scmSettings.list')}</option>
              <option value="tree">{t('scmSettings.tree')}</option>
            </select>
          </Field>
          <Field label={t('scmSettings.defaultSort')}>
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.sort}
              onChange={(event) => update({ sort: event.target.value as ScmSettings['sort'] })}
            >
              <option value="path">{t('scmSettings.sort.path')}</option>
              <option value="name">{t('scmSettings.sort.name')}</option>
              <option value="status">{t('scmSettings.sort.status')}</option>
            </select>
          </Field>
          <Field label={t('scmSettings.autoRefresh')} hint={t('scmSettings.autoRefreshHint')}>
            <Toggle
              checked={settings.autoRefresh}
              onChange={(next) => update({ autoRefresh: next })}
              label={t('scmSettings.autoRefresh')}
              testId="scm-setting-auto-refresh"
            />
          </Field>
        </div>
        <div>
          <Field label={t('scmSettings.diffDecorations')}>
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.diffDecorations}
              onChange={(event) =>
                update({ diffDecorations: event.target.value as ScmSettings['diffDecorations'] })
              }
            >
              <option value="all">{t('scmSettings.decorations.all')}</option>
              <option value="gutter">{t('scmSettings.decorations.gutter')}</option>
              <option value="overview">{t('scmSettings.decorations.overview')}</option>
              <option value="minimap">{t('scmSettings.decorations.minimap')}</option>
              <option value="none">{t('scmSettings.decorations.none')}</option>
            </select>
          </Field>
          <Field label={t('scmSettings.inlineBlame')} hint={t('scmSettings.inlineBlameHint')}>
            <Toggle
              checked={settings.inlineBlame}
              onChange={(next) => update({ inlineBlame: next })}
              label={t('scmSettings.inlineBlame')}
              testId="scm-setting-inline-blame"
            />
          </Field>
          <Field label={t('scmSettings.quickDiffWhitespace')}>
            <Toggle
              checked={settings.quickDiffIgnoreWhitespace}
              onChange={(next) => update({ quickDiffIgnoreWhitespace: next })}
              label={t('scmSettings.quickDiffWhitespace')}
              testId="scm-setting-quick-diff-whitespace"
            />
          </Field>
          <Field label={t('scmSettings.pullRebase')}>
            <Toggle
              checked={settings.pullRebase}
              onChange={(next) => update({ pullRebase: next })}
              label={t('scmSettings.pullRebase')}
              testId="scm-setting-pull-rebase"
            />
          </Field>
          <Field label={t('scmSettings.signCommits')} hint={t('scmSettings.signCommitsHint')}>
            <Toggle
              checked={settings.enableCommitSigning}
              onChange={(next) => update({ enableCommitSigning: next })}
              label={t('scmSettings.signCommits')}
              testId="scm-setting-commit-signing"
            />
          </Field>
          <Field
            label={t('scmSettings.protectedBranches')}
            hint={t('scmSettings.protectedBranchesHint')}
          >
            <BranchProtectionInput
              value={settings.branchProtection}
              onChange={(branchProtection) => update({ branchProtection })}
            />
          </Field>
          <Field label={t('scmSettings.alwaysSignOff')}>
            <Toggle
              checked={settings.alwaysSignOff}
              onChange={(next) => update({ alwaysSignOff: next })}
              label={t('scmSettings.alwaysSignOff')}
              testId="scm-setting-always-signoff"
            />
          </Field>
        </div>
      </div>
    </SettingsCard>
  )
}
