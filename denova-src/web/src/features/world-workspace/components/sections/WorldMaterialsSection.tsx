import { useEffect, useRef, useState } from 'react'
import { BookMarked, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { APIError, fetchMasterAsset } from '@/lib/api-client'
import { BindingAvatar } from '../BindingAvatar'
import { applyRefreshedBinding } from '../../binding-health'
import { removeWorldBinding, worldScopedBindings } from '../../world-ops'
import type { World, WorldAssetBinding } from '../../types'

interface WorldMaterialsSectionProps {
  world: World
  /** 控制台统一的草稿变更入口（会置 dirty）；刷新摘要与移除都经它落到 draft。 */
  mutate: (fn: (w: World) => World) => void
  readOnly?: boolean
}

/**
 * 世界资料分区：只展示 world 作用域绑定（lorebook_template、世界规则/物品等）。
 * 不做列表加载时的批量健康请求；查看仅用已有薄快照，刷新是逐条按需显式动作。
 */
export function WorldMaterialsSection({ world, mutate, readOnly = false }: WorldMaterialsSectionProps) {
  const { t } = useTranslation()
  const materials = worldScopedBindings(world)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  // 请求序号 + 卸载保护：旧请求晚返回时不得覆盖新状态（不使用 AbortController，fetchMasterAsset 不接收 signal）。
  const seqRef = useRef(0)
  useEffect(() => () => { seqRef.current += 1 }, [])

  const refresh = async (binding: WorldAssetBinding) => {
    const seq = ++seqRef.current
    setRefreshingId(binding.bindingId)
    try {
      const detail = await fetchMasterAsset(binding.masterItemId)
      if (seq !== seqRef.current) return
      const rev = detail.summary?.master_revision ?? ''
      // 原件缺少可用内容哈希时不应用刷新，避免把基线写成空值。
      if (!rev) {
        toast.error(t('worldWorkspace.bindingHealth.refreshUnavailable'))
        return
      }
      mutate((w) => applyRefreshedBinding(w, binding.bindingId, {
        name: detail.summary.name,
        tags: Array.isArray(detail.summary.tags) ? detail.summary.tags : [],
        masterRevision: rev,
      }))
      toast.success(t('worldWorkspace.bindingHealth.refreshedLocal'))
    } catch (err) {
      if (seq !== seqRef.current) return
      if (err instanceof APIError && err.status === 404) toast.error(t('worldWorkspace.bindingHealth.refreshMissing'))
      else toast.error(t('worldWorkspace.bindingHealth.refreshUnavailable'))
    } finally {
      if (seq === seqRef.current) setRefreshingId(null)
    }
  }

  const remove = (binding: WorldAssetBinding) => {
    if (!window.confirm(t('worldWorkspace.materials.removeConfirm', { name: binding.nameSnapshot }))) return
    // 仅移除世界内绑定（并解除可能存在的实体引用），绝不删除总资料库原件。
    mutate((w) => removeWorldBinding(w, binding.bindingId))
  }

  if (materials.length === 0) {
    return <EmptyState variant="dashed" icon={BookMarked} title={t('worldWorkspace.console.emptyMaterials')} />
  }

  return (
    <ul className="flex flex-col gap-2">
      {materials.map((b) => (
        <li key={b.bindingId} className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
          <BindingAvatar masterItemId={b.masterItemId} className="size-9 rounded-[var(--radius-md)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{b.nameSnapshot}</div>
            <div className="truncate text-[11px] text-[var(--nova-text-muted)]">
              {b.semanticType} · {b.recordKind}
              {b.tagsSnapshot?.length ? ` · ${b.tagsSnapshot.slice(0, 3).join('/')}` : ''}
              {b.masterRevision ? ` · ${b.masterRevision.slice(0, 13)}` : ` · ${t('worldWorkspace.bindingHealth.unchecked')}`}
            </div>
          </div>
          {!readOnly && (
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={t('worldWorkspace.materials.refresh')}
                disabled={refreshingId === b.bindingId} onClick={() => void refresh(b)}>
                {refreshingId === b.bindingId ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t('worldWorkspace.materials.remove')} onClick={() => remove(b)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
