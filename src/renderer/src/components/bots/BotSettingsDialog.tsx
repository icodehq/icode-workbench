import { useEffect, useRef, useState } from 'react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { AssistantSettingsPayload } from '../../../../shared/schemas/assistant'
import type { GroupSummaryPayload } from '../../../../shared/schemas/groups'
import type { BotsWorkspaceState } from '../../state/use-bots'
import type { Notice } from '../../state/workspace'
import AssistantSettingsCard from '../AssistantSettingsCard'
import BotMemoryPane from './BotMemoryPane'
import BotSkillsPane from './BotSkillsPane'
import BotAutomationsPane from './BotAutomationsPane'
import AssistantAvatar from '../AssistantAvatar'
import { useT } from '../../i18n/use-i18n'

const COLORS = ['#6f7bf7', '#5b8def', '#4fb286', '#d9a441', '#c96f6f', '#9b6fd6']

export default function BotSettingsDialog({
  bot,
  state,
  groups,
  notify,
  onClose
}: {
  bot: BotSummaryPayload
  state: BotsWorkspaceState
  groups: GroupSummaryPayload[]
  notify: (notice: Notice) => void
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'identity' | 'agent' | 'access' | 'memory' | 'skills' | 'automations'>(
    'identity'
  )
  const [agentSettings, setAgentSettings] = useState<AssistantSettingsPayload | null>(null)
  const [name, setName] = useState(bot.name)
  const [role, setRole] = useState(bot.role)
  const [instructions, setInstructions] = useState(bot.instructions)
  const [color, setColor] = useState(bot.avatarColor)
  const [image, setImage] = useState<string | null>(bot.avatarImage)
  const [mascot, setMascot] = useState<string | null>(bot.avatarMascot)
  const [outfit, setOutfit] = useState<BotSummaryPayload['avatarOutfit']>(bot.avatarOutfit)
  const imageInput = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(bot.pausedAt !== null)
  const t = useT()

  useEffect(() => {
    let cancelled = false
    void window.icode.bots.settings({ botId: bot.id }).then((result) => {
      if (!cancelled && result.ok) setAgentSettings(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [bot.id])

  const saveAgentSettings = async (
    settings: AssistantSettingsPayload
  ): Promise<void> => {
    const updated = await state.updateBot({ botId: bot.id, settings })
    if (updated !== null && updated.settings !== null) {
      setAgentSettings(updated.settings)
    }
  }

  const togglePause = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const updated = await state.setPaused(bot.id, !paused)
    setBusy(false)
    if (updated !== null) setPaused(updated.pausedAt !== null)
  }

  const chooseImage = (file: File | undefined): void => {
    if (file === undefined) return
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      notify({ tone: 'error', message: t('bot.settings.avatarType') })
      return
    }
    if (file.size > 300_000) {
      notify({ tone: 'error', message: t('bot.settings.avatarTooLarge') })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setImage(reader.result)
    }
    reader.onerror = () => notify({ tone: 'error', message: t('bot.settings.avatarRead') })
    reader.readAsDataURL(file)
  }

  const submit = async (): Promise<void> => {
    if (busy || name.trim().length === 0) return
    setBusy(true)
    const updated = await state.updateBot({
      botId: bot.id,
      name: name.trim(),
      role: role.trim() || bot.role,
      instructions: instructions.trim(),
      avatarColor: color,
      avatarImage: image,
      avatarMascot: mascot,
      avatarOutfit: outfit
    })
    setBusy(false)
    if (updated !== null) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      data-testid="bot-settings-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal flex max-h-[86vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <AssistantAvatar
            name={bot.name}
            status={bot.status}
            color={bot.avatarColor}
            image={image}
            mascot={mascot}
            outfit={outfit}
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">{t('bot.settings.title')}</h2>
            <p className="truncate text-[10.5px] text-muted-foreground">
              {bot.role}
              {paused ? ` · ${t('bots.paused')}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-6 items-center rounded px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            data-testid="bot-settings-close"
          >
            {t('common.close')}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-b border-border px-5 py-1.5">
          {(
            [
              { id: 'identity' as const, label: t('bot.settings.identity') },
              { id: 'agent' as const, label: t('bot.settings.agent') },
              { id: 'access' as const, label: t('bot.settings.access') },
              { id: 'memory' as const, label: t('bot.settings.memory') },
              { id: 'skills' as const, label: t('bot.settings.skills') },
              { id: 'automations' as const, label: t('bot.settings.automations') }
            ]
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`inline-flex h-7 items-center rounded px-2.5 text-[11px] ${
                tab === entry.id
                  ? 'bg-accent/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              onClick={() => setTab(entry.id)}
              data-testid={`bot-settings-tab-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'identity' ? (
            <div>
              <p className="text-[11px] text-muted-foreground">{t('bot.settings.body')}</p>
              <label className="mt-4 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('bot.settings.name')}
              </label>
              <input
                className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[12px] outline-none focus:border-line-strong"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                data-testid="bot-settings-name"
              />
              <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('bot.settings.role')}
              </label>
              <input
                className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[12px] outline-none focus:border-line-strong"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                maxLength={80}
                data-testid="bot-settings-role"
              />
              <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('bot.settings.instructions')}
              </label>
              <textarea
                className="mt-1 h-32 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-line-strong"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={4_000}
                placeholder={t('bot.settings.instructionsPlaceholder')}
                data-testid="bot-settings-instructions"
              />
              <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('bot.settings.avatar')}
              </label>
              <div className="mt-1 flex items-center gap-2">
                <AssistantAvatar
                  name={name || bot.name}
                  status={bot.status}
                  color={color}
                  image={image}
                  mascot={mascot}
                  outfit={outfit}
                />
                <button
                  type="button"
                  className="h-7 rounded border border-border px-2 text-[10.5px] hover:bg-muted"
                  onClick={() => imageInput.current?.click()}
                  data-testid="bot-settings-upload-avatar"
                >
                  {t('bot.settings.uploadAvatar')}
                </button>
                {image !== null ? (
                  <button
                    type="button"
                    className="h-7 rounded px-2 text-[10.5px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setImage(null)}
                    data-testid="bot-settings-remove-avatar"
                  >
                    {t('bot.settings.removeAvatar')}
                  </button>
                ) : null}
                <input
                  ref={imageInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    chooseImage(event.target.files?.[0])
                    event.target.value = ''
                  }}
                  data-testid="bot-settings-avatar-input"
                />
              </div>
              <p className="mt-1 text-[9.5px] text-muted-foreground">
                {t('bot.settings.avatarHint')}
              </p>
              <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('bot.settings.mascot')}
              </label>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {['🦉','🤖','🐙','🦊','🐼','🦁','🐸','🐝'].map((glyph) => (
                  <button
                    key={glyph}
                    type="button"
                    className={`h-7 w-7 rounded-full border text-[13px] ${
                      mascot === glyph ? 'border-foreground bg-muted' : 'border-transparent hover:bg-muted'
                    }`}
                    onClick={() => setMascot(mascot === glyph ? null : glyph)}
                    data-testid={`bot-settings-mascot-${glyph}`}
                  >
                    {glyph}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('bot.settings.outfit')}
              </label>
              <div className="mt-1 flex items-center gap-1.5">
                {[
                  ['none', '#9ca3af'],
                  ['sun', '#f59e0b'],
                  ['ocean', '#0ea5e9'],
                  ['forest', '#10b981'],
                  ['rose', '#f43f5e'],
                  ['violet', '#8b5cf6']
                ].map(([id, hex]) => (
                  <button
                    key={id}
                    type="button"
                    className={`h-5 w-5 rounded-full border-2 ${
                      (outfit ?? 'none') === id ? 'border-foreground' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: hex }}
                    onClick={() =>
                      setOutfit(
                        id === 'none'
                          ? null
                          : (id as NonNullable<BotSummaryPayload['avatarOutfit']>)
                      )
                    }
                    aria-label={id}
                    data-testid={`bot-settings-outfit-${id}`}
                  />
                ))}
              </div>
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
                    data-testid={`bot-settings-color-${entry.slice(1)}`}
                  />
                ))}
              </div>
            </div>
          ) : tab === 'agent' ? (
            agentSettings === null ? (
              <p className="text-[11px] text-muted-foreground">{t('memory.loading')}</p>
            ) : (
              <AssistantSettingsCard
                settings={agentSettings}
                status={bot.status}
                harness={bot.harness}
                target={
                  agentSettings.target.kind === 'wsl'
                    ? agentSettings.target.distro
                    : agentSettings.target.kind
                }
                onSave={saveAgentSettings}
              />
            )
          ) : tab === 'access' ? (
            <div className="space-y-4" data-testid="bot-access-pane">
              <div>
                <h3 className="text-[11px] font-semibold text-foreground">
                  {t('bot.settings.whoCanAsk')}
                </h3>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {groups.length === 0
                    ? t('bot.settings.accessOwnerOnly')
                    : t('bot.settings.accessGroupMembers')}
                </p>
                {groups.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {groups.map((group) => (
                      <li
                        key={group.id}
                        className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-[11px]"
                      >
                        {group.name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div>
                <h3 className="text-[11px] font-semibold text-foreground">
                  {t('bot.settings.accessTasks')}
                </h3>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {t('bot.settings.accessTasksBody')}
                </p>
              </div>
              <div>
                <h3 className="text-[11px] font-semibold text-foreground">
                  {t('bot.settings.accessTools')}
                </h3>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {t('bot.settings.accessToolsBody')}
                </p>
              </div>
            </div>
          ) : tab === 'memory' ? (
            <BotMemoryPane bot={bot} notify={notify} />
          ) : tab === 'skills' ? (
            <BotSkillsPane bot={bot} notify={notify} />
          ) : (
            <BotAutomationsPane bot={bot} notify={notify} />
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="h-8 rounded border border-border px-3 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              onClick={() => void togglePause()}
              disabled={busy}
              data-testid="bot-settings-pause"
            >
              {paused ? t('bots.resume') : t('bots.pause')}
            </button>
            <button
              type="button"
              className="h-8 rounded px-2 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
              onClick={() => {
                if (!window.confirm(t('bots.archiveConfirm', { name: bot.name }))) return
                void state.archiveBot(bot.id).then((archived) => {
                  if (archived) onClose()
                })
              }}
              disabled={busy}
              data-testid="bot-settings-archive"
            >
              {t('bots.archive')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-8 rounded border border-border px-3 text-[11px] hover:bg-muted"
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="h-8 rounded bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void submit()}
              disabled={busy || name.trim().length === 0}
              data-testid="bot-settings-save"
            >
              {busy ? t('bot.settings.saving') : t('bot.settings.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
