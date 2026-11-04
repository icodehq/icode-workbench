import type { ReactNode } from 'react'

/** Shared settings card shell; keeps the Source Control card out of a cycle. */
export default function SettingsCard({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-card">
      <div className="flex min-h-10 items-center gap-2 border-b border-border px-4">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}
