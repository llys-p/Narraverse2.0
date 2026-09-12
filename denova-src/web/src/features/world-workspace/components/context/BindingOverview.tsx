import { useEffect, useRef, useState } from 'react'
import { Database, Loader2, Search, Unlink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { APIError, fetchMasterAsset } from '@/lib/api-client'
import { classifyBindingHealth, type BindingCheckOutcome } from '../../binding-health'
import { bindingStoredStatus, bindingUsages } from '../../binding-observability'
import type { World, WorldAssetBinding } from '../../types'
import { BindingHealthBadge } from '../BindingHealthBadge'
import { BindingRemovalImpact } from './BindingRemovalImpact'

interface BindingOverviewProps {
  world: World
  /**
   * Phase 3.1C2b：移除入口，由 WorldContextPanel 提供并最终落到 WorldConsolePage.mutate。
   * 刻意保持可选：未接入时不显示移除按钮，避免给没有草稿变更路径的调用方造出无法生效的入口。
   */
  onRemoveBinding?: (bindingId: string) => void
}

interface BindingCheckRecord {
  identity: string
  outcome: BindingCheckOutcome
}

function bindingIdentity(worldId: string, binding: WorldAssetBinding): string {
  return `${worldId}\u0000${binding.bindingId}\u0000${binding.masterItemId}\u0000${binding.boundAt}`
}

/**
 * Phase 3.1C2a：绑定来源与健康总览。
 *
 * 初始渲染只读取 World 中的薄快照与 C1 派生引用；只有用户点击某一项“检查原件”
 * 才请求该 Master 详情。联网结果仅保留在本组件会话内，不修改 World、不刷新摘要、
 * 不批量检查，也不写入浏览器存储。
 */
export function BindingOverview({ world, onRemoveBinding }: BindingOverviewProps) {
  const { t } = useTranslation()
  const [checks, setChecks] = useState<Record<string, BindingCheckRecord>>({})
  // 当前待确认移除的 bindingId；同一时刻只允许一个，避免多行影响预览互相干扰。
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null)
  const requestByBinding = useRef(new Map<string, number>())
  const nextRequest = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    // React StrictMode 会在开发环境执行一次 setup → cleanup → setup；每次 setup 都恢复存活标记。
    mounted.current = true
    return () => {
      mounted.current = false
      requestByBinding.current.clear()
    }
  }, [])

  useEffect(() => {
    requestByBinding.current.clear()
    setChecks({})
    // 换世界后上一世界的待确认移除必须作废，避免对新世界执行过期移除。
    setPendingRemovalId(null)
  }, [world.id])

  const inspect = async (binding: WorldAssetBinding) => {
    const request = ++nextRequest.current
    const identity = bindingIdentity(world.id, binding)
    requestByBinding.current.set(binding.bindingId, request)
    setChecks((current) => ({
      ...current,
      [binding.bindingId]: { identity, outcome: { phase: 'loading' } },
    }))

    try {
      const detail = await fetchMasterAsset(binding.masterItemId)
      if (!mounted.current || requestByBinding.current.get(binding.bindingId) !== request) return
      setChecks((current) => ({
        ...current,
        [binding.bindingId]: {
          identity,
          outcome: { phase: 'ok', currentRevision: detail.summary.master_revision ?? '' },
        },
      }))
    } catch (error) {
      if (!mounted.current || requestByBinding.current.get(binding.bindingId) !== request) return
      setChecks((current) => ({
        ...current,
        [binding.bindingId]: {
          identity,
          outcome: { phase: 'error', status: error instanceof APIError ? error.status : undefined },
        },
      }))
    }
  }

  return (
    <section aria-labelledby="binding-overview-title" className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3">
      <div className="mb-3 flex items-start gap-2">
        <Database className="mt-0.5 size-4 shrink-0 text-[var(--nova-text-muted)]" />
        <div>
          <h3 id="binding-overview-title" className="text-sm font-medium">{t('worldWorkspace.context.bindingOverview.title')}</h3>
          <p className="mt-0.5 text-xs text-[var(--nova-text-muted)]">{t('worldWorkspace.context.bindingOverview.description')}</p>
        </div>
      </div>

      {world.bindings.length === 0 ? (
        <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--nova-border)] px-3 py-4 text-center text-xs text-[var(--nova-text-muted)]">
          {t('worldWorkspace.context.bindingOverview.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {world.bindings.map((binding) => {
            const identity = bindingIdentity(world.id, binding)
            const record = checks[binding.bindingId]?.identity === identity ? checks[binding.bindingId] : undefined
            const outcome = record?.outcome ?? { phase: 'idle' as const }
            const usages = bindingUsages(world, binding.bindingId)
            const usageRefs = [...usages.characters, ...usages.locations, ...usages.factions]
            const storedStatus = bindingStoredStatus(binding)
            const checking = outcome.phase === 'loading'

            return (
              <li
                key={binding.bindingId}
                data-testid={`binding-overview-${binding.bindingId}`}
                className="rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{binding.nameSnapshot}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--nova-text-muted)]">
                      {binding.semanticType} · {binding.recordKind} · {t(`worldWorkspace.context.bindingOverview.scope.${usages.scope ?? 'entity'}`)}
                    </div>
                  </div>
                  {outcome.phase === 'idle' ? (
                    <span className="inline-flex whitespace-nowrap rounded-full border border-[var(--nova-border)] px-2 py-0.5 text-[11px] text-[var(--nova-text-muted)]">
                      {storedStatus === 'baseline'
                        ? t('worldWorkspace.context.bindingOverview.storedBaseline')
                        : t('worldWorkspace.bindingHealth.unchecked')}
                    </span>
                  ) : (
                    <BindingHealthBadge state={classifyBindingHealth(binding, outcome)} />
                  )}
                </div>

                {binding.tagsSnapshot.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {binding.tagsSnapshot.slice(0, 5).map((tag) => (
                      <span key={tag} className="rounded bg-[var(--nova-surface)] px-1.5 py-0.5 text-[10px] text-[var(--nova-text-muted)]">{tag}</span>
                    ))}
                  </div>
                ) : null}

                <div className="mt-2 text-xs text-[var(--nova-text-muted)]">
                  {usages.scope === 'world' ? (
                    <p>{t('worldWorkspace.context.bindingOverview.worldScopeNote')}</p>
                  ) : usageRefs.length === 0 ? (
                    <p>{t('worldWorkspace.context.bindingOverview.noEntityUsages')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {usageRefs.map((usage) => (
                        <span key={`${usage.entityKind}:${usage.entityId}`} className="rounded border border-[var(--nova-border)] bg-[var(--nova-surface)] px-1.5 py-0.5">
                          {t(`worldWorkspace.context.bindingOverview.usage.${usage.entityKind}`)}：{usage.entityName || t('worldWorkspace.context.bindingOverview.unnamedEntity')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={checking}
                    aria-label={t('worldWorkspace.context.bindingOverview.checkAria', { name: binding.nameSnapshot })}
                    onClick={() => void inspect(binding)}
                  >
                    {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                    {t('worldWorkspace.context.bindingOverview.check')}
                  </Button>
                  {/* C2b：移除入口带 Unlink 而非垃圾桶图标 —— 这里只解除绑定关系，不删除任何资料。 */}
                  {onRemoveBinding ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-testid={`binding-remove-${binding.bindingId}`}
                      aria-label={t('worldWorkspace.context.bindingRemoval.removeAria', { name: binding.nameSnapshot })}
                      onClick={() => setPendingRemovalId(binding.bindingId)}
                    >
                      <Unlink className="size-3.5" />
                      {t('worldWorkspace.context.bindingRemoval.remove')}
                    </Button>
                  ) : null}
                </div>

                {/* 影响预览即唯一确认界面：确认后先收起再回调，绝不叠加 window.confirm。 */}
                {onRemoveBinding && pendingRemovalId === binding.bindingId ? (
                  <BindingRemovalImpact
                    world={world}
                    bindingId={binding.bindingId}
                    onCancel={() => setPendingRemovalId(null)}
                    onConfirm={(id) => {
                      setPendingRemovalId(null)
                      onRemoveBinding(id)
                    }}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
