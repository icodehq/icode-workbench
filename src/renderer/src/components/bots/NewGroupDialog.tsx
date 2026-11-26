import { useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { GroupReplyMode } from '../../../../shared/domain/group'
import type { GroupSummaryPayload } from '../../../../shared/schemas/groups'
import type { BotsWorkspaceState } from '../../state/use-bots'
import AssistantAvatar from '../AssistantAvatar'
import { useT } from '../../i18n/use-i18n'

export function NewGroupDialog({
  state,
  onCreated,
  onClose
}: {
  state: BotsWorkspaceState
  onCreated?: (group: GroupSummaryPayload) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const bots = state.bots
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>(() => bots.map((bot) => bot.id))
  const [defaultBotId, setDefaultBotId] = useState<string>(bots[0]?.id ?? '')
  const [mode, setMode] = useState<GroupReplyMode['kind']>('bot')
  const [opening, setOpening] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (defaultBotId.length > 0 && selected.includes(defaultBotId)) return
    setDefaultBotId(selected[0] ?? '')
  }, [defaultBotId, selected])

  const canCreate = name.trim().length > 0 && selected.length > 0 && !busy
  const create = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    const replier = selected.includes(defaultBotId) ? defaultBotId : (selected[0] ?? '')
    const group = await state.createGroup({
      name: name.trim(),
      memberBotIds: selected,
      ...(replier.length > 0 ? { defaultBotId: replier } : {}),
      replyMode:
        mode === 'bot' && replier.length > 0
          ? { kind: 'bot', botId: replier }
          : mode === 'all'
            ? { kind: 'all' }
            : { kind: 'mentions' }
    })
    if (group !== null) {
      const openingText = opening.trim()
      if (openingText.length > 0) {
        const thread = group.threads.find((entry) => entry.isDefault) ?? group.threads[0]
        if (thread !== undefined) {
          await window.icode.groups.send({
            groupId: group.id,
            threadId: thread.id,
            text: openingText
          })
        }
      }
      setBusy(false)
      onCreated?.(group)
      onClose()
      return
    }
    setBusy(false)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
        <h2 className="text-[15px] font-semibold">{t('bots.newGroup.title')}</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">{t('bots.newGroup.body')}</p>
        <label className="mt-4 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newGroup.name')}
        </label>
        <input
          className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[12px] outline-none focus:border-line-strong"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          data-testid="new-group-name"
        />
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newGroup.members')}
        </label>
        <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded border border-border bg-background p-1">
          {bots.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">
              {t('bots.newGroup.noBots')}
            </p>
          ) : (
            bots.map((bot) => {
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
                        checked
                          ? current.filter((id) => id !== bot.id)
                          : [...current, bot.id]
                      )
                    }
                    data-testid={`new-group-member-${bot.id}`}
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
                  <span className="truncate text-[10px] text-muted-foreground">{bot.role}</span>
                </label>
              )
            })
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('bots.newGroup.defaultBot')}
            <select
              className="mt-1 h-8 w-full rounded border border-border bg-background px-1.5 text-[11px] normal-case tracking-normal"
              value={defaultBotId}
              onChange={(event) => setDefaultBotId(event.target.value)}
              data-testid="new-group-default-bot"
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
              data-testid="new-group-reply-mode"
            >
              <option value="bot">{t('bots.reply.botShort')}</option>
              <option value="all">{t('bots.reply.all')}</option>
              <option value="mentions">{t('bots.reply.mentions')}</option>
            </select>
          </label>
        </div>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('bots.newGroup.opening')}
          <textarea
            className="mt-1 h-16 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-[11px] normal-case tracking-normal outline-none focus:border-line-strong"
            value={opening}
            onChange={(event) => setOpening(event.target.value)}
            maxLength={8_000}
            placeholder={t('bots.newGroup.openingPlaceholder')}
            data-testid="new-group-opening"
          />
        </label>
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
            onClick={() => void create()}
            disabled={!canCreate}
            data-testid="new-group-create"
          >
            {busy ? (
              <Loader2 size={11} className="mr-1 inline animate-spin" />
            ) : (
              <Plus size={11} className="mr-1 inline" />
            )}
            {busy ? t('bots.newGroup.creating') : t('bots.newGroup.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

