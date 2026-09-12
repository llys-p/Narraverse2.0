import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { bindingRemovalImpact } from '../../binding-observability'
import type { World } from '../../types'

interface BindingRemovalImpactProps {
  /** 当前控制台草稿；影响始终由它即时派生，绝不缓存旧结果。 */
  world: World
  bindingId: string
  onCancel: () => void
  onConfirm: (bindingId: string) => void
}

/**
 * Phase 3.1C2b：Binding 移除影响预览 —— 这是移除操作的**唯一确认界面**。
 *
 * 刻意不再叠加 window.confirm：本面板本身已经把影响摆清楚，再加系统弹窗就是双重确认。
 * 本组件只做三件事：派生影响、展示影响、把「确认/取消」交回调用方。
 *   - 影响数据只来自 bindingRemovalImpact，不另写一套引用扫描；
 *   - 真正的移除由调用方复用 removeWorldBinding 完成，本组件不碰 World；
 *   - 不发 Master 请求、不写任何浏览器存储、不创建运行态。
 */
export function BindingRemovalImpact({ world, bindingId, onCancel, onConfirm }: BindingRemovalImpactProps) {
  const { t } = useTranslation()
  // 每次渲染都按最新 world 重新派生：预览打开期间草稿若被改动，影响随之更新，
  // 绑定一旦消失就转为「已不存在」并禁用确认，绝不用过期结果执行删除。
  const impact = bindingRemovalImpact(world, bindingId)
  const missing = !impact.exists
  const groups = [
    { testId: 'binding-removal-detached-characters', label: t('worldWorkspace.context.bindingRemoval.detachedCharacters'), items: impact.usages.characters },
    { testId: 'binding-removal-detached-locations', label: t('worldWorkspace.context.bindingRemoval.detachedLocations'), items: impact.usages.locations },
    { testId: 'binding-removal-detached-factions', label: t('worldWorkspace.context.bindingRemoval.detachedFactions'), items: impact.usages.factions },
  ]

  return (
    <div
      role="alertdialog"
      aria-label={t('worldWorkspace.context.bindingRemoval.title')}
      data-testid="binding-removal-impact"
      className="mt-2 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/5 p-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t('worldWorkspace.context.bindingRemoval.title')}</div>
          {impact.binding && impact.scope ? (
            <div className="mt-0.5 truncate text-xs text-[var(--nova-text-muted)]">
              {impact.binding.nameSnapshot} · {t(`worldWorkspace.context.bindingOverview.scope.${impact.scope}`)}
            </div>
          ) : null}
        </div>
      </div>

      {missing ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {t('worldWorkspace.context.bindingRemoval.missing')}
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          {impact.scope === 'world' ? (
            <p className="text-[var(--nova-text-muted)]">
              {t('worldWorkspace.context.bindingOverview.worldScopeNote')}
            </p>
          ) : null}

          {!impact.hasEntityImpact ? (
            <p className="text-[var(--nova-text-muted)]">{t('worldWorkspace.context.bindingRemoval.noImpact')}</p>
          ) : null}

          {groups.map(({ testId, label, items }) => (items.length === 0 ? null : (
            <div key={testId} data-testid={testId}>
              <div className="text-[var(--nova-text-muted)]">{label}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {items.map((usage) => (
                  <span key={`${usage.entityKind}:${usage.entityId}`} className="rounded border border-[var(--nova-border)] bg-[var(--nova-surface)] px-1.5 py-0.5">
                    {usage.entityName || t('worldWorkspace.context.bindingOverview.unnamedEntity')}
                  </span>
                ))}
              </div>
            </div>
          )))}

          {/* 用户最担心的点必须显式说清：这里只解除绑定关系，总资料库原件原封不动。 */}
          <p className="text-[var(--nova-text-muted)]">{t('worldWorkspace.context.bindingRemoval.masterKept')}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={missing}
          data-testid="binding-removal-confirm"
          onClick={() => onConfirm(bindingId)}
        >
          {t('worldWorkspace.context.bindingRemoval.confirm')}
        </Button>
        <Button type="button" size="xs" variant="ghost" data-testid="binding-removal-cancel" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
