import { useEffect, useState } from 'react'
import SettingsCard from '../components/SettingsCard'
import { updateFilesSettings, useFilesSettings } from './files-settings'
import { parseNestingPatterns } from './tree-layout'

const parseExclude = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
  testId
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  testId: string
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded border border-border px-2.5 py-2">
      <span className="min-w-0">
        <span className="block text-[11.5px] font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--icode-accent)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
    </label>
  )
}

/** Persisted Files preferences; changes apply live to an open Files panel. */
export default function FilesSettingsCard(): React.JSX.Element {
  const settings = useFilesSettings()
  // Keep the textarea's own text so pressing Enter on a new line is not undone
  // by the trimmed setting that is saved.
  const [excludeDraft, setExcludeDraft] = useState(() => settings.exclude.join('\n'))
  const savedExclude = settings.exclude.join('\n')
  const [nestingDraft, setNestingDraft] = useState(() =>
    settings.nestingPatterns.join('\n')
  )
  const savedNesting = settings.nestingPatterns.join('\n')
  useEffect(() => {
    if (parseExclude(excludeDraft).join('\n') !== savedExclude) {
      setExcludeDraft(savedExclude)
    }
    // Only an external settings change should replace the draft; the user's
    // own keystrokes already set it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedExclude])
  useEffect(() => {
    if (nestingDraft.trim() !== savedNesting.trim()) {
      setNestingDraft(savedNesting)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedNesting])
  const nestingCheck = parseNestingPatterns(nestingDraft.split('\n'))
  const update = (patch: Parameters<typeof updateFilesSettings>[1]): void => {
    updateFilesSettings(settings, patch)
  }
  return (
    <SettingsCard title="Files">
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Visibility, sorting and the editor's view of this worktree. These choices
        are saved for this profile.
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-2">
          <span className="text-[11.5px] font-medium text-foreground">Sort order</span>
          <select
            className="h-7 rounded border border-border bg-muted/40 px-1.5 text-[11px] text-foreground"
            value={settings.sortOrder}
            onChange={(event) =>
              update({
                sortOrder: event.target.value as 'name' | 'type' | 'modified'
              })
            }
            data-testid="files-setting-sort-order"
          >
            <option value="name">Name</option>
            <option value="type">Type</option>
            <option value="modified">Modified</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-2">
          <span className="text-[11.5px] font-medium text-foreground">Direction</span>
          <select
            className="h-7 rounded border border-border bg-muted/40 px-1.5 text-[11px] text-foreground"
            value={settings.sortDirection}
            onChange={(event) =>
              update({ sortDirection: event.target.value as 'asc' | 'desc' })
            }
            data-testid="files-setting-sort-direction"
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>

      <div className="mt-3 grid gap-2">
        <Toggle
          id="files-setting-compact"
          label="Compact folders"
          description="Show a single-child folder chain such as src/features/auth as one row."
          checked={settings.compactFolders}
          onChange={(next) => update({ compactFolders: next })}
          testId="files-setting-compact"
        />
        <Toggle
          id="files-setting-nesting"
          label="File nesting"
          description="Group foo.test.ts, foo.d.ts and related files under foo.ts."
          checked={settings.fileNesting}
          onChange={(next) => update({ fileNesting: next })}
          testId="files-setting-nesting"
        />
        <Toggle
          id="files-setting-decorations"
          label="Git decorations"
          description="Show M/A/U/D letters and folder dots from the session worktree."
          checked={settings.gitDecorations}
          onChange={(next) => update({ gitDecorations: next })}
          testId="files-setting-decorations"
        />
        <Toggle
          id="files-setting-auto-reveal"
          label="Auto-reveal active file"
          description="Scroll the tree to the active editor tab when Files opens or the tab changes."
          checked={settings.autoReveal}
          onChange={(next) => update({ autoReveal: next })}
          testId="files-setting-auto-reveal"
        />
        <Toggle
          id="files-setting-trash"
          label="Move deleted items to Trash"
          description="Keep deleted files/folders restorable for seven days. Off means permanent delete after confirmation."
          checked={settings.useTrash}
          onChange={(next) => update({ useTrash: next })}
          testId="files-setting-trash"
        />
        <Toggle
          id="files-setting-gitignore"
          label="Respect .gitignore"
          description="Hide files ignored by Git. Failures leave entries visible."
          checked={settings.excludeGitIgnore}
          onChange={(next) => update({ excludeGitIgnore: next })}
          testId="files-setting-gitignore"
        />
      </div>

      <label className="mt-3 block">
        <span className="text-[11.5px] font-medium text-foreground">
          Exclude patterns
        </span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
          One glob per line. `*`, `**`, `?`, a trailing `/` for folders, and `!` to
          re-include. `.git` is always hidden.
        </span>
        <textarea
          className="mt-1.5 h-24 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-[10.5px] text-foreground outline-none"
          value={excludeDraft}
          onChange={(event) => {
            const raw = event.target.value
            setExcludeDraft(raw)
            update({ exclude: parseExclude(raw) })
          }}
          data-testid="files-setting-exclude"
        />
      </label>

      <label className="mt-3 block">
        <span className="text-[11.5px] font-medium text-foreground">
          Custom nesting pairs
        </span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
          One pair per line: `*.ts → $1.test.ts, $1.spec.ts`. `*` captures the
          parent name; `$1` inserts it. Built-in JS/TS/package rules stay active.
        </span>
        <textarea
          className="mt-1.5 h-20 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-[10.5px] text-foreground outline-none"
          value={nestingDraft}
          placeholder="*.ts -> $1.test.ts"
          onChange={(event) => {
            const raw = event.target.value
            setNestingDraft(raw)
            update({ nestingPatterns: raw.split('\n').map((line) => line.trim()) })
          }}
          data-testid="files-setting-nesting-patterns"
        />
        {nestingCheck.errors.length > 0 ? (
          <span
            className="mt-1 block text-[10px] text-destructive"
            data-testid="files-setting-nesting-errors"
          >
            {nestingCheck.errors[0]}
            {nestingCheck.errors.length > 1
              ? ` (+${String(nestingCheck.errors.length - 1)} more)`
              : ''}
          </span>
        ) : null}
      </label>
    </SettingsCard>
  )
}
