import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { ContextPreviewState, WorldContextUIView } from '../world-context'

/**
 * Phase 3.1A2：Context Preview 的只读结果展示（受控、纯展示）。
 *
 * 只展示用户本轮点名的内容：world identity、已选条目、闭包 omissions、warnings。
 * 刻意不做（留给后续阶段）：
 *   - 选择控件（3.1B1 WorldContextSelection）；
 *   - sourceTable 来源跳转导航（3.1B2 WorldContextSources）；
 *   - 接入 WorldConsolePage 第八分区与跨分区会话持有（3.1B3）；
 *   - ModelView / 运行态字段（永不展示）。
 */
interface WorldContextPreviewResultProps {
  state: ContextPreviewState
  preview: WorldContextUIView | null
  error?: Error | null
  onRetry?: () => void
  className?: string
}

interface IncludedSection {
  labelKey: string
  names: string[]
}

export function WorldContextPreviewResult({
  state,
  preview,
  error,
  onRetry,
  className,
}: WorldContextPreviewResultProps) {
  const { t } = useTranslation()
  const panel = 'rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3'

  if (state === 'loading') {
    return (
      <div data-testid="context-preview-loading" className={cn('flex items-center gap-2 text-sm text-[var(--nova-text-muted)]', panel, className)}>
        <Loader2 className="size-4 animate-spin" />
        {t('worldWorkspace.contextPreview.loading')}
      </div>
    )
  }

  if (state === 'idle' && !preview) {
    return (
      <div data-testid="context-preview-idle" className={cn('text-sm text-[var(--nova-text-muted)]', panel, className)}>
        {t('worldWorkspace.contextPreview.idle')}
      </div>
    )
  }

  if (state === 'error' && !preview) {
    return (
      <div data-testid="context-preview-error" className={cn('space-y-2 text-sm', panel, className)} role="alert">
        <div className="flex items-center gap-2 text-red-600 dark:text-red-300">
          <AlertTriangle className="size-4" />
          {t('worldWorkspace.contextPreview.errorTitle')}
        </div>
        <p className="text-[var(--nova-text-muted)]">{error?.message ?? t('worldWorkspace.contextPreview.errorTitle')}</p>
        {onRetry ? (
          <button type="button" className="rounded border border-[var(--nova-border)] px-2 py-1 text-xs" onClick={onRetry}>
            {t('worldWorkspace.retry')}
          </button>
        ) : null}
      </div>
    )
  }

  if (!preview) return null

  const sections: IncludedSection[] = [
    { labelKey: 'worldWorkspace.characters', names: preview.characters.map((c) => c.displayName) },
    { labelKey: 'worldWorkspace.locations', names: preview.locations.map((l) => l.name) },
    { labelKey: 'worldWorkspace.factions', names: preview.factions.map((f) => f.name) },
    { labelKey: 'worldWorkspace.timeline', names: preview.timeline.map((e) => e.title) },
    { labelKey: 'worldWorkspace.bindings', names: preview.materials.map((m) => m.name) },
  ]
  const includedCount = sections.reduce((sum, s) => sum + s.names.length, 0)

  return (
    <div data-testid="context-preview-result" className={cn('space-y-3 text-sm', className)}>
      {state === 'stale' ? (
        <div data-testid="context-preview-stale" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t('worldWorkspace.contextPreview.stale')}
        </div>
      ) : null}

      {/* World identity：始终存在，不可关闭。 */}
      <section data-testid="context-preview-identity" className={panel}>
        <h4 className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.identityTitle')}</h4>
        <p className="mt-1 text-base font-semibold">{preview.identity.name}</p>
        {preview.identity.tagline ? <p className="text-[var(--nova-text-muted)]">{preview.identity.tagline}</p> : null}
        {preview.identity.genre ? <p className="text-xs text-[var(--nova-text-muted)]">{preview.identity.genre}</p> : null}
        {preview.identity.summary ? <p className="mt-1 text-xs">{preview.identity.summary}</p> : null}
      </section>

      {/* 已选内容：服务端闭包后真正进入上下文的条目。 */}
      <section data-testid="context-preview-selected" className={panel}>
        <h4 className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.selectedTitle')}</h4>
        {includedCount === 0 ? (
          <p data-testid="context-preview-selected-empty" className="mt-1 text-xs text-[var(--nova-text-muted)]">
            {t('worldWorkspace.contextPreview.selectedEmpty')}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {sections
              .filter((s) => s.names.length > 0)
              .map((s) => (
                <li key={s.labelKey} className="flex flex-wrap items-baseline gap-1 text-xs">
                  <span className="text-[var(--nova-text-muted)]">{t(s.labelKey)}：</span>
                  <span>{s.names.join('、')}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {/* 闭包 omissions：因未选/级联移除而被省略的引用。 */}
      <section data-testid="context-preview-omissions" className={panel}>
        <h4 className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.omissionsTitle')}</h4>
        {preview.omissions.length === 0 ? (
          <p data-testid="context-preview-omissions-empty" className="mt-1 text-xs text-[var(--nova-text-muted)]">
            {t('worldWorkspace.contextPreview.omissionsEmpty')}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {preview.omissions.map((o, i) => (
              <li key={`${o.kind}-${o.ownerEntityId}-${o.missingEntityId}-${i}`} className="font-mono text-[11px]">
                {o.kind}: {o.ownerEntityId} → {o.missingEntityId}（{o.reason}）
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 兼容/警告。 */}
      <section data-testid="context-preview-warnings" className={panel}>
        <h4 className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.warningsTitle')}</h4>
        {preview.warnings.length === 0 ? (
          <p data-testid="context-preview-warnings-empty" className="mt-1 text-xs text-[var(--nova-text-muted)]">
            {t('worldWorkspace.contextPreview.warningsEmpty')}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {preview.warnings.map((w, i) => (
              <li key={`${w.code}-${w.refId ?? ''}-${i}`} className="font-mono text-[11px]">
                {w.code}
                {w.refId ? `: ${w.refId}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
