import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { BindingHealthState } from '../types'

const STYLE: Record<BindingHealthState, string> = {
  latest: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  stale: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  missing: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  unavailable: 'border-[var(--nova-border)] bg-[var(--nova-surface-2)] text-[var(--nova-text-muted)]',
  unchecked: 'border-[var(--nova-border)] bg-[var(--nova-surface-2)] text-[var(--nova-text-muted)]',
  checking: 'border-[var(--nova-border)] bg-[var(--nova-surface-2)] text-[var(--nova-text-muted)]',
}

/** 绑定健康状态徽标（纯展示，文案走 i18n: worldWorkspace.bindingHealth.<state>）。 */
export function BindingHealthBadge({ state, className }: { state: BindingHealthState; className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]', STYLE[state], className)}>
      {state === 'checking' ? <Loader2 className="size-3 animate-spin" /> : null}
      {t(`worldWorkspace.bindingHealth.${state}`)}
    </span>
  )
}
