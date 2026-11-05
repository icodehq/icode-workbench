import { useEffect, useState } from 'react'
import SettingsCard from '../components/SettingsCard'
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
      placeholder="main, release/*"
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
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  useEffect(() => subscribeScmSettings(setSettings), [])
  const update = (patch: Partial<ScmSettings>): void => {
    setSettings((current) => updateScmSettings(current, patch))
  }

  return (
    <SettingsCard title="Source Control">
      <p className="mb-2 max-w-2xl text-[10.5px] leading-relaxed text-muted-foreground">
        These settings affect the Source Control tab. Smart commit is off by default, so
        staging stays explicit until you opt in.
      </p>
      <div className="grid gap-x-6 md:grid-cols-2">
        <div>
          <Field
            label="Smart commit"
            hint="Stage changes when nothing is staged. Off keeps commits stage-first."
          >
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.smartCommit}
              onChange={(event) => update({ smartCommit: event.target.value as ScmSettings['smartCommit'] })}
              data-testid="scm-setting-smart-commit"
            >
              <option value="off">Off</option>
              <option value="all">All changes</option>
              <option value="tracked">Tracked changes</option>
            </select>
          </Field>
          <Field label="Untracked files" hint="Mixed shows untracked rows in Changes; hidden omits them.">
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.untrackedMode}
              onChange={(event) =>
                update({ untrackedMode: event.target.value as ScmSettings['untrackedMode'] })
              }
              data-testid="scm-setting-untracked"
            >
              <option value="separate">Separate group</option>
              <option value="mixed">Mixed into Changes</option>
              <option value="hidden">Hidden</option>
            </select>
          </Field>
          <Field label="Default view">
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.viewMode}
              onChange={(event) => update({ viewMode: event.target.value as ScmSettings['viewMode'] })}
            >
              <option value="list">List</option>
              <option value="tree">Tree</option>
            </select>
          </Field>
          <Field label="Default sort">
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.sort}
              onChange={(event) => update({ sort: event.target.value as ScmSettings['sort'] })}
            >
              <option value="path">Path</option>
              <option value="name">Name</option>
              <option value="status">Status</option>
            </select>
          </Field>
          <Field label="Auto-refresh" hint="Watch the worktree while Source Control is visible.">
            <Toggle
              checked={settings.autoRefresh}
              onChange={(next) => update({ autoRefresh: next })}
              label="Auto-refresh"
              testId="scm-setting-auto-refresh"
            />
          </Field>
        </div>
        <div>
          <Field label="Diff decorations">
            <select
              className="h-7 rounded border border-border bg-card px-1.5 text-[10.5px]"
              value={settings.diffDecorations}
              onChange={(event) =>
                update({ diffDecorations: event.target.value as ScmSettings['diffDecorations'] })
              }
            >
              <option value="all">All</option>
              <option value="gutter">Gutter</option>
              <option value="overview">Overview ruler</option>
              <option value="minimap">Minimap</option>
              <option value="none">None</option>
            </select>
          </Field>
          <Field label="Inline blame" hint="Shows the caret line's commit in the editor.">
            <Toggle
              checked={settings.inlineBlame}
              onChange={(next) => update({ inlineBlame: next })}
              label="Inline blame"
              testId="scm-setting-inline-blame"
            />
          </Field>
          <Field label="Quick diff ignores whitespace">
            <Toggle
              checked={settings.quickDiffIgnoreWhitespace}
              onChange={(next) => update({ quickDiffIgnoreWhitespace: next })}
              label="Quick diff ignores whitespace"
              testId="scm-setting-quick-diff-whitespace"
            />
          </Field>
          <Field label="Pull with rebase">
            <Toggle
              checked={settings.pullRebase}
              onChange={(next) => update({ pullRebase: next })}
              label="Pull with rebase"
              testId="scm-setting-pull-rebase"
            />
          </Field>
          <Field label="Sign commits" hint="Uses the Git/GPG configuration on this machine.">
            <Toggle
              checked={settings.enableCommitSigning}
              onChange={(next) => update({ enableCommitSigning: next })}
              label="Sign commits"
              testId="scm-setting-commit-signing"
            />
          </Field>
          <Field
            label="Protected branches"
            hint="Glob patterns. Commits and amends are disabled on a matching branch."
          >
            <BranchProtectionInput
              value={settings.branchProtection}
              onChange={(branchProtection) => update({ branchProtection })}
            />
          </Field>
          <Field label="Always sign off">
            <Toggle
              checked={settings.alwaysSignOff}
              onChange={(next) => update({ alwaysSignOff: next })}
              label="Always sign off"
              testId="scm-setting-always-signoff"
            />
          </Field>
        </div>
      </div>
    </SettingsCard>
  )
}
