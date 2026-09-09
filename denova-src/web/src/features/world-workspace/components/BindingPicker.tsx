import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { listMasterAssets, type MasterAssetSummary } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { newClientId } from '../world-factory'
import { BindingAvatar } from './BindingAvatar'
import type { BindingRecordKind, WorldAssetBinding, WorldSemanticType } from '../types'

const PAGE_SIZE = 25
const SEMANTIC_WHITELIST: WorldSemanticType[] = ['character', 'world', 'location', 'faction', 'rule', 'item', 'other']

type LoadState = 'loading' | 'error' | 'ready'

interface BindingPickerProps {
  open: boolean
  onClose: () => void
  /** 已绑定的总库 masterItemId 集合，用于禁用重复绑定。 */
  boundMasterIds: ReadonlySet<string>
  onBind: (binding: WorldAssetBinding) => void
  recordKind?: BindingRecordKind
  semanticType?: WorldSemanticType
}

export function toBinding(asset: MasterAssetSummary): WorldAssetBinding {
  const semantic = SEMANTIC_WHITELIST.includes(asset.semantic_type as WorldSemanticType)
    ? (asset.semantic_type as WorldSemanticType)
    : 'other'
  const recordKind: BindingRecordKind = asset.record_kind === 'lorebook_template' ? 'lorebook_template' : 'character_template'
  return {
    bindingId: newClientId(),
    masterItemId: asset.master_item_id,
    recordKind,
    semanticType: semantic,
    nameSnapshot: asset.name,
    tagsSnapshot: Array.isArray(asset.tags) ? asset.tags : [],
    // 记录绑定时总库条目的内容哈希，作为后续健康检查基线；缺失时回退空串（尚未检查）。
    masterRevision: asset.master_revision ?? '',
    boundAt: new Date().toISOString(),
  }
}

export function BindingPicker({ open, onClose, boundMasterIds, onBind, recordKind, semanticType }: BindingPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [assets, setAssets] = useState<MasterAssetSummary[]>([])
  const [total, setTotal] = useState(0)
  const [state, setState] = useState<LoadState>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const requestSeq = useRef(0)

  // 搜索防抖；更换查询时重置分页。
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query, open])

  const loadFirstPage = useCallback(async () => {
    const seq = ++requestSeq.current
    setState('loading')
    try {
      const res = await listMasterAssets({ query: debouncedQuery, recordKind, semanticType, availability: 'usable', limit: PAGE_SIZE, offset: 0 })
      if (seq !== requestSeq.current) return
      setAssets(res.assets ?? [])
      setTotal(res.total ?? 0)
      setState('ready')
    } catch {
      if (seq !== requestSeq.current) return
      setState('error')
    }
  }, [debouncedQuery, recordKind, semanticType])

  useEffect(() => {
    if (open) void loadFirstPage()
  }, [open, loadFirstPage])

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const res = await listMasterAssets({ query: debouncedQuery, recordKind, semanticType, availability: 'usable', limit: PAGE_SIZE, offset: assets.length })
      setAssets((prev) => {
        const known = new Set(prev.map((a) => a.master_item_id))
        return [...prev, ...(res.assets ?? []).filter((a) => !known.has(a.master_item_id))]
      })
      setTotal(res.total ?? 0)
    } catch {
      // 分页失败保留已加载内容，仅恢复按钮可点。
    } finally {
      setLoadingMore(false)
    }
  }

  if (!open) return null
  const hasMore = assets.length < total

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--nova-border)] px-3 py-2">
          <h3 className="text-sm font-medium">{t('worldWorkspace.bindingPicker.title')}</h3>
          <div className="relative ml-2 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--nova-text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('worldWorkspace.bindingPicker.search')}
              className="h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] pl-7 pr-2 text-xs outline-none focus:border-[var(--nova-ring)]"
            />
          </div>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('worldWorkspace.bindingPicker.close')}><X /></Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {state === 'loading' && (
            <div className="flex h-40 items-center justify-center gap-2 text-xs text-[var(--nova-text-muted)]">
              <Loader2 className="size-4 animate-spin" />{t('worldWorkspace.bindingPicker.loading')}
            </div>
          )}
          {state === 'error' && (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-xs">
              <AlertTriangle className="size-5 text-amber-500" />
              <span className="text-[var(--nova-text-muted)]">{t('worldWorkspace.bindingPicker.unavailable')}</span>
              <Button variant="outline" size="xs" onClick={() => void loadFirstPage()}>{t('worldWorkspace.retry')}</Button>
            </div>
          )}
          {state === 'ready' && assets.length === 0 && (
            <div className="flex h-40 items-center justify-center text-xs text-[var(--nova-text-muted)]">{t('worldWorkspace.bindingPicker.empty')}</div>
          )}
          {state === 'ready' && assets.length > 0 && (
            <ul className="flex flex-col gap-1">
              {assets.map((asset) => {
                const bound = boundMasterIds.has(asset.master_item_id)
                return (
                  <li key={asset.master_item_id} className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--nova-border)] px-2 py-1.5">
                    <BindingAvatar masterItemId={asset.master_item_id} className="size-8 rounded-[var(--radius-md)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{asset.name}</div>
                      <div className="truncate text-[11px] text-[var(--nova-text-muted)]">
                        {asset.semantic_type} · {asset.record_kind}
                        {asset.tags?.length ? ` · ${asset.tags.slice(0, 3).join('/')}` : ''}
                      </div>
                    </div>
                    <Button
                      variant={bound ? 'secondary' : 'outline'}
                      size="xs"
                      disabled={bound}
                      onClick={() => onBind(toBinding(asset))}
                      className={cn(bound && 'opacity-70')}
                    >
                      {bound ? <Check className="size-3" /> : null}
                      {bound ? t('worldWorkspace.bindingPicker.bound') : t('worldWorkspace.bindingPicker.bind')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {state === 'ready' && hasMore && (
          <div className="shrink-0 border-t border-[var(--nova-border)] p-2 text-center">
            <Button variant="ghost" size="xs" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('worldWorkspace.bindingPicker.loadMore')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
