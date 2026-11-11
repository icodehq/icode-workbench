import { GitBranch, Github, Gitlab } from 'lucide-react'
import type { RemoteSummaryPayload } from '../../../shared/schemas/remotes'
import { useT } from '../i18n/use-i18n'

type Props = { provider: RemoteSummaryPayload['provider'] }

/** Provider recognition is cosmetic; an unknown host is still a usable remote. */
export default function RemoteProviderBadge({ provider }: Props): React.JSX.Element {
  const t = useT()
  const Icon = provider === 'github' ? Github : provider === 'gitlab' ? Gitlab : GitBranch
  const label =
    provider === 'github'
      ? 'GitHub'
      : provider === 'gitlab'
        ? 'GitLab'
        : t('remotes.provider.remote')
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground"
      data-testid={`remote-provider-${provider}`}
    >
      <Icon size={10} />
      {label}
    </span>
  )
}
