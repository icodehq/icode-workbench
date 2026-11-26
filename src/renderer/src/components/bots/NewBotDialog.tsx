import { useEffect, useMemo, useState } from 'react'
import type { BotRecordPayload } from '../../../../shared/schemas/bots'
import type { BotsWorkspaceState } from '../../state/use-bots'
import type { AssistantTarget } from '../../../../shared/domain/assistant'
import { useT } from '../../i18n/use-i18n'
import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  type BotTemplate,
  type BotTemplateCategory
} from '../../../../shared/domain/bot-templates'

const COLORS = ['#6f7bf7', '#5b8def', '#4fb286', '#d9a441', '#c96f6f', '#9b6fd6']

const CATEGORY_LABEL_KEYS: Record<
  BotTemplateCategory,
  | 'bots.templates.categoryCoding'
  | 'bots.templates.categoryReleases'
  | 'bots.templates.categorySupport'
  | 'bots.templates.categoryPlanning'
  | 'bots.templates.categoryOps'
  | 'bots.templates.categoryPersonal'
> = {
  coding: 'bots.templates.categoryCoding',
  releases: 'bots.templates.categoryReleases',
  support: 'bots.templates.categorySupport',
  planning: 'bots.templates.categoryPlanning',
  ops: 'bots.templates.categoryOps',
  personal: 'bots.templates.categoryPersonal'
}

export function NewBotDialog({
  state,
  onCreated,
  onClose
}: {
  state: BotsWorkspaceState
  onCreated?: (bot: BotRecordPayload) => void
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [role, setRole] = useState('Engineer')
  const [harness, setHarness] = useState<'claude' | 'codex' | 'opencode'>('claude')
  const [target, setTarget] = useState<AssistantTarget>({ kind: 'auto' })
  const [distros, setDistros] = useState<Array<{ name: string }>>([])
  const [color, setColor] = useState(COLORS[1] ?? '#5b8def')
  const [instructions, setInstructions] = useState('')
  const [seedMemory, setSeedMemory] = useState('')
  const [mascot, setMascot] = useState<string | null>(null)
  const [outfit, setOutfit] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [templateQuery, setTemplateQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const t = useT()
  useEffect(() => {
    let cancelled = false
    void window.icode.wsl
      .listDistros()
      .then((result) => {
        if (!cancelled && result.ok && result.value.status === 'ok') {
          setDistros(result.value.distros.map((distro) => ({ name: distro.name })))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const targetValue =
    target.kind === 'wsl' ? `wsl:${target.distro}` : target.kind
  const setTargetValue = (value: string): void => {
    setTarget(
      value === 'auto' || value === 'local'
        ? { kind: value }
        : { kind: 'wsl', distro: value.slice(4) }
    )
  }
  const shownTemplates = useMemo(() => {
    const query = templateQuery.trim().toLocaleLowerCase()
    if (query.length === 0) return BOT_TEMPLATES
    return BOT_TEMPLATES.filter(
      (template) =>
        template.name.toLocaleLowerCase().includes(query) ||
        template.line.toLocaleLowerCase().includes(query)
    )
  }, [templateQuery])
  const selectedTemplate = useMemo(
    () => BOT_TEMPLATES.find((entry) => entry.id === templateId) ?? null,
    [templateId]
  )

  const applyTemplate = (template: BotTemplate | null): void => {
    setTemplateId(template?.id ?? null)
    if (template === null) {
      setName('')
      setRole('Engineer')
      setInstructions('')
      setSeedMemory('')
      setMascot(null)
      setOutfit(null)
      return
    }
    setName(template.name)
    setRole(template.role)
    setInstructions(template.instructions)
    setSeedMemory(template.seedMemory)
    setMascot(template.mascot)
    setOutfit(template.outfit)
  }

  const submit = async (): Promise<void> => {
    if (busy || name.trim().length === 0) return
    setBusy(true)
    const bot = await state.createBot({
      name: name.trim(),
      role: role.trim() || 'Engineer',
      harness,
      target,
      avatarColor: color,
      ...(mascot === null ? {} : { avatarMascot: mascot }),
      ...(outfit === null ? {} : { avatarOutfit: outfit as never }),
      ...(instructions.trim().length === 0 ? {} : { instructions: instructions.trim() }),
      ...(seedMemory.trim().length === 0 ? {} : { seedMemory: seedMemory.trim() })
    })
    setBusy(false)
    if (bot !== null) {
      onCreated?.(bot)
      onClose()
    }
  }
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      data-testid="new-bot-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl">
        <h2 className="text-[15px] font-semibold">{t('bots.newBot.title')}</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">{t('bots.newBot.body')}</p>
        <div className="mt-4 rounded-md border border-border bg-muted/15 p-2">
          <div className="flex items-center gap-2 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('bots.templates.title')}
            </span>
            <input
              className="ml-auto h-6 w-40 rounded border border-border bg-background px-1.5 text-[10px] outline-none"
              value={templateQuery}
              onChange={(event) => setTemplateQuery(event.target.value)}
              placeholder={t('bots.templates.search')}
              data-testid="new-bot-template-search"
            />
          </div>
          <div className="mt-1.5 max-h-56 space-y-2 overflow-y-auto pr-0.5">
            <button
              type="button"
              className={`w-full rounded border px-2 py-1.5 text-left ${
                templateId === null
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:bg-muted'
              }`}
              onClick={() => applyTemplate(null)}
              data-testid="new-bot-template-blank"
            >
              <span className="block text-[11px] font-medium">{t('bots.templates.blank')}</span>
              <span className="mt-0.5 block truncate text-[9.5px] text-muted-foreground">
                {t('bots.templates.blankLine')}
              </span>
            </button>
            {BOT_TEMPLATE_CATEGORIES.map((category) => {
              const entries = shownTemplates.filter((entry) => entry.category === category)
              if (entries.length === 0) return null
              return (
                <div key={category}>
                  <p className="px-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(CATEGORY_LABEL_KEYS[category])}
                  </p>
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    {entries.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        className={`min-w-0 rounded border px-2 py-1.5 text-left ${
                          templateId === template.id
                            ? 'border-accent bg-accent/10'
                            : 'border-border hover:bg-muted'
                        }`}
                        onClick={() => applyTemplate(template)}
                        data-testid={`new-bot-template-${template.id}`}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="text-[13px]" aria-hidden="true">
                            {template.mascot}
                          </span>
                          <span className="block truncate text-[11px] font-medium">
                            {template.name}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[9.5px] text-muted-foreground">
                          {template.line}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {shownTemplates.length === 0 ? (
              <p className="px-0.5 py-2 text-[10px] text-muted-foreground">
                {t('bots.templates.noMatches')}
              </p>
            ) : null}
          </div>
          {selectedTemplate !== null ? (
            <p className="mt-2 border-t border-border pt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {t('bots.templates.firstChat', { text: selectedTemplate.firstChat })}
            </p>
          ) : null}
        </div>
        <label className="mt-4 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newBot.name')}
        </label>
        <input
          className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[12px] outline-none focus:border-line-strong"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          data-testid="new-bot-name"
        />
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newBot.role')}
        </label>
        <input
          className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[12px] outline-none focus:border-line-strong"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          data-testid="new-bot-role"
        />
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newBot.harness')}
        </label>
        <select
          className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[11px]"
          value={harness}
          onChange={(event) => setHarness(event.target.value as typeof harness)}
          data-testid="new-bot-harness"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('assistant.settings.runOn')}
        </label>
        <select
          className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[11px]"
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
          data-testid="new-bot-target"
        >
          <option value="auto">{t('assistant.settings.autoTarget')}</option>
          <option value="local">{t('assistant.settings.localTarget')}</option>
          {distros.map((distro) => (
            <option key={distro.name} value={`wsl:${distro.name}`}>
              {distro.name}
            </option>
          ))}
        </select>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bot.settings.color')}
        </label>
        <div className="mt-1 flex items-center gap-1.5">
          {COLORS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`h-5 w-5 rounded-full border-2 ${
                color === entry ? 'border-foreground' : 'border-transparent'
              }`}
              style={{ backgroundColor: entry }}
              onClick={() => setColor(entry)}
              aria-label={`Use ${entry}`}
              data-testid={`new-bot-color-${entry.slice(1)}`}
            />
          ))}
        </div>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bot.settings.instructions')}
        </label>
        <textarea
          className="mt-1 h-20 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-line-strong"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={4_000}
          placeholder={t('bot.settings.instructionsPlaceholder')}
          data-testid="new-bot-instructions"
        />
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newBot.seedMemory')}
        </label>
        <textarea
          className="mt-1 h-16 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-line-strong"
          value={seedMemory}
          onChange={(event) => setSeedMemory(event.target.value)}
          maxLength={2_000}
          placeholder={t('bots.newBot.seedMemoryPlaceholder')}
          data-testid="new-bot-seed-memory"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-8 rounded border border-border px-3 text-[11px] hover:bg-muted"
            onClick={onClose}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="h-8 rounded bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0}
            data-testid="new-bot-create"
          >
            {busy ? t('bots.creating') : t('bots.newBot.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

