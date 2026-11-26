import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { BotSkillPayload, BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { Notice } from '../../state/workspace'
import { callApi, errorNotice } from '../../lib/api'
import { useT } from '../../i18n/use-i18n'

function starterSkill(folder: string): string {
  return [
    '---',
    `name: ${folder}`,
    `description: ${folder}`,
    '---',
    '',
    `# ${folder}`,
    '',
    'When to use this skill, and what to do.',
    ''
  ].join('\n')
}

/** One bot's own skills: `skills/<name>/SKILL.md`, edited in place. */
export default function BotSkillsPane({
  bot,
  notify
}: {
  bot: BotSummaryPayload
  notify: (notice: Notice) => void
}): React.JSX.Element {
  const t = useT()
  const [skills, setSkills] = useState<BotSkillPayload[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await callApi(window.icode.bots.skills.list({ botId: bot.id }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      setLoading(false)
      return
    }
    setSkills(result.value)
    setLoading(false)
  }, [bot.id, notify])

  useEffect(() => {
    void load()
  }, [load])

  const open = async (folder: string): Promise<void> => {
    setCreating(false)
    setSelected(folder)
    const result = await callApi(window.icode.bots.skills.read({ botId: bot.id, folder }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setText(result.value ?? '')
  }

  const startNew = (): void => {
    setCreating(true)
    setSelected(null)
    setNameDraft('')
    setText('')
  }

  const save = async (): Promise<void> => {
    if (busy) return
    const folder = (creating ? nameDraft : selected ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(folder)) {
      notify({ tone: 'error', message: t('skills.name') })
      return
    }
    setBusy(true)
    const result = await callApi(
      window.icode.bots.skills.save({
        botId: bot.id,
        folder,
        text: text.trim().length === 0 ? starterSkill(folder) : text
      })
    )
    setBusy(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setCreating(false)
    setSelected(folder)
    setText(text.trim().length === 0 ? starterSkill(folder) : text)
    await load()
  }

  const remove = async (folder: string): Promise<void> => {
    if (!window.confirm(t('skills.confirmDelete'))) return
    const result = await callApi(window.icode.bots.skills.remove({ botId: bot.id, folder }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (selected === folder) {
      setSelected(null)
      setText('')
    }
    await load()
  }

  const editing = creating || selected !== null

  return (
    <div className="space-y-2" data-testid="bot-skills-pane">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={startNew}
          data-testid="skills-new"
        >
          <Plus size={10} /> {t('skills.new')}
        </button>
        <span className="ml-auto text-[9px] text-muted-foreground">
          skills/&lt;name&gt;/SKILL.md
        </span>
      </div>

      {loading ? (
        <p className="px-1 text-[11px] text-muted-foreground">{t('memory.loading')}</p>
      ) : skills.length === 0 && !creating ? (
        <p className="px-1 text-[10.5px] leading-relaxed text-muted-foreground">
          {t('skills.empty')}
        </p>
      ) : (
        <div className="space-y-1" data-testid="skills-list">
          {skills.map((skill) => (
            <div
              key={skill.folder}
              className={`group flex items-center gap-1 rounded-md border px-2 py-1 ${
                selected === skill.folder
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-card/60'
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => void open(skill.folder)}
                data-testid={`skills-row-${skill.folder}`}
              >
                <div className="truncate text-[10.5px] text-foreground">{skill.name}</div>
                {skill.description.length > 0 ? (
                  <div className="truncate text-[9px] text-muted-foreground">
                    {skill.description}
                  </div>
                ) : null}
              </button>
              <button
                type="button"
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                onClick={() => void remove(skill.folder)}
                title={t('skills.delete')}
                aria-label={t('skills.delete')}
                data-testid={`skills-delete-${skill.folder}`}
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <div className="space-y-1 rounded-md border border-border bg-card/60 p-2">
          {creating ? (
            <>
              <label className="block text-[9px] uppercase tracking-wide text-muted-foreground">
                {t('skills.name')}
              </label>
              <input
                className="h-6 w-full rounded border border-border bg-background px-1.5 text-[10px] text-foreground outline-none placeholder:text-muted-foreground focus:border-line-strong"
                placeholder={t('skills.namePlaceholder')}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                maxLength={80}
                data-testid="skills-name"
              />
            </>
          ) : null}
          <textarea
            className="h-40 w-full resize-y rounded border border-border bg-background px-1.5 py-1 font-mono text-[10px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-line-strong"
            placeholder={t('skills.textPlaceholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={100_000}
            data-testid="skills-text"
          />
          <button
            type="button"
            className="inline-flex h-5 items-center rounded bg-accent px-2 text-[9.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            onClick={() => void save()}
            disabled={busy || (creating && nameDraft.trim().length === 0)}
            data-testid="skills-save"
          >
            {busy ? t('memory.saving') : t('skills.save')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
