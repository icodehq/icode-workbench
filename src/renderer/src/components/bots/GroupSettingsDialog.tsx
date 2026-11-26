import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { GroupReplyMode } from '../../../../shared/domain/group'
import type { GroupSummaryPayload, GroupUpdateInput } from '../../../../shared/schemas/groups'
import AssistantAvatar from '../AssistantAvatar'
import { useT } from '../../i18n/use-i18n'

/** Rename a group and change its members or default replier. */
export default function GroupSettingsDialog({
  group,
  bots,
  onUpdateGroup,
  onArchive,
  onDelete,
  onClose
}: {
  group: GroupSummaryPayload
  bots: BotSummaryPayload[]
  onUpdateGroup: (input: GroupUpdateInput) => Promise<GroupSummaryPayload | null>
  onArchive: () => Promise<boolean>
  onDelete: () => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(group.name)
  const [selected, setSelected] = useState<string[]>(group.memberBotIds)
  const [defaultBotId, setDefaultBotId] = useState(
    group.defaultBotId ?? group.memberBotIds[0] ?? ''
  )
  const [mode, setMode] = useState<GroupReplyMode['kind']>(group.replyMode.kind)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (selected.includes(defaultBotId)) return
    setDefaultBotId(selected[0] ?? '')
  }, [defaultBotId, selected])

  const canSave = name.trim().length > 0 && selected.length > 0 && !busy
  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    const replier = selected.includes(defaultBotId) ? defaultBotId : (selected[0] ?? '')
    const updated = await onUpdateGroup({
      groupId: group.id,
      revision: group.revision,
      name: name.trim(),
      memberBotIds: selected,
      defaultBotId: replier.length === 0 ? null : replier,
      replyMode:
        mode === 'bot' && replier.length > 0
          ? { kind: 'bot', botId: replier }
          : mode === 'all'
            ? { kind: 'all' }
            : { kind: 'mentions' }
    })
    setBusy(false)
    if (updated !== null) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      data-testid="group-settings-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
        <h2 className="text-[15px] font-semibold">{t('bots.groupSettings.title')}</h2>
        <label className="mt-4 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newGroup.name')}
        </label>
        <input
          className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[12px] outline-none focus:border-line-strong"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          data-testid="group-settings-name"
        />
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newGroup.members')}
        </label>
        <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto rounded border border-border bg-background p-1">
          {bots.map((bot) => {
            const checked = selected.includes(bot.id)
            return (
              <label
                key={bot.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setSelected((current) =>
                      checked ? current.filter((id) => id !== bot.id) : [...current, bot.id]
                    )
                  }
                  data-testid={`group-settings-member-${bot.id}`}
                />
                <AssistantAvatar
                  name={bot.name}
                  status={bot.status}
                  size="sm"
                  color={bot.avatarColor}
                  image={bot.avatarImage}
            mascot={bot.avatarMascot}
            outfit={bot.avatarOutfit}
                />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {bot.pausedAt !== null ? t('bots.paused') : bot.role}
                </span>
              </label>
            )
          })}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('bots.newGroup.defaultBot')}
            <select
              className="mt-1 h-8 w-full rounded border border-border bg-background px-1.5 text-[11px] normal-case tracking-normal"
              value={defaultBotId}
              onChange={(event) => setDefaultBotId(event.target.value)}
              data-testid="group-settings-default-bot"
            >
              {bots
                .filter((bot) => selected.includes(bot.id))
                .map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('bots.reply.label')}
            <select
              className="mt-1 h-8 w-full rounded border border-border bg-background px-1.5 text-[11px] normal-case tracking-normal"
              value={mode}
              onChange={(event) => setMode(event.target.value as GroupReplyMode['kind'])}
              data-testid="group-settings-reply-mode"
            >
              <option value="bot">{t('bots.reply.botShort')}</option>
              <option value="all">{t('bots.reply.all')}</option>
              <option value="mentions">{t('bots.reply.mentions')}</option>
            </select>
          </label>
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            className="h-8 rounded px-2 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
            onClick={() => {
              if (!window.confirm(t('bots.archiveGroupConfirm', { name: group.name }))) return
              void onArchive().then((archived) => {
                if (archived) onClose()
              })
            }}
            disabled={busy}
            data-testid="group-settings-archive"
          >
            {t('bots.archiveGroup')}
          </button>
          <button
            type="button"
            className="h-8 rounded px-2 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
            onClick={() => {
              if (!window.confirm(t('bots.deleteGroupConfirm', { name: group.name }))) return
              void onDelete().then((deleted) => {
                if (deleted) onClose()
              })
            }}
            disabled={busy}
            data-testid="group-settings-delete"
          >
            {t('bots.deleteGroup')}
          </button>
          <div className="flex items-center gap-2">
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
              className="inline-flex h-8 items-center rounded bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void save()}
              disabled={!canSave}
              data-testid="group-settings-save"
            >
              {busy ? <Loader2 size={11} className="mr-1 animate-spin" /> : null}
              {t('bot.settings.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
