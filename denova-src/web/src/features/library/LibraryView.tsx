import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, BookOpen, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, Database, FileUp, Loader2, Menu, MinusCircle, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, UserRound, X, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfigManagerChat } from '@/components/Chat/ConfigManagerChat'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { AdaptiveSurface } from '@/components/layout/adaptive-surface'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { addMasterCharacterEntry, addMasterLorebookEntry, applyMasterProposal, applyMasterProposals, createLoreItem, createMasterProposal, deleteTranslationJob, fetchMasterAsset, fetchMasterAssetAdventureUsage, fetchMasterAssetPipeline, fetchMasterAssetProposals, fetchMasterAssetTranslations, fetchMasterAssetUsages, fetchMasterTranslationRuntime, instantiateMasterAsset, listMasterAssets, rejectMasterProposal, rejectMasterProposals, removeMasterAsset, resolveTranslationJob, retryTranslationJob, startMasterAgent, stopMasterAsset, syncMasterAssetToAdventure, updateMasterAssetDescription, updateMasterAssetFields, validateMasterProposal, type MasterAssetAdventureUsage, type MasterAssetDetail, type MasterAssetSummary, type MasterPipelineNode, type MasterPipelineStatus, type MasterProposal, type MasterTranslationFieldRuntime, type MasterTranslationRuntime } from '@/lib/api-client'
import { MasterImportDialog } from './MasterImportDialog'

const PAGE_SIZE = 25
const NODE_KEYS = ['archive', 'parse', 'normalize', 'translation', 'check', 'usable', 'instantiate'] as const

type LibraryNodeKey = typeof NODE_KEYS[number]
type AssetUserState = 'ready' | 'processing' | 'needs_user'

interface LibraryViewProps {
  workspace?: string
  onClose?: () => void
}

function valueOf(record: Record<string, unknown> | undefined, key: string, fallback: string) {
  const value = record?.[key]
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return fallback
}

function listValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function enumLabel(scope: string, value: string, t: (key: string) => string) {
  const key = `library.${scope}.${value}`
  const translated = t(key)
  return translated === key ? value : translated
}

function statusLabel(status: string, t: (key: string) => string) {
  if (status === 'staging' || status === 'usable') return t(`library.${status}`)
  return enumLabel('status', status, t)
}

function translationSummaryLabel(runtime: MasterTranslationRuntime, totalFields: number, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!runtime.runtime_available) return t('library.translationUnavailable')
  if (runtime.fields.some((field) => ['eligible', 'agent_running', 'proposal_ready', 'applying', 'revalidating'].includes(field.recovery_status || ''))) return t('library.agentProcessing')
  if (runtime.fields.some((field) => field.recovery_status === 'needs_user')) return t('library.translationNeedsConfirmation', { count: 1 })
  if (runtime.failed_fields > 0) return t('library.translationNeedsAttention', { count: runtime.failed_fields })
  if ((runtime.cancelled_fields || 0) > 0) return t('library.translationCancelled', { count: runtime.cancelled_fields || 0 })
  if (runtime.review_fields > 0) return t('library.translationNeedsConfirmation', { count: runtime.review_fields })
  if (runtime.active_fields < runtime.total_fields) return t('library.translationProcessing', { active: runtime.active_fields, total: runtime.total_fields })
  if (totalFields === 0) return t('library.translationNotRequired')
  return t('library.translationCompleted')
}

function nodeLabel(key: LibraryNodeKey, t: (key: string) => string) {
  return t(`library.node.${key}`)
}

function nodeFor(status: MasterPipelineStatus, key: LibraryNodeKey): MasterPipelineNode {
  return status.nodes.find((node) => node.key === key) ?? { key, status: 'waiting', inferred: true }
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <Check className="size-4" aria-hidden="true" />
  if (status === 'running') return <Loader2 className="size-4 animate-spin" aria-hidden="true" />
  if (status === 'failed' || status === 'cancelled') return <XCircle className="size-4" aria-hidden="true" />
  if (status === 'warning' || status === 'review_required' || status === 'stale') return <AlertTriangle className="size-4" aria-hidden="true" />
  if (status === 'skipped') return <MinusCircle className="size-4" aria-hidden="true" />
  return <Circle className="size-3.5" aria-hidden="true" />
}

function statusClass(status: string) {
  if (status === 'completed') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed') return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
  if (status === 'cancelled') return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  if (status === 'warning' || status === 'review_required' || status === 'stale') return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  if (status === 'running') return 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400'
  return 'border-[var(--nova-border)] bg-[var(--nova-surface-2)] text-[var(--nova-text-muted)]'
}

function StatusBadge({ status, t }: { status: string; t: (key: string) => string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${statusClass(status)}`}>
      <StatusIcon status={status} />
      {statusLabel(status, t)}
    </span>
  )
}

function assetUserState(pipeline: MasterPipelineStatus, runtime?: MasterTranslationRuntime): AssetUserState {
  if (pipeline.availability === 'usable') return 'ready'
  if (pipeline.translation.failed_fields > 0 || runtime?.failed_fields) return 'needs_user'
  if (runtime?.fields.some((field) => field.recovery_status === 'needs_user' || field.review_required)) return 'needs_user'
  if (pipeline.nodes.some((node) => node.status === 'review_required')) return 'needs_user'
  return 'processing'
}

function AssetStatusBadge({ pipeline, runtime, t }: { pipeline: MasterPipelineStatus; runtime?: MasterTranslationRuntime; t: (key: string) => string }) {
  const state = assetUserState(pipeline, runtime)
  const status = state === 'ready' ? 'completed' : state === 'needs_user' ? 'review_required' : 'running'
  return <StatusBadge status={status} t={(key) => key === `library.status.${status}` ? t(`library.userState.${state}`) : t(key)} />
}

export function LibraryView({ workspace = '', onClose }: LibraryViewProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [recordKind, setRecordKind] = useState('')
  const [semanticType, setSemanticType] = useState('')
  const [availability, setAvailability] = useState<'' | 'staging' | 'usable'>('')
  const [page, setPage] = useState(0)
  const [assets, setAssets] = useState<MasterAssetSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentContext, setAgentContext] = useState<Record<string, string>>({})
  const [detailReloadToken, setDetailReloadToken] = useState(0)
  const [deleteTarget, setDeleteTarget] = useState<MasterAssetSummary | null>(null)
  const [assetBusyID, setAssetBusyID] = useState<string | null>(null)
  const [assetActionMessage, setAssetActionMessage] = useState<string | null>(null)

  useEffect(() => {
    setPage(0)
  }, [availability, recordKind, semanticType, query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listMasterAssets({ query, recordKind, semanticType, availability: availability || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((result) => {
        if (cancelled) return
        setAssets(result.assets)
        setTotal(result.total)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setAssets([])
        setTotal(0)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [availability, page, query, recordKind, semanticType])

  const refresh = () => {
    setPage((current) => current)
    setLoading(true)
    setError(null)
    return listMasterAssets({ query, recordKind, semanticType, availability: availability || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((result) => { setAssets(result.assets); setTotal(result.total) })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
  }

  const closeDetail = () => {
    setSelectedID(null)
    setAgentOpen(false)
    setAgentContext({})
  }
  const openAgent = (context: Record<string, string> = {}) => {
    setAgentContext(context)
    setAgentOpen(true)
  }

  const stopAsset = async (masterItemID: string) => {
    setAssetBusyID(masterItemID)
    setAssetActionMessage(null)
    try {
      const result = await stopMasterAsset(masterItemID)
      setAssetActionMessage(result.queue_error ? t('library.assetStopSavedWithWarning') : t('library.assetStopSuccess'))
      await refresh()
      if (selectedID === masterItemID) setDetailReloadToken((value) => value + 1)
    } catch {
      setAssetActionMessage(t('library.assetStopFailed'))
    } finally {
      setAssetBusyID(null)
    }
  }

  const confirmRemoveAsset = async () => {
    if (!deleteTarget) return
    const masterItemID = deleteTarget.master_item_id
    setAssetBusyID(masterItemID)
    try {
      const result = await removeMasterAsset(masterItemID)
      if (selectedID === masterItemID) closeDetail()
      await refresh()
      setAssetActionMessage(result.queue.queue_error ? t('library.assetRemoveSavedWithWarning') : t('library.assetRemoveSuccess'))
    } finally {
      setAssetBusyID(null)
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const detail = selectedID ? <LibraryDetail masterItemID={selectedID} workspace={workspace} externalReloadToken={detailReloadToken} onBack={closeDetail} onOpenAgent={openAgent} onStopAsset={(masterItemID) => { void stopAsset(masterItemID) }} onRemoveAsset={setDeleteTarget} assetBusy={assetBusyID === selectedID} t={t} /> : null

  const content = selectedID ? detail : (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="nova-library-toolbar grid shrink-0 gap-2 border-b border-[var(--nova-border)] bg-[var(--nova-surface)] p-3 md:grid-cols-[minmax(220px,1.7fr)_minmax(130px,1fr)_minmax(130px,1fr)_150px]">
        <label className="relative block">
          <span className="sr-only">{t('library.search')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('library.search')} className="pl-8" />
        </label>
        <label>
          <span className="sr-only">{t('library.recordKind')}</span>
          <select value={recordKind} onChange={(event) => setRecordKind(event.target.value)} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
            <option value="">{t('library.recordKind')}: {t('library.all')}</option>
            <option value="character_template">{t('library.recordKindValue.character_template')}</option>
            <option value="lorebook_template">{t('library.recordKindValue.lorebook_template')}</option>
          </select>
        </label>
        <label>
          <span className="sr-only">{t('library.semanticType')}</span>
          <select value={semanticType} onChange={(event) => setSemanticType(event.target.value)} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
            <option value="">{t('library.semanticType')}: {t('library.all')}</option>
            <option value="character">{t('library.semanticTypeValue.character')}</option>
            <option value="lorebook">{t('library.semanticTypeValue.lorebook')}</option>
          </select>
        </label>
        <label>
          <span className="sr-only">{t('library.availability')}</span>
          <select value={availability} onChange={(event) => setAvailability(event.target.value as '' | 'staging' | 'usable')} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
            <option value="">{t('library.availability')}: {t('library.all')}</option>
            <option value="staging">{t('library.staging')}</option>
            <option value="usable">{t('library.usable')}</option>
          </select>
        </label>
      </div>
      <div className="nova-library-results min-h-0 flex-1 overflow-auto p-3">
        {assetActionMessage && <div role="status" className="mb-3 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-2 text-xs text-foreground">{assetActionMessage}</div>}
        {loading ? <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">{t('library.loading')}</div> : error ? null : assets.length === 0 ? (
          <EmptyState icon={Database} title={t('library.empty')} variant="page" className="text-xs text-[var(--nova-text-faint)]" />
        ) : (
          <div className="nova-library-card-grid grid gap-3">
            {assets.map((asset) => (
              <div key={asset.master_item_id} className="nova-library-card flex min-h-40 w-full flex-col rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface)] p-4 transition-colors hover:bg-[var(--nova-surface-2)]">
                <button type="button" onClick={() => { setSelectedID(asset.master_item_id); setAgentOpen(false) }} className="flex min-w-0 flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
                  <span className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--nova-surface-2)] text-[var(--nova-text-muted)]">{asset.record_kind === 'character_template' ? <CharacterAvatar src={asset.avatar_url} alt={asset.name || asset.master_item_id} size="sm" /> : <BookOpen className="size-4" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{asset.name || asset.master_item_id}</span>
                      {asset.record_kind === 'character_template' && asset.tags && asset.tags.length > 0 && <span className="mt-1 flex flex-wrap items-center gap-1" aria-label={t('library.character.tags')}>
                        <span className="mr-0.5 text-[10px] text-muted-foreground">{t('library.character.tags')}:</span>
                        {[...new Set(asset.tags.map(localizedCharacterTag))].map((tag) => <span key={tag} className="rounded-full bg-[var(--nova-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>)}
                      </span>}
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{enumLabel('recordKindValue', asset.record_kind, t)}</span>
                    </span>
                    <AssetStatusBadge pipeline={asset.pipeline} t={t} />
                  </span>
                  <span className="mt-3 line-clamp-3 min-h-15 text-xs leading-5 text-[var(--nova-text-muted)]">{asset.description || t('library.noDescription')}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-[11px] text-muted-foreground">
                    <span>{asset.nested_entry_count > 0 ? t(asset.record_kind === 'character_template' ? 'library.internalSettingCount' : 'library.entryCount', { count: asset.nested_entry_count }) : t(asset.record_kind === 'character_template' ? 'library.completeCharacterCard' : 'library.noEntries')}</span>
                    <span>{asset.usage_count > 0 ? t('library.usageCount', { count: asset.usage_count }) : t('library.notUsed')}</span>
                    <span className="min-w-0 truncate">{t('library.sourceFile')}: {asset.source_name || t('library.unknown')}</span>
                  </span>
                </button>
                {asset.record_kind === 'character_template' && <div className="mt-3 flex justify-end gap-2 border-t border-[var(--nova-border)] pt-3">
                  <Button type="button" variant="outline" size="sm" disabled={assetBusyID === asset.master_item_id || asset.pipeline.translation.pending_fields <= 0} onClick={() => { void stopAsset(asset.master_item_id) }} title={asset.pipeline.translation.pending_fields > 0 ? t('library.assetStop') : t('library.assetStopUnavailable')}><X data-icon="inline-start" />{t('library.assetStop')}</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={assetBusyID === asset.master_item_id} onClick={() => setDeleteTarget(asset)} className="text-destructive hover:text-destructive"><Trash2 data-icon="inline-start" />{t('library.assetRemove')}</Button>
                </div>}
              </div>
            ))}
          </div>
        )}
      </div>
      {total > 0 && (
        <div className="nova-library-pagination flex shrink-0 items-center justify-between border-t border-[var(--nova-border)] px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t('library.page', { page: page + 1, pages })} · {total}</span>
          <span className="flex gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || loading}><ChevronLeft data-icon="inline-start" />{t('library.previous')}</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => Math.min(pages - 1, current + 1))} disabled={page >= pages - 1 || loading}>{t('library.next')}<ChevronRight data-icon="inline-end" /></Button>
          </span>
        </div>
      )}
    </div>
  )

  return (
    <FeaturePageShell
      icon={Database}
      title={selectedID ? t('library.assetDetail') : t('library.title')}
      subtitle={selectedID ? t('library.assetDetailSubtitle') : t('library.subtitle')}
      leadingContent={selectedID ? (
        <Button type="button" variant="ghost" size="icon-xs" onClick={closeDetail} aria-label={t('library.backToList')} title={t('library.backToList')}>
          <ArrowLeft />
        </Button>
      ) : undefined}
      actions={selectedID ? <Button type="button" variant={agentOpen ? 'secondary' : 'outline'} size="sm" aria-pressed={agentOpen} onClick={() => setAgentOpen((value) => !value)}><Bot data-icon="inline-start" />{t('library.configAgent')}</Button> : <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)} className="nova-nav-item border-[var(--nova-border)] bg-[var(--nova-surface-2)]"><FileUp data-icon="inline-start" />{t('library.importToLibrary')}</Button><Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading} className="nova-nav-item border-[var(--nova-border)] bg-[var(--nova-surface-2)]"><RefreshCw data-icon="inline-start" className={loading ? 'animate-spin' : undefined} />{t('library.refresh')}</Button></div>}
      error={selectedID ? undefined : error}
      errorTitle={t('library.loadError')}
      onClose={onClose}
      className="nova-library-page bg-[var(--nova-bg)] text-[var(--nova-text)]"
    >
      <AdaptiveSurface
        right={selectedID && agentOpen ? {
          id: 'master-library-config-manager',
          title: t('library.configAgent'),
          side: 'right',
          icon: <Bot className="size-4" />,
          content: <div className="h-full min-h-0 bg-[var(--nova-surface)]"><ConfigManagerChat workspace={workspace} origin="master-library" resourceId={selectedID} context={{ master_item_id: selectedID, module: '总资料库', ...agentContext }} onMutated={() => setDetailReloadToken((value) => value + 1)} /></div>,
          desktopClassName: 'min-h-0 border-l border-[var(--nova-border)]',
          mobileClassName: 'w-[min(92vw,420px)]',
        } : undefined}
        className="min-h-0 flex-1"
        mainClassName="min-h-0 min-w-0"
        desktopGridClassName={selectedID && agentOpen ? 'grid-cols-[minmax(0,1fr)_minmax(320px,28rem)]' : 'grid-cols-[minmax(0,1fr)]'}
        rightResize={selectedID && agentOpen ? { layoutKey: 'nova-master-library-agent-layout', label: t('layout.resize.right'), defaultSize: '420px', minSize: '300px', maxSize: '65%', mainMinSize: '360px' } : undefined}
      >
        {content}
      </AdaptiveSurface>
      <MasterImportDialog open={importOpen} workspace={workspace} onOpenChange={setImportOpen} onImported={refresh} />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open && !assetBusyID) setDeleteTarget(null) }}
        title={t('library.assetRemoveTitle')}
        description={t('library.assetRemoveDescription', { name: deleteTarget?.name || deleteTarget?.master_item_id || '' })}
        confirmLabel={t('library.assetRemove')}
        tone="danger"
        onConfirm={confirmRemoveAsset}
      />
    </FeaturePageShell>
  )
}

function LibraryDetail({ masterItemID, workspace, externalReloadToken, onBack, onOpenAgent, onStopAsset, onRemoveAsset, assetBusy, t }: { masterItemID: string; workspace: string; externalReloadToken: number; onBack: () => void; onOpenAgent: (context?: Record<string, string>) => void; onStopAsset: (masterItemID: string) => void; onRemoveAsset: (asset: MasterAssetSummary) => void; assetBusy: boolean; t: (key: string, options?: Record<string, unknown>) => string }) {
  const [detail, setDetail] = useState<MasterAssetDetail | null>(null)
  const [pipeline, setPipeline] = useState<MasterPipelineStatus | null>(null)
  const [runtime, setRuntime] = useState<MasterTranslationRuntime | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [proposals, setProposals] = useState<MasterProposal[]>([])
  const [instantiating, setInstantiating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [adventureUsage, setAdventureUsage] = useState<MasterAssetAdventureUsage | null>(null)
  // 精修轮询：记录当前正在轮询的字段路径集合，供按钮禁用与 spinner。
  const [polishingFields, setPolishingFields] = useState<Set<string>>(() => new Set())
  // 每个 field_path 的轮询句柄：interval / timeout / 起始时间 / 启动前 Proposal ID 快照。
  const polishPollersRef = useRef<Map<string, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout>; snapshot: Set<string> }>>(new Map())

  // 提示只在切换资产时清空：操作成功后会触发 reloadToken 刷新，
  // 若在取数 effect 里清空会把刚刚的「已同步」提示一并抹掉。
  useEffect(() => { setActionMessage(null) }, [masterItemID])

  // 切换资产或卸载时清理全部精修轮询，避免拿到上一个资产的 Proposal。
  useEffect(() => {
    return () => {
      for (const entry of polishPollersRef.current.values()) {
        clearInterval(entry.interval)
        clearTimeout(entry.timeout)
      }
      polishPollersRef.current.clear()
    }
  }, [masterItemID])

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setPipeline(null)
    setRuntime(null)
    setProposals([])
    setAdventureUsage(null)
    setError(null)
    Promise.all([
      fetchMasterAsset(masterItemID),
      fetchMasterAssetPipeline(masterItemID),
      fetchMasterAssetTranslations(masterItemID),
      fetchMasterAssetUsages(masterItemID),
    ]).then(async ([asset, nextPipeline, translations, usages]) => {
      const nextDetail = { ...asset, translations: translations.translations, usages: usages.usages }
      const [nextRuntime, nextProposals, nextUsage] = await Promise.all([
        fetchMasterTranslationRuntime(nextDetail),
        fetchMasterAssetProposals(masterItemID),
        fetchMasterAssetAdventureUsage(masterItemID).catch(() => null),
      ])
      if (cancelled) return
      setDetail(nextDetail)
      setPipeline(nextPipeline)
      setRuntime(nextRuntime)
      setProposals(nextProposals.proposals)
      setAdventureUsage(nextUsage?.usage ?? null)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [externalReloadToken, masterItemID, reloadToken])

  if (error) return <div className="flex min-h-0 flex-1 flex-col gap-3 p-4"><div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">{error}</div><Button type="button" variant="outline" size="sm" onClick={onBack}>{t('library.backToList')}</Button></div>
  if (!detail || !pipeline || !runtime) return <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />{t('library.loading')}</div>

  const item = detail.item
  const source = detail.source
  const sourceRevision = detail.source_revision
  const translations = detail.translations
  const usages = detail.usages
  const userState = assetUserState(pipeline, runtime)
  const description = detail.summary.description || t('library.noDescription')
  const contentCount = detail.summary.nested_entry_count ?? nestedEntries(item).length
  const contentLabel = contentCount > 0
    ? t(detail.summary.record_kind === 'character_template' ? 'library.internalSettingCount' : 'library.entryCount', { count: contentCount })
    : t(detail.summary.record_kind === 'character_template' ? 'library.completeCharacterCard' : 'library.noEntries')
  const statusSummary = userState === 'ready'
    ? pipeline.translation.pending_fields > 0 ? t('library.readyWithBackgroundWork') : t('library.readySummary')
    : userState === 'needs_user' ? t('library.needsUserSummary') : t('library.processingSummary')

  const addToAdventure = async () => {
    setInstantiating(true)
    setActionMessage(null)
    try {
      const result = await instantiateMasterAsset(masterItemID)
      setActionMessage(result.skipped_ids.length ? t('library.alreadyInAdventure') : t('library.addedToAdventure'))
      setReloadToken((value) => value + 1)
    } catch (reason: unknown) {
      setActionMessage(t('library.addToAdventureFailed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    } finally {
      setInstantiating(false)
    }
  }

  // 是否可同步完全由后端 usage 决定；前端不用 usages.length 推断，
  // 因为 usages 包含其它冒险的实例，长度 > 0 不代表当前冒险已加入。
  const canSyncToAdventure = !!adventureUsage?.used && !!adventureUsage.has_new_version && detail.summary.availability === 'usable'

  const syncToAdventure = async () => {
    setSyncing(true)
    setActionMessage(null)
    try {
      const response = await syncMasterAssetToAdventure(masterItemID)
      setAdventureUsage(response.usage ?? { used: true, has_new_version: false, loaded_revision: response.result.loaded_revision, current_revision: response.result.loaded_revision })
      setActionMessage(t('library.syncedToAdventure', { count: response.result.updated_lore_ids.length }))
      if (response.result.updated_lore_ids.length > 0) {
        window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { item_ids: response.result.updated_lore_ids } }))
      }
      setReloadToken((value) => value + 1)
    } catch (reason: unknown) {
      setActionMessage(t('library.syncFailed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    } finally {
      setSyncing(false)
    }
  }

  const retryField = async (field: MasterTranslationFieldRuntime) => {
    if (!field.task_id) return
    try {
      await retryTranslationJob(field.task_id)
      setReloadToken((value) => value + 1)
    } catch {
      setActionMessage(t('library.retryUnavailable'))
    }
  }

  const stopPolishing = (fieldPath: string) => {
    const entry = polishPollersRef.current.get(fieldPath)
    if (entry) {
      clearInterval(entry.interval)
      clearTimeout(entry.timeout)
      polishPollersRef.current.delete(fieldPath)
    }
    setPolishingFields((prev) => {
      if (!prev.has(fieldPath)) return prev
      const next = new Set(prev)
      next.delete(fieldPath)
      return next
    })
  }

  const polishField = async (field: MasterTranslationFieldRuntime) => {
    // 避免重复发起：同一字段已在轮询时直接忽略。
    if (polishPollersRef.current.has(field.field_path)) return
    // 启动前的 Proposal ID 快照：只有「新增」的 polish 候选才算本次精修产物，
    // 避免把上一次遗留的候选误判为成功。
    const snapshot = new Set(
      proposals
        .filter((proposal) => proposal.field_path === field.field_path && proposal.kind === 'polish')
        .map((proposal) => proposal.proposal_id),
    )
    try {
      await startMasterAgent(masterItemID, field.field_path, 'polish')
    } catch {
      setActionMessage(t('library.agentUnavailable'))
      return
    }
    setPolishingFields((prev) => new Set(prev).add(field.field_path))
    setActionMessage(t('library.agentProcessing'))

    const interval = setInterval(async () => {
      try {
        const response = await fetchMasterAssetProposals(masterItemID)
        const candidates = response.proposals.filter(
          (proposal) =>
            proposal.field_path === field.field_path &&
            proposal.kind === 'polish' &&
            !snapshot.has(proposal.proposal_id),
        )
        if (candidates.length === 0) return
        const terminal = candidates.find((proposal) => proposal.status === 'conflict' || proposal.status === 'rejected')
        if (terminal) {
          stopPolishing(field.field_path)
          setActionMessage(t('library.polishRejected'))
          setReloadToken((value) => value + 1)
          return
        }
        const ready = candidates.find((proposal) => proposal.status === 'candidate_ready' || proposal.status === 'validated')
        if (ready) {
          stopPolishing(field.field_path)
          setActionMessage(t('library.polishReady'))
          setReloadToken((value) => value + 1)
        }
      } catch {
        // 单次轮询失败不致命，等下一个 tick。
      }
    }, 3000)
    const timeout = setTimeout(() => {
      stopPolishing(field.field_path)
      setActionMessage(t('library.polishTimeout'))
      setReloadToken((value) => value + 1)
    }, 120000)
    polishPollersRef.current.set(field.field_path, { interval, timeout, snapshot })
  }

  const saveEntry = async (entry: Record<string, unknown>, values: EntryEditValues) => {
    const prefix = `${detail.summary.record_kind === 'character_template' ? 'character_book.entries' : 'lorebook.entries'}/${valueOf(entry, 'entry_id', '')}`
    const changes: Array<[string, string]> = [['comment', values.comment], ['content', values.content], ['keys', values.keys], ['secondary_keys', values.secondary_keys]]
    const fields: Record<string, string> = {}
    for (const [field, translation] of changes) {
      const current = nestedEntryField(item, detail.summary.record_kind, entry, field)
      if (translation.trim() === current.trim()) continue
      if (!translation.trim()) throw new Error(t('library.editEmptyField'))
      fields[`${prefix}/${field}`] = translation
    }
    if (Object.keys(fields).length === 0) throw new Error(t('library.editNoChanges'))
    await updateMasterAssetFields(masterItemID, valueOf(item, 'revision', ''), fields)
    setActionMessage(t('library.entrySaved'))
    setReloadToken((value) => value + 1)
  }

  const saveDescription = async (description: string) => {
    await updateMasterAssetDescription(masterItemID, description)
    setActionMessage(t('library.descriptionSaved'))
    setReloadToken((value) => value + 1)
  }

  const saveCharacter = async (values: CharacterEditValues) => {
    const changes: Array<[string, string]> = Object.entries(values)
    const fields: Record<string, string> = {}
    for (const [fieldPath, translation] of changes) {
      const current = masterFieldText(item, fieldPath)
      if (translation.trim() === current.trim()) continue
      if (!translation.trim()) throw new Error(t('library.editEmptyField'))
      fields[fieldPath] = translation
    }
    if (Object.keys(fields).length === 0) throw new Error(t('library.editNoChanges'))
    await updateMasterAssetFields(masterItemID, valueOf(item, 'revision', ''), fields)
    setActionMessage(t('library.characterSaved'))
    setReloadToken((value) => value + 1)
  }

  const saveCharacterTags = async (tags: string[]) => {
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    if (normalized.length === 0) throw new Error(t('library.character.tagsRequired'))
    await updateMasterAssetFields(masterItemID, valueOf(item, 'revision', ''), { 'character.tags': normalized.join('\n') })
    setActionMessage(t('library.character.tagsSaved'))
    setReloadToken((value) => value + 1)
  }

  const addEntryManually = async (values: EntryEditValues) => {
    const name = values.comment.trim()
    const content = values.content.trim()
    if (!name || !content) throw new Error(t('library.manualAddEmptyFields'))
    const keywords = splitEntryKeywords(values.keys)
    const secondaryKeys = splitEntryKeywords(values.secondary_keys)
    await addMasterLorebookEntry(masterItemID, valueOf(item, 'revision', ''), { name, content, keywords, secondary_keys: secondaryKeys })
    const adventureItem = await createLoreItem({
      enabled: true,
      type: 'other',
      name,
      importance: 'important',
      load_mode: 'auto',
      tags: ['叙界总资料库', '手动添加'],
      brief_description: content.slice(0, 240),
      keywords: [...new Set([...keywords, ...secondaryKeys])],
      content,
    })
    window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { item_ids: [adventureItem.id] } }))
    setActionMessage(t('library.manualEntryAdded'))
    setReloadToken((value) => value + 1)
  }

  const addCharacterEntry = async (values: EntryEditValues) => {
    const name = values.comment.trim()
    const content = values.content.trim()
    if (!name || !content) throw new Error(t('library.character.addEntryEmpty'))
    await addMasterCharacterEntry(masterItemID, valueOf(item, 'revision', ''), { name, content })
    setActionMessage(t('library.character.entryAdded'))
    setReloadToken((value) => value + 1)
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <div className="rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface)] p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-xl font-semibold text-foreground">{detail.summary.name}</h1><AssetStatusBadge pipeline={pipeline} runtime={runtime} t={t} /></div>
              <p className="mt-1 text-xs text-muted-foreground">{enumLabel('recordKindValue', detail.summary.record_kind, t)} · {contentLabel}</p>
              {detail.summary.record_kind !== 'lorebook_template' && detail.summary.record_kind !== 'character_template' && <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-foreground">{description}</p>}
              <p className={`mt-3 text-xs ${userState === 'needs_user' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>{statusSummary}</p>
              <p className="mt-3 text-[11px] text-muted-foreground">{t('library.sourceFile')}: {valueOf(source, 'filename', detail.summary.source_name)} · {t('library.importedAt')}: {formatDate(valueOf(sourceRevision, 'imported_at', ''))}</p>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2">
              {detail.summary.record_kind === 'character_template' && <>
                <Button type="button" variant="outline" size="sm" disabled={assetBusy || pipeline.translation.pending_fields <= 0} onClick={() => onStopAsset(masterItemID)} title={pipeline.translation.pending_fields > 0 ? t('library.assetStop') : t('library.assetStopUnavailable')}>{assetBusy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <X data-icon="inline-start" />}{t('library.assetStop')}</Button>
                <Button type="button" variant="ghost" size="sm" disabled={assetBusy} onClick={() => onRemoveAsset(detail.summary)} className="text-destructive hover:text-destructive"><Trash2 data-icon="inline-start" />{t('library.assetRemove')}</Button>
              </>}
              <Button type="button" size="sm" disabled={!workspace || detail.summary.availability !== 'usable' || instantiating} onClick={() => void addToAdventure()}><Plus data-icon="inline-start" />{instantiating ? t('library.addingToAdventure') : t('library.addToAdventure')}</Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!workspace || !canSyncToAdventure || syncing}
                title={canSyncToAdventure ? t('library.syncToAdventure') : t('library.syncUnavailable')}
                onClick={() => void syncToAdventure()}
              >
                <RefreshCw data-icon="inline-start" className={syncing ? 'animate-spin' : undefined} />{syncing ? t('library.syncingToAdventure') : t('library.syncToAdventure')}
              </Button>
            </div>
          </div>
        </div>
        {detail.summary.record_kind === 'lorebook_template' && <MasterDescriptionPanel description={detail.summary.description || ''} onSave={saveDescription} t={t} />}
        {actionMessage && <div className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-2 text-xs text-foreground">{actionMessage}</div>}
        <Tabs defaultValue="content" className="gap-3">
          <TabsList variant="line" className="h-auto w-full justify-start gap-1 overflow-x-auto border-b border-[var(--nova-border)] bg-transparent p-0">
            {(['content', 'progress', 'versions', 'adventures', 'technical'] as const).map((tab) => <TabsTrigger key={tab} value={tab} className="h-10 flex-none rounded-none px-3 text-xs after:bottom-0">{t(`library.tab.${tab}`)}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="content"><AssetContent item={item} recordKind={detail.summary.record_kind} avatarURL={detail.summary.avatar_url} t={t} onSaveEntry={saveEntry} onSaveCharacter={saveCharacter} onSaveCharacterTags={saveCharacterTags} onAddCharacterEntry={detail.summary.record_kind === 'character_template' ? addCharacterEntry : undefined} onManualAddEntry={detail.summary.record_kind === 'lorebook_template' ? addEntryManually : undefined} onOpenAgent={onOpenAgent} /></TabsContent>
          <TabsContent value="progress" className="space-y-3">
            <ProcessingSummary pipeline={pipeline} runtime={runtime} onOpenAgent={onOpenAgent} t={t} />
            <details className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)]">
              <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-foreground">{t('library.showDetailedPipeline')}</summary>
              <div className="border-t border-[var(--nova-border)] p-3"><PipelineOverview pipeline={pipeline} item={item} runtime={runtime} t={t} onRetry={retryField} onPolish={polishField} polishingFields={polishingFields} /></div>
            </details>
            <ReviewWorkbench masterItemID={masterItemID} item={item} runtime={runtime} proposals={proposals} t={t} onChanged={() => setReloadToken((value) => value + 1)} onMessage={setActionMessage} />
          </TabsContent>
          <TabsContent value="versions"><InfoSection title={t('library.translation')}><TranslationSummary pipeline={pipeline} translations={translations} t={t} />{translations.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">{t('library.noTranslations')}</p> : <div className="mt-3 space-y-2">{translations.map((entry, index) => <TranslationRow key={valueOf(entry.version, 'translation_version_id', `${entry.content_version_kind}-${index}`)} entry={entry} activeIDs={activeTranslationVersionIDs(item)} t={t} />)}</div>}</InfoSection></TabsContent>
          <TabsContent value="adventures"><AdventureUsages usages={usages} t={t} /></TabsContent>
          <TabsContent value="technical"><TechnicalInformation detail={detail} activeVersions={activeTranslationVersions(item, translations, t)} t={t} /></TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function nestedEntries(item: Record<string, unknown>) {
  return Array.isArray(item.nested_entries) ? item.nested_entries.map(recordValue).filter((entry) => valueOf(entry, 'entry_id', '') !== '') : []
}

function masterFieldText(item: Record<string, unknown>, path: string) {
  const field = recordValue(recordValue(item.fields)[path])
  return valueOf(field, 'active_text', '') || valueOf(field, 'source_text', '')
}

type CharacterLanguageMode = 'current' | 'original' | 'compare'
type CharacterProfileValue = { current: string; original: string }
type CharacterTagValue = { current: string[]; original: string[] }

const commonCharacterTagTranslations: Record<string, string> = {
  anypov: '任意视角',
  anime: '动漫',
  'big breast': '巨乳',
  'big butt': '大屁股',
  'breeding kink': '繁殖癖',
  cuckolding: '戴绿帽',
  dominant: '支配型',
  elf: '精灵',
  english: '英语',
  exhibitionism: '暴露癖',
  female: '女性',
  horny: '好色',
  humiliation: '羞辱',
  incest: '乱伦',
  human: '人类',
  'huge breasts': '巨乳',
  love: '恋爱',
  male: '男性',
  malepov: '男性视角',
  milf: '熟女',
  mommy: '妈妈型',
  mother: '母亲',
  'multiple greetings': '多开场白',
  nsfw: '成人向',
  ntr: '寝取',
  oc: '原创角色',
  office: '办公室',
  original: '原创',
  'original character': '原创角色',
  pregnancy: '怀孕',
  roleplay: '角色扮演',
  root: '根目录',
  sadistic: '施虐型',
  scenario: '场景',
  smut: '成人向',
  strict: '严厉',
  switch: '双向',
  tavern: '酒馆格式',
  'thick thighs': '丰腴大腿',
  'my dress-up darling': '更衣人偶坠入爱河',
}

function masterFieldPair(item: Record<string, unknown>, path: string): CharacterProfileValue {
  const field = recordValue(recordValue(item.fields)[path])
  const original = valueOf(field, 'source_text', '')
  return { current: valueOf(field, 'active_text', '') || original, original }
}

function splitCharacterTags(value: string) {
  return [...new Set(value.split(/[\r\n,，、]+/).map((tag) => tag.trim()).filter(Boolean))]
}

function localizedCharacterTag(tag: string) {
  return commonCharacterTagTranslations[tag.trim().toLowerCase()] || tag
}

function localizedCharacterTags(tags: string[]) {
  return [...new Set(tags.map(localizedCharacterTag))]
}

function characterTagValue(item: Record<string, unknown>): CharacterTagValue {
  const original = [...new Set([...listValue(recordValue(item.original), 'tags'), ...listValue(recordValue(item.source_semantics), 'tags')])]
  const stored = masterFieldPair(item, 'character.tags')
  return { current: stored.current ? splitCharacterTags(stored.current) : original, original }
}

function nestedPrefix(recordKind: string) {
  return recordKind === 'character_template' ? 'character_book.entries' : 'lorebook.entries'
}

function nestedEntryText(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, field: string) {
  const path = `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${field}`
  const original = recordValue(entry.original)
  return masterFieldText(item, path) || valueOf(original, field, '') || (field === 'comment' ? valueOf(original, 'name', '') : '')
}

function nestedEntryPair(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, field: string): CharacterProfileValue {
  const path = `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${field}`
  const masterField = recordValue(recordValue(item.fields)[path])
  const originalRecord = recordValue(entry.original)
  const original = valueOf(masterField, 'source_text', '') || valueOf(originalRecord, field, '') || (field === 'comment' ? valueOf(originalRecord, 'name', '') : '')
  return { current: valueOf(masterField, 'active_text', '') || original, original }
}

function nestedEntryField(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, field: string) {
  const path = `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${field}`
  const active = masterFieldText(item, path)
  if (active) return active
  const original = recordValue(entry.original)
  const aliases = field === 'keys' ? ['keys', 'key'] : [field]
  return [...new Set(aliases.flatMap((alias) => sourceEntryValues(original, alias)))].join('\n')
}

function nestedEntryKeywords(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>) {
  const original = recordValue(entry.original)
  return [...new Set(['keys', 'key', 'secondary_keys'].flatMap((key) => {
    const translated = masterFieldText(item, `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${key}`)
      .split(/[\r\n,，、]+/).map((part) => part.trim()).filter(Boolean)
    if (translated.length > 0) return translated
    return sourceEntryValues(original, key)
  }))]
}

function sourceEntryValues(original: Record<string, unknown>, key: string) {
  const value = original[key]
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  return typeof value === 'string' && value.trim() !== '' ? [value] : []
}

function originalEntryKeywords(entry: Record<string, unknown>) {
  const original = recordValue(entry.original)
  return [...new Set(['keys', 'key', 'secondary_keys'].flatMap((key) => sourceEntryValues(original, key)))]
}

function splitEntryKeywords(value: string) {
  return [...new Set(value.split(/[\r\n,，、]+/).map((part) => part.trim()).filter(Boolean))]
}

function nestedEntryTitle(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, index: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const comment = nestedEntryText(item, recordKind, entry, 'comment')
  const genericComment = ['comment', 'comments', '评论', 'entry', '条目'].includes(comment.trim().toLowerCase())
  return (!genericComment && comment) || nestedEntryKeywords(item, recordKind, entry)[0] || t('library.unnamedEntry', { index: index + 1 })
}

function formatDate(value: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatBytes(value: string) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return value || '—'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

type EntryEditValues = { comment: string; content: string; keys: string; secondary_keys: string }
type CharacterEditValues = Record<string, string>

function characterOpeningPaths(item: Record<string, unknown>) {
  const paths = Object.keys(recordValue(item.fields)).filter((path) => /^character\.openings\[\d+\]$/.test(path))
  paths.sort((left, right) => Number(left.match(/\d+/)?.[0] || 0) - Number(right.match(/\d+/)?.[0] || 0))
  if (!paths.includes('character.openings[0]')) paths.unshift('character.openings[0]')
  // Keep one empty alternate slot available so a card without alternate
  // greetings can still receive its first one through explicit human editing.
  if (!paths.some((path) => path !== 'character.openings[0]')) paths.push('character.openings[1]')
  return paths
}

function changedCharacterFields(fields: Array<[keyof CharacterEditValues, string, boolean]>, draft: CharacterEditValues, item: Record<string, unknown>) {
  return fields.map(([path, label]) => ({ field_path: path, field_label: label, before: masterFieldText(item, path), after: draft[path] })).filter((change) => change.before.trim() !== change.after.trim())
}

function changedEntryFields(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, draft: EntryEditValues, t: (key: string, options?: Record<string, unknown>) => string) {
  return (['comment', 'content', 'keys', 'secondary_keys'] as const).map((field) => ({ field_path: `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${field}`, field_label: field === 'comment' ? t('library.entryTitle') : field === 'content' ? t('library.content') : field === 'keys' ? t('library.keywords') : t('library.secondaryKeywords'), before: nestedEntryField(item, recordKind, entry, field), after: draft[field] })).filter((change) => change.before.trim() !== change.after.trim())
}

function EditPreview({ changes, t }: { changes: Array<{ field_path: string; field_label: string; before: string; after: string }>; t: (key: string, options?: Record<string, unknown>) => string }) {
  if (changes.length === 0) return <div className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3 text-xs text-muted-foreground">{t('library.editNoChanges')}</div>
  return <div className="space-y-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3"><div className="text-xs font-semibold text-foreground">{t('library.changePreview')}</div>{changes.map((change) => <div key={change.field_path} className="grid gap-2 rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface)] p-2 lg:grid-cols-2"><div><div className="text-[10px] text-muted-foreground">{change.field_label} · {t('library.beforeChange')}</div><p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-foreground">{change.before || '—'}</p></div><div><div className="text-[10px] text-emerald-700 dark:text-emerald-300">{change.field_label} · {t('library.afterChange')}</div><p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-foreground">{change.after || '—'}</p></div></div>)}</div>
}

function MasterDescriptionPanel({ description, onSave, t }: { description: string; onSave: (description: string) => Promise<void>; t: (key: string, options?: Record<string, unknown>) => string }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(description)

  const beginEdit = () => {
    setDraft(description)
    setError(null)
    setEditing(true)
  }
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      setEditing(false)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('library.descriptionSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return <div className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-foreground">{t('library.lorebook.introduction')}</h2>
      {!editing && <Button type="button" variant="outline" size="sm" onClick={beginEdit}><Pencil data-icon="inline-start" />{t('library.editDescription')}</Button>}
    </div>
    {!editing ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{description || t('library.noDescription')}</p> : <div className="mt-3 space-y-2">
      <textarea aria-label={t('library.lorebook.introduction')} className="min-h-28 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t('library.descriptionPlaceholder')} />
      <p className="text-[11px] text-muted-foreground">{t('library.descriptionHint')}</p>
      {error && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving || draft.trim() === description.trim()}>{saving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t('library.saveDescription')}</Button></div>
    </div>}
  </div>
}

function CharacterAvatar({ src, alt, size = 'md' }: { src?: string; alt: string; size?: 'sm' | 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (src && !failed) {
    const sizeClass = size === 'sm' ? 'size-9' : size === 'lg' ? 'size-20' : 'size-16'
    return <img src={src} alt={alt} className={`${sizeClass} object-cover`} onError={() => setFailed(true)} />
  }
  return <UserRound className={size === 'sm' ? 'size-4' : size === 'lg' ? 'size-9' : 'size-8'} aria-hidden="true" />
}

function AssetContent({ item, recordKind, avatarURL, t, onSaveEntry, onSaveCharacter, onSaveCharacterTags, onAddCharacterEntry, onManualAddEntry, onOpenAgent }: { item: Record<string, unknown>; recordKind: string; avatarURL?: string; t: (key: string, options?: Record<string, unknown>) => string; onSaveEntry?: (entry: Record<string, unknown>, values: EntryEditValues) => Promise<void>; onSaveCharacter?: (values: CharacterEditValues) => Promise<void>; onSaveCharacterTags?: (tags: string[]) => Promise<void>; onAddCharacterEntry?: (values: EntryEditValues) => Promise<void>; onManualAddEntry?: (values: EntryEditValues) => Promise<void>; onOpenAgent?: (context?: Record<string, string>) => void }) {
  return recordKind === 'lorebook_template' ? <LorebookReader item={item} recordKind={recordKind} t={t} onSaveEntry={onSaveEntry} onManualAddEntry={onManualAddEntry} onOpenAgent={onOpenAgent} /> : <CharacterReader item={item} avatarURL={avatarURL} t={t} onSaveCharacter={onSaveCharacter} onSaveCharacterTags={onSaveCharacterTags} onSaveEntry={onSaveEntry} onAddCharacterEntry={onAddCharacterEntry} onOpenAgent={onOpenAgent} />
}

function CharacterReader({ item, avatarURL, t, onSaveCharacter, onSaveCharacterTags, onSaveEntry, onAddCharacterEntry, onOpenAgent }: { item: Record<string, unknown>; avatarURL?: string; t: (key: string, options?: Record<string, unknown>) => string; onSaveCharacter?: (values: CharacterEditValues) => Promise<void>; onSaveCharacterTags?: (tags: string[]) => Promise<void>; onSaveEntry?: (entry: Record<string, unknown>, values: EntryEditValues) => Promise<void>; onAddCharacterEntry?: (values: EntryEditValues) => Promise<void>; onOpenAgent?: (context?: Record<string, string>) => void }) {
  const [editing, setEditing] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [tagSaving, setTagSaving] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  const [languageMode, setLanguageMode] = useState<CharacterLanguageMode>('current')
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CharacterEditValues>({})
  const [selectedID, setSelectedID] = useState('profile')
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [entryEditing, setEntryEditing] = useState(false)
  const [addingEntry, setAddingEntry] = useState(false)
  const [entrySaving, setEntrySaving] = useState(false)
  const [entryError, setEntryError] = useState<string | null>(null)
  const [entryDraft, setEntryDraft] = useState<EntryEditValues>({ comment: '', content: '', keys: '', secondary_keys: '' })

  const openingPaths = characterOpeningPaths(item)
  const alternateOpeningPaths = openingPaths.filter((path) => path !== 'character.openings[0]')
  const originalRecord = recordValue(item.original)
  const name = masterFieldPair(item, 'character.name')
  const displayName = name.current || valueOf(originalRecord, 'name', '') || t('library.character.unknown')
  const originalName = name.original || valueOf(originalRecord, 'name', '')
  const tagValue = characterTagValue(item)
  const currentTags = localizedCharacterTags(tagValue.current)
  const originalTags = tagValue.original
  const description = masterFieldPair(item, 'character.description')
  const groups: Array<{ id: string; title: string; values: Array<{ label: string; value: CharacterProfileValue }> }> = [
    { id: 'profile', title: t('library.character.overview'), values: [{ label: t('library.character.description'), value: description }, { label: t('library.character.personality'), value: masterFieldPair(item, 'character.personality') }, { label: t('library.character.creatorNotes'), value: masterFieldPair(item, 'character.creator_notes') }] },
    { id: 'scene', title: t('library.character.sceneOpening'), values: [{ label: t('library.character.scenario'), value: masterFieldPair(item, 'character.scenario') }, { label: t('library.character.firstMessage'), value: masterFieldPair(item, 'character.openings[0]') }, ...alternateOpeningPaths.map((path, index) => ({ label: `${t('library.character.alternateGreetings')} ${index + 1}`, value: masterFieldPair(item, path) }))] },
    { id: 'dialogue', title: t('library.character.exampleDialogue'), values: [{ label: t('library.character.exampleDialogue'), value: masterFieldPair(item, 'character.mes_example') }] },
    { id: 'advanced', title: t('library.character.advancedInstructions'), values: [{ label: t('library.character.systemPrompt'), value: masterFieldPair(item, 'character.system_prompt') }, { label: t('library.character.postHistory'), value: masterFieldPair(item, 'character.post_history_instructions') }] },
  ]
  const entries = nestedEntries(item)
  const advanced = [{ label: t('library.character.systemPrompt'), value: masterFieldPair(item, 'character.system_prompt') }, { label: t('library.character.postHistory'), value: masterFieldPair(item, 'character.post_history_instructions') }]
  const editFields: Array<[keyof CharacterEditValues, string, boolean]> = [
    ['character.name', t('library.character.name'), false], ['character.description', t('library.character.description'), true], ['character.personality', t('library.character.personality'), true], ['character.creator_notes', t('library.character.creatorNotes'), true],
    ['character.scenario', t('library.character.scenario'), true], ['character.openings[0]', t('library.character.firstMessage'), true], ...alternateOpeningPaths.map((path, index) => [path, `${t('library.character.alternateGreetings')} ${index + 1}`, true] as [string, string, boolean]), ['character.mes_example', t('library.character.exampleDialogue'), true],
  ]
  const selectedEntryID = selectedID.startsWith('entry:') ? selectedID.slice('entry:'.length) : ''
  const selectedEntry = entries.find((entry) => valueOf(entry, 'entry_id', '') === selectedEntryID)
  const selectedGroup = groups.find((group) => group.id === selectedID)
  const entryTitle = selectedEntry ? nestedEntryTitle(item, 'character_template', selectedEntry, entries.indexOf(selectedEntry), t) : ''

  useEffect(() => {
    if (selectedEntryID && !selectedEntry) setSelectedID('profile')
  }, [selectedEntry, selectedEntryID])

  const beginEdit = () => {
    setDraft(Object.fromEntries(editFields.map(([path]) => [path, masterFieldText(item, path)])) as CharacterEditValues)
    setEditError(null)
    setPreview(false)
    setEditing(true)
  }
  const save = async () => {
    if (!onSaveCharacter) return
    setSaving(true)
    setEditError(null)
    try { await onSaveCharacter(draft); setEditing(false) } catch (reason: unknown) { setEditError(reason instanceof Error ? reason.message : t('library.editSaveFailed')) } finally { setSaving(false) }
  }
  const beginTagEdit = () => {
    setTagDraft(currentTags.join('、'))
    setTagError(null)
    setEditingTags(true)
  }
  const saveTags = async () => {
    if (!onSaveCharacterTags) return
    const tags = splitCharacterTags(tagDraft)
    if (tags.length === 0) { setTagError(t('library.character.tagsRequired')); return }
    setTagSaving(true)
    setTagError(null)
    try { await onSaveCharacterTags(tags); setEditingTags(false) } catch (reason: unknown) { setTagError(reason instanceof Error ? reason.message : t('library.editSaveFailed')) } finally { setTagSaving(false) }
  }
  const beginEntryEdit = (entry: Record<string, unknown>) => {
    setEntryDraft({ comment: nestedEntryField(item, 'character_template', entry, 'comment'), content: nestedEntryField(item, 'character_template', entry, 'content'), keys: nestedEntryField(item, 'character_template', entry, 'keys'), secondary_keys: nestedEntryField(item, 'character_template', entry, 'secondary_keys') })
    setEntryError(null)
    setAddingEntry(false)
    setEntryEditing(true)
  }
  const beginEntryAdd = () => {
    setSelectedID('new-entry')
    setEntryDraft({ comment: '', content: '', keys: '', secondary_keys: '' })
    setEntryError(null)
    setAddingEntry(true)
    setEntryEditing(true)
  }
  const saveEntry = async () => {
    if (addingEntry ? !onAddCharacterEntry : !selectedEntry || !onSaveEntry) return
    setEntrySaving(true)
    setEntryError(null)
    try {
      if (addingEntry) {
        await onAddCharacterEntry?.(entryDraft)
        setSelectedID('internal')
        setAddingEntry(false)
      } else if (selectedEntry) {
        await onSaveEntry?.(selectedEntry, entryDraft)
      }
      setEntryEditing(false)
    } catch (reason: unknown) {
      setEntryError(reason instanceof Error ? reason.message : t('library.editSaveFailed'))
    } finally { setEntrySaving(false) }
  }

  if (editing) return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-foreground">{t('library.editCharacter')}</h2><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setPreview((value) => !value)} disabled={saving}>{t(preview ? 'library.hidePreview' : 'library.previewChanges')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving || changedCharacterFields(editFields, draft, item).length === 0}>{saving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t('library.saveCharacter')}</Button></div></div><p className="text-xs text-muted-foreground">{t('library.editCharacterHint')}</p>{editError && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{editError}</p>}{preview && <EditPreview changes={changedCharacterFields(editFields, draft, item)} t={t} />}{editFields.map(([path, label, multiline]) => <div key={path} className="block text-xs font-medium text-foreground"><div className="flex items-center justify-between gap-2"><span>{label}</span>{onOpenAgent && <Button type="button" variant="ghost" size="sm" onClick={() => onOpenAgent({ field_path: path, field_label: label })}>{t('library.askAgentField')}</Button>}</div>{multiline ? <textarea aria-label={label} className="mt-1 min-h-28 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft[path]} onChange={(event) => setDraft((current) => ({ ...current, [path]: event.target.value }))} /> : <Input aria-label={label} className="mt-1" value={draft[path]} onChange={(event) => setDraft((current) => ({ ...current, [path]: event.target.value }))} />}</div>)}</div>

  const visibleTags = tagsExpanded ? currentTags : currentTags.slice(0, 8)
  return <div className="space-y-3">
    <div className="rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-4 md:p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-primary/20 bg-primary/10 text-primary"><CharacterAvatar src={avatarURL} alt={displayName} size="lg" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold text-foreground">{displayName}</h2><span className="rounded-full border border-[var(--nova-border)] px-2 py-0.5 text-[11px] text-muted-foreground">{t('library.character.profile')}</span></div>
          {originalName && originalName !== displayName && <p className="mt-1 text-xs text-muted-foreground">{t('library.character.sourceName')}: {originalName}</p>}
          <div className="mt-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[11px] font-medium text-muted-foreground">{t('library.character.tags')}</h3>{onSaveCharacterTags && !editingTags && <Button type="button" variant="ghost" size="sm" onClick={beginTagEdit}><Pencil data-icon="inline-start" />{t('library.character.editTags')}</Button>}</div>
            {editingTags ? <div className="mt-2 space-y-2"><Input aria-label={t('library.character.tags')} placeholder={t('library.character.tagsPlaceholder')} value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} /><p className="text-[11px] text-muted-foreground">{t('library.character.tagsHint')}</p>{tagError && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{tagError}</p>}<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setEditingTags(false)} disabled={tagSaving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={() => void saveTags()} disabled={tagSaving || !tagDraft.trim()}>{tagSaving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t('library.character.saveTags')}</Button></div></div> : languageMode === 'compare' ? <div className="mt-2 space-y-2"><div><div className="mb-1 text-[10px] text-muted-foreground">{t('library.character.currentContent')}</div><CharacterTagList tags={currentTags} emptyLabel={t('library.character.tagsEmpty')} /></div><div className="border-t border-[var(--nova-border)] pt-2"><div className="mb-1 text-[10px] text-muted-foreground">{t('library.character.originalContent')}</div><CharacterTagList tags={originalTags} emptyLabel={t('library.character.tagsEmpty')} /></div></div> : <div className="mt-2"><CharacterTagList tags={visibleTags} emptyLabel={t('library.character.tagsEmpty')} />{currentTags.length > 8 && <Button type="button" variant="ghost" size="sm" className="mt-1 px-0" onClick={() => setTagsExpanded((value) => !value)}>{t(tagsExpanded ? 'library.character.collapseTags' : 'library.character.expandTags', { count: currentTags.length })}</Button>}</div>}
          </div>
        </div>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{t('library.character.profileHint')}</p><div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-1" role="group" aria-label={t('library.character.languageMode')}><Button type="button" size="sm" variant={languageMode === 'current' ? 'default' : 'ghost'} onClick={() => setLanguageMode('current')}>{t('library.character.currentContent')}</Button><Button type="button" size="sm" variant={languageMode === 'original' ? 'default' : 'ghost'} onClick={() => setLanguageMode('original')}>{t('library.character.originalContent')}</Button><Button type="button" size="sm" variant={languageMode === 'compare' ? 'default' : 'ghost'} onClick={() => setLanguageMode('compare')}>{t('library.character.compareContent')}</Button></div></div>
    {onSaveCharacter && <div className="flex justify-end"><Button type="button" variant="outline" size="sm" onClick={beginEdit}><Pencil data-icon="inline-start" />{t('library.editCharacter')}</Button></div>}
    <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface)] p-2" aria-label={t('library.character.entryDirectory')}>
        <div className="flex items-center justify-between gap-2 px-2 py-2"><div><p className="text-xs font-semibold text-foreground">{t('library.character.entryDirectory')}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{t('library.character.entryDirectoryHint')}</p></div>{onAddCharacterEntry && <Button type="button" variant="outline" size="icon-xs" onClick={beginEntryAdd} aria-label={t('library.character.addEntry')} title={t('library.character.addEntry')}><Plus /></Button>}</div>
        <nav className="space-y-1">
          {groups.map((group) => { const hasContent = group.values.some(({ value }) => value.current || value.original); return <button key={group.id} type="button" aria-current={selectedID === group.id ? 'page' : undefined} onClick={() => { setSelectedID(group.id); setEntryEditing(false) }} className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${selectedID === group.id ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:bg-[var(--nova-surface-2)] hover:text-foreground'}`}><span className="min-w-0 truncate">{group.title}</span>{!hasContent && <span className="shrink-0 text-[10px] text-muted-foreground">{t('library.character.unknown')}</span>}</button> })}
          <button type="button" aria-current={selectedID === 'internal' ? 'page' : undefined} onClick={() => { setSelectedID('internal'); setEntryEditing(false) }} className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${selectedID === 'internal' ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:bg-[var(--nova-surface-2)] hover:text-foreground'}`}><span>{t('library.character.internalSettings')}</span><span className="shrink-0 text-[10px] text-muted-foreground">{entries.length > 0 ? entries.length : t('library.character.unknown')}</span></button>
          {entries.map((entry, index) => { const id = valueOf(entry, 'entry_id', String(index)); return <button key={id} type="button" aria-current={selectedID === `entry:${id}` ? 'page' : undefined} onClick={() => { setSelectedID(`entry:${id}`); setEntryEditing(false) }} className={`ml-2 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${selectedID === `entry:${id}` ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:bg-[var(--nova-surface-2)] hover:text-foreground'}`}><span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" /><span className="min-w-0 truncate">{nestedEntryTitle(item, 'character_template', entry, index, t)}</span></button> })}
        </nav>
      </aside>
      <main className="min-w-0">
        {selectedID === 'new-entry' && entryEditing ? <CharacterEntryEditor draft={entryDraft} setDraft={setEntryDraft} error={entryError} saving={entrySaving} isNew t={t} onCancel={() => { setEntryEditing(false); setSelectedID('internal') }} onSave={() => void saveEntry()} /> : selectedEntry ? entryEditing ? <CharacterEntryEditor draft={entryDraft} setDraft={setEntryDraft} error={entryError} saving={entrySaving} t={t} onCancel={() => setEntryEditing(false)} onSave={() => void saveEntry()} /> : <InfoSection title={entryTitle}><div className="flex justify-end"><Button type="button" variant="outline" size="sm" onClick={() => beginEntryEdit(selectedEntry)}><Pencil data-icon="inline-start" />{t('library.editEntry')}</Button></div><div className="mt-3"><CharacterProfileText value={nestedEntryPair(item, 'character_template', selectedEntry, 'content')} mode={languageMode} t={t} emptyLabel={t('library.character.unknown')} /></div></InfoSection> : selectedID === 'internal' ? <InfoSection title={t('library.character.internalSettings')}><p className="text-xs text-muted-foreground">{entries.length > 0 ? t('library.character.internalHint') : t('library.character.unknown')}</p></InfoSection> : selectedGroup ? <>{selectedID === 'advanced' && <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('library.character.advancedHint')}</div>}<CharacterReadingSection title={selectedGroup.title} values={selectedGroup.values} mode={languageMode} t={t} showEmpty emptyLabel={t('library.character.unknown')} /></> : <InfoSection title={t('library.character.advancedInstructions')}><div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('library.character.advancedHint')}</div><CharacterReadingValues values={advanced} mode={languageMode} t={t} emptyLabel={t('library.character.unknown')} /></InfoSection>}
      </main>
    </div>
  </div>
}

function CharacterEntryEditor({ draft, setDraft, error, saving, isNew = false, t, onCancel, onSave }: { draft: EntryEditValues; setDraft: (value: EntryEditValues | ((current: EntryEditValues) => EntryEditValues)) => void; error: string | null; saving: boolean; isNew?: boolean; t: (key: string, options?: Record<string, unknown>) => string; onCancel: () => void; onSave: () => void }) {
  return <InfoSection title={t(isNew ? 'library.character.addEntry' : 'library.editEntry')}><div className="space-y-3"><p className="text-xs text-muted-foreground">{t('library.character.entryEditorHint')}</p>{error && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}<label className="block text-xs font-medium text-foreground">{t('library.entryTitle')}<Input aria-label={t('library.entryTitle')} className="mt-1" value={draft.comment} onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))} /></label><label className="block text-xs font-medium text-foreground">{t('library.content')}<textarea aria-label={t('library.content')} className="mt-1 min-h-52 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} /></label>{!isNew && <><label className="block text-xs font-medium text-foreground">{t('library.keywords')}<Input aria-label={t('library.keywords')} className="mt-1" value={draft.keys} onChange={(event) => setDraft((current) => ({ ...current, keys: event.target.value }))} /></label><label className="block text-xs font-medium text-foreground">{t('library.secondaryKeywords')}<Input aria-label={t('library.secondaryKeywords')} className="mt-1" value={draft.secondary_keys} onChange={(event) => setDraft((current) => ({ ...current, secondary_keys: event.target.value }))} /></label></>}<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={onSave} disabled={saving || !draft.comment.trim() || !draft.content.trim()}>{saving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t(isNew ? 'library.character.saveEntry' : 'library.saveEntry')}</Button></div></div></InfoSection>
}

function CharacterReadingSection({ title, values, mode, t, showEmpty = false, emptyLabel }: { title: string; values: Array<{ label: string; value: CharacterProfileValue }>; mode: CharacterLanguageMode; t: (key: string, options?: Record<string, unknown>) => string; showEmpty?: boolean; emptyLabel?: string }) {
  const visible = showEmpty ? values : values.filter(({ value }) => value.current || value.original)
  if (visible.length === 0) return null
  return <InfoSection title={title}><CharacterReadingValues values={visible} mode={mode} t={t} emptyLabel={emptyLabel} /></InfoSection>
}

function CharacterReadingValues({ values, mode, t, emptyLabel }: { values: Array<{ label: string; value: CharacterProfileValue }>; mode: CharacterLanguageMode; t: (key: string, options?: Record<string, unknown>) => string; emptyLabel?: string }) {
  return <div className="space-y-4">{values.map(({ label, value }) => <div key={label}><h3 className="text-[11px] font-medium text-muted-foreground">{label}</h3><div className="mt-1"><CharacterProfileText value={value} mode={mode} t={t} emptyLabel={emptyLabel} /></div></div>)}</div>
}

function CharacterProfileText({ value, mode, t, emptyLabel }: { value: CharacterProfileValue; mode: CharacterLanguageMode; t: (key: string, options?: Record<string, unknown>) => string; emptyLabel?: string }) {
  const current = value.current || value.original
  const original = value.original || value.current
  const fallback = emptyLabel || t('library.noContent')
  if (mode === 'compare') return <div className="space-y-2"><div><div className="text-[10px] text-muted-foreground">{t('library.character.currentContent')}</div><p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{current || fallback}</p></div><div className="border-t border-[var(--nova-border)] pt-2"><div className="text-[10px] text-muted-foreground">{t('library.character.originalContent')}</div><p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{original || fallback}</p></div></div>
  return <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{(mode === 'original' ? original : current) || fallback}</p>
}

function CharacterTagList({ tags, emptyLabel }: { tags: string[]; emptyLabel: string }) {
  return tags.length > 0 ? <div className="flex flex-wrap gap-1.5">{tags.map((tag) => <span key={tag} className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">{tag}</span>)}</div> : <span className="text-xs text-muted-foreground">{emptyLabel}</span>
}

function LorebookReader({ item, recordKind, t, onSaveEntry, onManualAddEntry, onOpenAgent }: { item: Record<string, unknown>; recordKind: string; t: (key: string, options?: Record<string, unknown>) => string; onSaveEntry?: (entry: Record<string, unknown>, values: EntryEditValues) => Promise<void>; onManualAddEntry?: (values: EntryEditValues) => Promise<void>; onOpenAgent?: (context?: Record<string, string>) => void }) {
  const entries = nestedEntries(item)
  const [query, setQuery] = useState('')
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [selectedID, setSelectedID] = useState(valueOf(entries[0], 'entry_id', ''))
  const [editing, setEditing] = useState(false)
  const [manualAdding, setManualAdding] = useState(false)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [draft, setDraft] = useState<EntryEditValues>({ comment: '', content: '', keys: '', secondary_keys: '' })
  const needle = query.trim().toLowerCase()
  const filtered = entries.filter((entry, index) => {
    if (!needle) return true
    const haystack = [nestedEntryTitle(item, recordKind, entry, index, t), nestedEntryText(item, recordKind, entry, 'content'), ...nestedEntryKeywords(item, recordKind, entry), ...originalEntryKeywords(entry)].join('\n').toLowerCase()
    return haystack.includes(needle)
  })
  const active = filtered.find((entry) => valueOf(entry, 'entry_id', '') === selectedID) || filtered[0]
  const beginEdit = () => {
    if (!active) return
    setDraft({ comment: nestedEntryText(item, recordKind, active, 'comment'), content: nestedEntryText(item, recordKind, active, 'content'), keys: nestedEntryField(item, recordKind, active, 'keys'), secondary_keys: nestedEntryField(item, recordKind, active, 'secondary_keys') })
    setEditError(null)
    setPreview(false)
    setEditing(true)
  }
  const beginManualAdd = () => {
    if (!onManualAddEntry) return
    setDraft({ comment: '', content: '', keys: '', secondary_keys: '' })
    setEditError(null)
    setPreview(false)
    setManualAdding(true)
    setEditing(false)
  }
  const save = async () => {
    if (!active || !onSaveEntry) return
    setSaving(true)
    setEditError(null)
    try { await onSaveEntry(active, draft); setEditing(false) } catch (reason: unknown) { setEditError(reason instanceof Error ? reason.message : t('library.editSaveFailed')) } finally { setSaving(false) }
  }
  const saveManual = async () => {
    if (!onManualAddEntry) return
    setSaving(true)
    setEditError(null)
    try { await onManualAddEntry(draft); setManualAdding(false) } catch (reason: unknown) { setEditError(reason instanceof Error ? reason.message : t('library.manualAddFailed')) } finally { setSaving(false) }
  }
  const editorOpen = editing || manualAdding
  if (entries.length === 0) return <div className="space-y-3"><InfoSection title={t('library.fullContent')}><p className="text-sm text-muted-foreground">{t('library.noEntries')}</p></InfoSection></div>
  return <div className="overflow-hidden rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface)]">
    <div className="flex items-center justify-between border-b border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3 lg:hidden"><span className="text-xs font-medium text-foreground">{t('library.entryDirectory')}</span><Button type="button" variant="outline" size="sm" onClick={() => setDirectoryOpen(true)}><Menu data-icon="inline-start" />{t('library.openEntryDirectory')}</Button></div>
    <div className="relative grid min-h-[34rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
    <aside className={`${directoryOpen ? 'fixed inset-y-0 left-0 z-50 block w-[min(86vw,20rem)] shadow-2xl' : 'hidden'} border-b border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3 lg:static lg:block lg:border-b-0 lg:border-r lg:shadow-none`}>
      <div className="mb-3 flex items-center justify-between lg:hidden"><span className="text-xs font-semibold text-foreground">{t('library.entryDirectory')}</span><Button type="button" variant="ghost" size="icon-xs" onClick={() => setDirectoryOpen(false)} aria-label={t('library.closeEntryDirectory')}><X /></Button></div>
      <label className="relative block"><span className="sr-only">{t('library.searchEntries')}</span><Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('library.searchEntries')} className="bg-[var(--nova-surface)] pl-8" /></label>
      <div className="mt-3 max-h-72 space-y-1 overflow-auto lg:max-h-[30rem]">{filtered.length === 0 ? <p className="px-2 py-4 text-xs text-muted-foreground">{t('library.noMatchingEntries')}</p> : filtered.map((entry) => { const id = valueOf(entry, 'entry_id', ''); return <button key={id} type="button" onClick={() => { setSelectedID(id); setDirectoryOpen(false); setEditing(false); setManualAdding(false); setEditError(null) }} aria-current={active === entry ? 'true' : undefined} className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${active === entry ? 'bg-[var(--nova-active)] font-medium text-foreground' : 'text-[var(--nova-text-muted)] hover:bg-[var(--nova-hover)] hover:text-foreground'}`}><span className="block truncate">{nestedEntryTitle(item, recordKind, entry, entries.indexOf(entry), t)}</span><span className="mt-0.5 block truncate text-[10px] opacity-70">{nestedEntryKeywords(item, recordKind, entry).slice(0, 3).join(' · ')}</span></button> })}</div>
    </aside>
    <article className="min-w-0 p-4 md:p-6">{active ? <>{!editorOpen ? <><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-lg font-semibold text-foreground">{nestedEntryTitle(item, recordKind, active, entries.indexOf(active), t)}</h2><div className="flex flex-wrap gap-2">{onOpenAgent && <Button type="button" variant="outline" size="sm" onClick={() => onOpenAgent({ field_path: `${nestedPrefix(recordKind)}/${valueOf(active, 'entry_id', '')}/content`, field_label: t('library.content') })}><Bot data-icon="inline-start" />{t('library.askAgentField')}</Button>}{onSaveEntry && <Button type="button" variant="outline" size="sm" onClick={beginEdit}><Pencil data-icon="inline-start" />{t('library.editEntry')}</Button>}{onManualAddEntry && <Button type="button" variant="outline" size="sm" onClick={beginManualAdd}><Plus data-icon="inline-start" />{t('library.manualAddEntry')}</Button>}</div></div><p className="mt-5 whitespace-pre-wrap text-sm leading-7 text-foreground">{nestedEntryText(item, recordKind, active, 'content') || t('library.noContent')}</p>{nestedEntryKeywords(item, recordKind, active).length > 0 && <div className="mt-6 border-t border-[var(--nova-border)] pt-4"><h3 className="text-[11px] font-medium text-muted-foreground">{t('library.keywords')}</h3><div className="mt-2 flex flex-wrap gap-1.5">{nestedEntryKeywords(item, recordKind, active).map((keyword) => <span key={keyword} className="rounded-full border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2 py-1 text-[11px] text-foreground">{keyword}</span>)}</div></div>}</> : <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-foreground">{manualAdding ? t('library.manualAddEntryTitle') : t('library.editEntry')}</h2><div className="flex flex-wrap gap-2">{!manualAdding && <Button type="button" variant="outline" size="sm" onClick={() => setPreview((value) => !value)} disabled={saving}>{t(preview ? 'library.hidePreview' : 'library.previewChanges')}</Button>}<Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setManualAdding(false) }} disabled={saving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={() => void (manualAdding ? saveManual() : save())} disabled={saving || (manualAdding ? !draft.comment.trim() || !draft.content.trim() : changedEntryFields(item, recordKind, active, draft, t).length === 0)}>{saving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t(manualAdding ? 'library.manualAddEntry' : 'library.saveEntry')}</Button></div></div><p className="text-xs text-muted-foreground">{t(manualAdding ? 'library.manualAddEntryHint' : 'library.editEntryHint')}</p>{editError && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{editError}</p>}{!manualAdding && preview && <EditPreview changes={changedEntryFields(item, recordKind, active, draft, t)} t={t} />}{<label className="block text-xs font-medium text-foreground">{t('library.entryTitle')}<Input className="mt-1" value={draft.comment} onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))} /></label>}<label className="block text-xs font-medium text-foreground">{t('library.content')}<textarea className="mt-1 min-h-48 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} /></label><div className="grid gap-3 md:grid-cols-2"><label className="block text-xs font-medium text-foreground">{t('library.keywords')}<textarea className="mt-1 min-h-24 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.keys} onChange={(event) => setDraft((current) => ({ ...current, keys: event.target.value }))} /></label><label className="block text-xs font-medium text-foreground">{t('library.secondaryKeywords')}<textarea className="mt-1 min-h-24 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.secondary_keys} onChange={(event) => setDraft((current) => ({ ...current, secondary_keys: event.target.value }))} /></label></div></div>}</> : <p className="text-sm text-muted-foreground">{t('library.noMatchingEntries')}</p>}</article>
    {directoryOpen && <button type="button" aria-label={t('library.closeEntryDirectory')} className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setDirectoryOpen(false)} />}
    </div>
  </div>
}

function ProcessingSummary({ pipeline, runtime, onOpenAgent, t }: { pipeline: MasterPipelineStatus; runtime: MasterTranslationRuntime; onOpenAgent: () => void; t: (key: string, options?: Record<string, unknown>) => string }) {
  return <InfoSection title={t('library.processingStatus')}><div className="space-y-2">{NODE_KEYS.map((key) => { const node = nodeFor(pipeline, key); const label = key === 'translation' ? translationSummaryLabel(runtime, pipeline.translation.total_fields, t) : key === 'instantiate' ? pipeline.usage_count > 0 ? t('library.joinedAdventureCount', { count: pipeline.usage_count }) : t('library.notJoinedCurrentAdventure') : node.status === 'completed' ? t(`library.nodeSummary.${key}`) : statusLabel(node.status, t); return <div key={key} className="flex items-center gap-2 text-xs"><span className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${statusClass(node.status)}`}><StatusIcon status={node.status} /></span><span className="font-medium text-foreground">{nodeLabel(key, t)}</span><span className="text-muted-foreground">{label}</span></div> })}</div><Button type="button" variant="outline" size="sm" className="mt-4" onClick={onOpenAgent}><Bot data-icon="inline-start" />{t('library.askAgent')}</Button></InfoSection>
}

function AdventureUsages({ usages, t }: { usages: Array<Record<string, unknown>>; t: (key: string, options?: Record<string, unknown>) => string }) {
  return <InfoSection title={t('library.adventures')}>{usages.length === 0 ? <p className="text-xs text-muted-foreground">{t('library.noUsages')}</p> : <div className="grid gap-2 md:grid-cols-2">{usages.map((usage, index) => <div key={valueOf(usage, 'instance_id', `${valueOf(usage, 'adventure_key', 'usage')}-${index}`)} className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3"><div className="text-sm font-medium text-foreground">{valueOf(usage, 'adventure_key', t('library.unknown'))}</div><div className="mt-1 text-[11px] text-muted-foreground">{t('library.generatedLoreCount', { count: listValue(usage, 'target_lore_ids').length })}</div></div>)}</div>}</InfoSection>
}

function TechnicalInformation({ detail, activeVersions, t }: { detail: MasterAssetDetail; activeVersions: string; t: (key: string, options?: Record<string, unknown>) => string }) {
  const item = detail.item
  const sourceRevision = detail.source_revision
  return <div className="space-y-3"><InfoSection title={t('library.technicalInformation')}><InfoGrid items={[[t('library.masterItemId'), detail.summary.master_item_id], [t('library.revision'), detail.summary.master_revision], [t('library.sourceRevision'), valueOf(sourceRevision, 'revision', detail.summary.source_revision)], [t('library.sha'), valueOf(sourceRevision, 'sha256', t('library.unknown'))], [t('library.archive'), valueOf(sourceRevision, 'original_path', t('library.unknown'))], [t('library.revisionAt'), formatDate(valueOf(sourceRevision, 'imported_at', ''))], [t('library.bytes'), formatBytes(valueOf(sourceRevision, 'bytes', ''))], [t('library.translation'), activeVersions]]} /></InfoSection><RawContent item={item} t={t} /></div>
}

function RawContent({ item, t }: { item: Record<string, unknown>; t: (key: string, options?: Record<string, unknown>) => string }) {
  const sections = [
    ['original', item.original],
    ['nestedEntries', item.nested_entries],
    ['sourceSemantics', item.source_semantics],
    ['runtimeSemantics', item.runtime_semantics],
    ['fields', item.fields],
  ] as const
  return <InfoSection title={t('library.rawData')}><div className="space-y-2">{sections.map(([key, value]) => <details key={key} className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)]"><summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">{t(`library.content.${key}`)}</summary><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--nova-border)] px-3 py-3 font-mono text-[11px] leading-5 text-muted-foreground">{JSON.stringify(value ?? {}, null, 2)}</pre></details>)}</div></InfoSection>
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)] p-4"><h2 className="text-xs font-semibold text-foreground">{title}</h2><div className="mt-3">{children}</div></section>
}

function InfoGrid({ items }: { items: Array<[string, string]> }) {
  return <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">{items.map(([label, value]) => <div key={label} className="min-w-0"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 break-words text-xs text-foreground">{value || '—'}</div></div>)}</div>
}

function PipelineOverview({ pipeline, item, runtime, t, onRetry, onPolish, polishingFields }: { pipeline: MasterPipelineStatus; item: Record<string, unknown>; runtime: MasterTranslationRuntime; t: (key: string, options?: Record<string, unknown>) => string; onRetry: (field: MasterTranslationFieldRuntime) => Promise<void>; onPolish: (field: MasterTranslationFieldRuntime) => Promise<void>; polishingFields: Set<string> }) {
  const [selectedNode, setSelectedNode] = useState<LibraryNodeKey>('translation')
  const node = nodeFor(pipeline, selectedNode)
  return <InfoSection title={t('library.pipeline')}><p className="mb-3 text-[11px] text-muted-foreground">{t('library.pipelineReadOnly')}</p><div className="grid gap-2 md:grid-cols-7">{NODE_KEYS.map((key) => { const nextNode = nodeFor(pipeline, key); return <button key={key} type="button" onClick={() => setSelectedNode(key)} className={`rounded-lg border p-2 text-left transition-colors hover:brightness-95 ${statusClass(nextNode.status)} ${selectedNode === key ? 'ring-2 ring-primary/30' : ''}`} title={nextNode.reason ? t('library.nodeReason', { reason: nextNode.reason }) : undefined}><div className="flex items-center gap-1.5"><StatusIcon status={nextNode.status} /><span className="text-xs font-medium">{nodeLabel(key, t)}</span></div><div className="mt-1 text-[10px] opacity-80">{key === 'translation' ? translationSummaryLabel(runtime, pipeline.translation.total_fields, t) : statusLabel(nextNode.status, t)}</div>{nextNode.inferred && <div className="mt-1 text-[10px] opacity-70">{t('library.inferred')}</div>}</button> })}</div><div className="mt-4 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3"><div className="flex items-center gap-2 text-xs font-medium text-foreground"><span>{nodeLabel(selectedNode, t)}</span><span className="text-[11px] font-normal text-muted-foreground">{statusLabel(node.status, t)}</span></div><div className="mt-3">{selectedNode === 'translation' ? <TranslationFieldList runtime={runtime} t={t} onRetry={onRetry} onPolish={onPolish} polishingFields={polishingFields} /> : selectedNode === 'check' ? <IssueList pipeline={pipeline} t={t} /> : <NodeEvidence node={node} item={item} nodeKey={selectedNode} t={t} />}</div></div></InfoSection>
}

function NodeEvidence({ node, item, nodeKey, t }: { node: MasterPipelineNode; item: Record<string, unknown>; nodeKey: LibraryNodeKey; t: (key: string, options?: Record<string, unknown>) => string }) {
  const original = item.original && typeof item.original === 'object' && !Array.isArray(item.original) ? Object.keys(item.original) : []
  const fields = item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields) ? Object.keys(item.fields) : []
  const names = nodeKey === 'parse' ? original : fields
  return <div className="space-y-2 text-xs"><div className="text-muted-foreground">{node.reason || t('library.inferred')}</div><div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface)] p-2"><div className="text-[11px] text-muted-foreground">{nodeKey === 'parse' ? t('library.recognizedFields') : t('library.normalizedFields')}</div><div className="mt-1 break-words text-foreground">{names.length ? names.join(', ') : t('library.noFieldEvidence')}</div></div>{node.input_revision && <div className="font-mono text-[10px] text-muted-foreground">{t('library.inputRevision')}: {node.input_revision}</div>}{node.output_revision && <div className="font-mono text-[10px] text-muted-foreground">{t('library.outputRevision')}: {node.output_revision}</div>}</div>
}

function TranslationFieldList({ runtime, t, onRetry, onPolish, polishingFields }: { runtime: MasterTranslationRuntime; t: (key: string, options?: Record<string, unknown>) => string; onRetry: (field: MasterTranslationFieldRuntime) => Promise<void>; onPolish: (field: MasterTranslationFieldRuntime) => Promise<void>; polishingFields: Set<string> }) {
  if (runtime.fields.length === 0) return <p className="text-xs text-muted-foreground">{t('library.noFieldEvidence')}</p>
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-medium text-foreground">{translationSummaryLabel(runtime, runtime.total_fields, t)}</span><span className="text-[11px] text-muted-foreground">{runtime.runtime_available ? t('library.runtimeAggregated') : t('library.translationUnavailable')}</span></div>{runtime.fields.map((field) => <TranslationFieldRow key={field.field_path} field={field} t={t} onRetry={onRetry} onPolish={onPolish} polishingFields={polishingFields} />)}</div>
}

function TranslationFieldRow({ field, t, onRetry, onPolish, polishingFields }: { field: MasterTranslationFieldRuntime; t: (key: string, options?: Record<string, unknown>) => string; onRetry: (field: MasterTranslationFieldRuntime) => Promise<void>; onPolish: (field: MasterTranslationFieldRuntime) => Promise<void>; polishingFields: Set<string> }) {
  const [open, setOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const needsRetry = (field.task_status === 'failed' || field.task_status === 'cancelled') && Boolean(field.task_id)
  const recoveryProcessing = ['eligible', 'agent_running', 'proposal_ready', 'applying', 'revalidating'].includes(field.recovery_status || '')
  const polishing = polishingFields.has(field.field_path)
  const userStatus = recoveryProcessing ? t('library.agentProcessing') : field.recovery_status === 'recovered' ? t('library.fieldCompleted') : field.recovery_status === 'needs_user' ? t('library.fieldNeedsConfirmation') : field.review_required ? t('library.fieldNeedsConfirmation') : field.task_status === 'cancelled' ? t('library.fieldCancelled') : field.task_status === 'failed' ? t('library.fieldNeedsAttention') : field.task_status === 'completed' && field.content_version_status !== 'original' ? t('library.fieldCompleted') : field.task_status === 'running' || field.task_status === 'queued' || field.task_status === 'paused' ? t('library.fieldProcessing') : t('library.fieldNotCompleted')
  return <div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface)] p-2.5"><div className="flex items-center gap-2"><button type="button" onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${field.review_required || field.task_status === 'failed' || field.task_status === 'cancelled' ? 'border-amber-500/40 bg-amber-500/10 text-amber-600' : field.task_status === 'completed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'border-blue-500/40 bg-blue-500/10 text-blue-600'}`}>{field.task_status === 'completed' && !field.review_required ? <Check className="size-3" /> : field.task_status === 'failed' || field.task_status === 'cancelled' ? <XCircle className="size-3" /> : field.task_status === 'running' ? <Loader2 className="size-3 animate-spin" /> : <Circle className="size-2.5" />}</span><span className="min-w-0 truncate font-mono text-[11px] text-foreground">{field.field_path}</span><span className="truncate text-[11px] text-muted-foreground">{userStatus}</span><ChevronDown className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} /></button><Button type="button" variant="ghost" size="sm" disabled={polishing} onClick={() => void onPolish(field)}>{polishing ? <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" /> : null}{polishing ? t('library.polishing') : t('library.polish')}</Button>{needsRetry && <Button type="button" variant="outline" size="icon-xs" disabled={retrying} onClick={async () => { setRetrying(true); try { await onRetry(field) } finally { setRetrying(false) } }} title={t('library.retry')} aria-label={t('library.retry')}>{retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}</Button>}</div>{(field.task_status === 'failed' || field.task_status === 'cancelled') && <div className="mt-1 pl-7 text-[11px] text-amber-700 dark:text-amber-300">{t('library.fieldNotCompleted')}</div>}{open && <div className="mt-2 grid gap-1 border-t border-[var(--nova-border)] pt-2 text-[11px] text-muted-foreground sm:grid-cols-2"><span>{t('library.taskStatus')}: {enumLabel('status', field.task_status, t)}</span><span>{t('library.contentVersion')}: {enumLabel('contentKind', field.content_version_status, t)}</span><span>{t('library.translationVersion')}: {field.translation_version || t('library.unknown')}</span><span>{t('library.inputRevision')}: {field.input_revision || t('library.unknown')}</span>{field.failure_reason && <span className="sm:col-span-2">{t('library.failureReason')}: {field.failure_reason}</span>}</div>}</div>
}

type ReviewRowStatus = 'needsEdit' | 'pendingConfirm' | 'failed' | 'conflict'

const APPLYABLE_PROPOSAL_STATUSES = new Set(['proposed', 'validated', 'candidate_ready'])
const REVIEWABLE_PROPOSAL_STATUSES = new Set(['proposed', 'validated', 'candidate_ready', 'conflict'])
const MASTER_PROPOSAL_BATCH_SIZE = 100

interface ReviewRow {
  key: string
  field_path: string
  field_label: string
  source: string
  candidate: string
  reason: string
  codes: string[]
  risk: string
  status: ReviewRowStatus
  task_id?: string
  proposal?: MasterProposal
}

function proposalIsNewer(left: string, right: string) {
  if (!left || !right) return false
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return leftTime > rightTime
  return left > right
}

function reviewableProposals(proposals: MasterProposal[]) {
  const latestAppliedAt = new Map<string, string>()
  for (const proposal of proposals) {
    if (proposal.status !== 'applied') continue
    const current = latestAppliedAt.get(proposal.field_path)
    if (!current || proposalIsNewer(proposal.updated_at, current)) latestAppliedAt.set(proposal.field_path, proposal.updated_at)
  }
  const seenCandidates = new Set<string>()
  return proposals.filter((proposal) => {
    if (!REVIEWABLE_PROPOSAL_STATUSES.has(proposal.status)) return false
    const appliedAt = latestAppliedAt.get(proposal.field_path)
    if (appliedAt && !proposalIsNewer(proposal.updated_at, appliedAt)) return false
    const candidateKey = `${proposal.field_path}\u0000${proposal.patch.translation.trim()}`
    if (seenCandidates.has(candidateKey)) return false
    seenCandidates.add(candidateKey)
    return true
  })
}

function reviewRowsFor(item: Record<string, unknown>, runtime: MasterTranslationRuntime | null, proposals: MasterProposal[], t: (key: string, options?: Record<string, unknown>) => string): ReviewRow[] {
  const rows: ReviewRow[] = []
  const fields = recordValue(item.fields)
  const visibleProposals = reviewableProposals(proposals)
  const proposalFields = new Set([
    ...visibleProposals.map((proposal) => proposal.field_path),
    ...proposals.filter((proposal) => proposal.status === 'applied').map((proposal) => proposal.field_path),
  ])
  for (const field of runtime?.fields ?? []) {
    if (proposalFields.has(field.field_path)) continue
    const queueFailed = field.quality_status === 'failed' || field.task_status === 'failed'
    const needsReview = field.quality_status === 'needs_review' || field.review_required
    if (!queueFailed && !needsReview) continue
    const source = valueOf(recordValue(fields[field.field_path]), 'source_text', '')
    rows.push({
      key: `f:${field.field_path}`, field_path: field.field_path, field_label: translationFieldLabel(field.field_path, t),
      source, candidate: field.candidate_translation || '',
      reason: field.quality_reason || field.failure_reason || '', codes: field.quality_codes || [],
      risk: valueOf(recordValue(fields[field.field_path]), 'risk', 'safe') || 'safe',
      status: queueFailed ? 'failed' : 'needsEdit',
      task_id: field.task_id,
    })
  }
  for (const proposal of visibleProposals) {
    const source = valueOf(recordValue(fields[proposal.field_path]), 'source_text', '') || proposal.original
    rows.push({
      key: `p:${proposal.proposal_id}`, field_path: proposal.field_path, field_label: translationFieldLabel(proposal.field_path, t),
      source, candidate: proposal.patch.translation,
      reason: proposal.reason || '', codes: [],
      risk: proposal.risk || 'safe',
      status: proposal.status === 'conflict' ? 'conflict' : 'pendingConfirm',
      proposal,
    })
  }
  rows.sort((left, right) => left.field_path.localeCompare(right.field_path))
  return rows
}

function ReviewWorkbench({ masterItemID, item, runtime, proposals, t, onChanged, onMessage }: { masterItemID: string; item: Record<string, unknown>; runtime: MasterTranslationRuntime | null; proposals: MasterProposal[]; t: (key: string, options?: Record<string, unknown>) => string; onChanged: () => void; onMessage: (message: string) => void }) {
  const rows = reviewRowsFor(item, runtime, proposals, t)
  const [selected, setSelected] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [openRows, setOpenRows] = useState<string[]>([])
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState('')
  const applyingRowsRef = useRef(new Set<string>())
  const applyingBatchRef = useRef(false)
  const [batchBusy, setBatchBusy] = useState<'retranslate' | 'save' | 'apply' | ''>('')
  const [riskConfirm, setRiskConfirm] = useState<{ rows: ReviewRow[]; forceConflicts: boolean } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<ReviewRow[] | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const rowKeySignature = rows.map((row) => row.key).join('\u0000')
  useEffect(() => {
    const rowKeys = new Set(rowKeySignature ? rowKeySignature.split('\u0000') : [])
    setOpenRows((current) => {
      const next = current.filter((key) => rowKeys.has(key))
      return next.length === current.length ? current : next
    })
    setSelected((current) => {
      const next = current.filter((key) => rowKeys.has(key))
      return next.length === current.length ? current : next
    })
  }, [rowKeySignature])
  if (rows.length === 0) return null
  const selectedRows = rows.filter((row) => selected.includes(row.key))
  const draftOf = (row: ReviewRow) => drafts[row.key] ?? row.candidate
  const isDirty = (row: ReviewRow) => { const draft = draftOf(row).trim(); return draft !== row.candidate.trim() && draft !== '' }
  const hasCandidate = (row: ReviewRow) => draftOf(row).trim() !== ''
  const canApply = (row: ReviewRow) => hasCandidate(row) && (isDirty(row) || !row.proposal || APPLYABLE_PROPOSAL_STATUSES.has(row.proposal.status))
  const canForceConflict = (row: ReviewRow) => hasCandidate(row) && row.proposal?.status === 'conflict'
  const retranslatable = selectedRows.filter((row) => row.task_id && (row.status === 'needsEdit' || row.status === 'failed' || row.status === 'conflict'))
  const saveable = selectedRows.filter((row) => isDirty(row))
  const applicable = selectedRows.filter((row) => !isDirty(row) && canApply(row))
  const forceApplicable = selectedRows.filter(canForceConflict)
  const deletable = selectedRows.filter((row) => row.proposal || row.task_id)
  const anyDirty = rows.some((row) => isDirty(row))

  const progressMessage = (done: number, total: number, succeeded: number, failed: number) => t('library.review.progress', { done, total, succeeded, failed })

  const retranslate = async (targets: ReviewRow[]) => {
    if (targets.length === 0 || batchBusy) return
    setBatchBusy('retranslate')
    let succeeded = 0, failed = 0
    for (const [index, row] of targets.entries()) {
      try { await retryTranslationJob(row.task_id || ''); succeeded += 1 } catch { failed += 1 }
      if (failed > 0) setRowErrors((current) => ({ ...current, [row.key]: t('library.review.rowFailed', { reason: t('library.retryUnavailable') }) }))
      if (index === targets.length - 1) onMessage(progressMessage(index + 1, targets.length, succeeded, failed))
    }
    setBatchBusy('')
    onChanged()
  }

  const saveDraft = async (row: ReviewRow, allowProtectedTokenMismatch = isDirty(row)): Promise<MasterProposal | null> => {
    const draft = draftOf(row).trim()
    if (!draft) return null
    try {
      const created = await createMasterProposal(masterItemID, { field_path: row.field_path, translation: draft, kind: 'recovery', apply_mode: 'confirm', reason: '人工审核修改' })
      const validated = created.proposal.status === 'proposed'
        ? allowProtectedTokenMismatch
          ? await validateMasterProposal(created.proposal.proposal_id, { allowProtectedTokenMismatch: true })
          : await validateMasterProposal(created.proposal.proposal_id)
        : created
      setRowErrors((current) => { const next = { ...current }; delete next[row.key]; return next })
      return validated.proposal
    } catch (reason: unknown) {
      setRowErrors((current) => ({ ...current, [row.key]: t('library.review.rowFailed', { reason: reason instanceof Error ? reason.message : String(reason) }) }))
      return null
    }
  }

  const saveEdits = async (targets: ReviewRow[]) => {
    if (targets.length === 0 || batchBusy) return
    setBatchBusy('save')
    let succeeded = 0, failed = 0
    for (const [index, row] of targets.entries()) {
      if (await saveDraft(row)) succeeded += 1; else failed += 1
      if (index === targets.length - 1) onMessage(failed === 0 ? t('library.review.saved') : progressMessage(index + 1, targets.length, succeeded, failed))
    }
    setBatchBusy('')
    onChanged()
  }

  const resolveAppliedJob = async (row: ReviewRow) => {
    if (!row.task_id) return
    try { await resolveTranslationJob(row.task_id, 'applied') } catch { /* Master apply already succeeded; queue cleanup is best effort. */ }
  }

  const deleteRows = async (targets: ReviewRow[]) => {
    const candidates = targets.filter((row) => row.proposal || row.task_id)
    if (candidates.length === 0 || deleteBusy) return
    setDeleteBusy(true)
    let deleted = 0
    let failed = 0
    const deletedKeys = new Set<string>()
    const proposalRows = candidates.filter((row) => row.proposal)
    if (proposalRows.length === 1) {
      const row = proposalRows[0]
      try {
        const result = await rejectMasterProposal(row.proposal?.proposal_id || '')
        if (result.proposal.status === 'rejected') {
          deleted += 1
          deletedKeys.add(row.key)
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    } else {
      for (let start = 0; start < proposalRows.length; start += MASTER_PROPOSAL_BATCH_SIZE) {
        const chunk = proposalRows.slice(start, start + MASTER_PROPOSAL_BATCH_SIZE)
        try {
          const result = await rejectMasterProposals(masterItemID, chunk.map((row) => row.proposal?.proposal_id || ''))
          deleted += result.rejected_count
          for (const entry of result.results) {
            const row = chunk.find((candidate) => candidate.proposal?.proposal_id === entry.proposal_id)
            if (entry.status === 'rejected') {
              if (row) deletedKeys.add(row.key)
            } else {
              failed += 1
              if (row) setRowErrors((current) => ({ ...current, [row.key]: t('library.review.rowFailed', { reason: entry.error || entry.status }) }))
            }
          }
        } catch {
          failed += chunk.length
        }
      }
    }
    const runtimeRows = candidates.filter((row) => !row.proposal && row.task_id)
    await Promise.all(runtimeRows.map(async (row) => {
      try {
        await deleteTranslationJob(row.task_id || '')
        deleted += 1
        deletedKeys.add(row.key)
      } catch {
        failed += 1
        setRowErrors((current) => ({ ...current, [row.key]: t('library.review.rowFailed', { reason: t('library.review.deleteFailed') }) }))
      }
    }))
    setSelected((current) => current.filter((key) => !deletedKeys.has(key)))
    if (deleted > 0) onChanged()
    onMessage(failed > 0 ? progressMessage(deleted + failed, candidates.length, deleted, failed) : t('library.review.deleted', { count: deleted }))
    setDeleteBusy(false)
  }

  const applyRows = async (targets: ReviewRow[], confirmedHighRisk: boolean, forceConflicts = false) => {
    const candidates = targets.filter((row) => isDirty(row) || canApply(row) || (forceConflicts && canForceConflict(row)))
    if (candidates.length === 0 || busyKey || batchBusy || applyingBatchRef.current || applyingRowsRef.current.size > 0) return
    const highRisk = candidates.filter((row) => row.risk === 'high')
    if (highRisk.length > 0 && !confirmedHighRisk) { setRiskConfirm({ rows: candidates, forceConflicts }); return }
    setRiskConfirm(null)
    applyingBatchRef.current = true
    setBatchBusy('apply')
    try {
      const prepared: Array<{ row: ReviewRow; proposal: MasterProposal }> = []
      let failedCount = 0
      for (const row of candidates) {
        const proposal = isDirty(row) || !row.proposal ? await saveDraft(row) : row.proposal
        if (!proposal || (!APPLYABLE_PROPOSAL_STATUSES.has(proposal.status) && !(forceConflicts && proposal.status === 'conflict'))) {
          failedCount += 1
          continue
        }
        prepared.push({ row, proposal })
      }

      const results: Array<{ proposal_id: string; status: string; error?: string; translation_version_id?: string }> = []
      let applied = 0
      for (let start = 0; start < prepared.length; start += MASTER_PROPOSAL_BATCH_SIZE) {
        const chunk = prepared.slice(start, start + MASTER_PROPOSAL_BATCH_SIZE)
        const proposalIDs = chunk.map(({ proposal }) => proposal.proposal_id)
        const result = forceConflicts
          ? await applyMasterProposals(masterItemID, proposalIDs, confirmedHighRisk, true, true)
          : await applyMasterProposals(masterItemID, proposalIDs, confirmedHighRisk)
        applied += result.applied_count
        results.push(...result.results)
      }

      await Promise.all(results.filter((entry) => entry.status === 'applied').map((entry) => {
        const row = prepared.find((candidate) => candidate.proposal.proposal_id === entry.proposal_id)?.row
        return row ? resolveAppliedJob(row) : Promise.resolve()
      }))

      const conflicted = results.filter((entry) => entry.status === 'conflict').length
      failedCount += results.length - applied - conflicted
      for (const entry of results) {
        if (entry.status !== 'applied') {
          const row = prepared.find((candidate) => candidate.proposal.proposal_id === entry.proposal_id)?.row
          if (row) setRowErrors((current) => ({ ...current, [row.key]: t('library.review.rowFailed', { reason: entry.error || entry.status }) }))
        }
      }
      onMessage(t('library.review.applyResult', { applied, total: candidates.length, conflicted, failed: failedCount }))
    } catch (reason: unknown) {
      onMessage(t('library.proposalUnavailable'))
    } finally {
      applyingBatchRef.current = false
      setBatchBusy('')
      onChanged()
    }
  }

  const applySingle = async (row: ReviewRow) => {
    const forceConflict = canForceConflict(row)
    if (busyKey || batchBusy || applyingBatchRef.current || applyingRowsRef.current.has(row.key) || (!canApply(row) && !forceConflict)) return
    if (row.risk === 'high') { setRiskConfirm({ rows: [row], forceConflicts: forceConflict }); return }
    applyingRowsRef.current.add(row.key)
    setBusyKey(row.key)
    try {
      const proposal = isDirty(row) || !row.proposal ? await saveDraft(row) : row.proposal
      if (!proposal) return
      if (proposal.status === 'proposed') {
        if (forceConflict || isDirty(row)) await validateMasterProposal(proposal.proposal_id, { allowProtectedTokenMismatch: true })
        else await validateMasterProposal(proposal.proposal_id)
      }
      if (forceConflict || isDirty(row) || proposal.protected_token_override) await applyMasterProposal(proposal.proposal_id, true, forceConflict, true)
      else await applyMasterProposal(proposal.proposal_id, true)
      await resolveAppliedJob(row)
      onMessage(t('library.review.savedApplied'))
    } catch (reason: unknown) {
      setRowErrors((current) => ({ ...current, [row.key]: reason instanceof Error ? reason.message : t('library.proposalUnavailable') }))
    } finally {
      applyingRowsRef.current.delete(row.key)
      setBusyKey('')
      onChanged()
    }
  }

  const selectBy = (predicate: (row: ReviewRow) => boolean) => setSelected(rows.filter(predicate).map((row) => row.key))
  const statusLabelOf = (status: ReviewRowStatus) => t(`library.review.status.${status}`)
  const statusClassOf = (status: ReviewRowStatus) => status === 'pendingConfirm' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : status === 'needsEdit' ? 'border-amber-500/40 bg-amber-500/10 text-amber-600' : 'border-red-500/40 bg-red-500/10 text-red-600'

  return <InfoSection title={t('library.review.title')}>
    <p className="mb-3 text-[11px] text-muted-foreground">{t('library.review.hint')}</p>
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3 text-xs">
      <Button type="button" variant="outline" size="xs" onClick={() => selectBy(() => true)}>{t('library.review.selectAll')}</Button>
      <Button type="button" variant="outline" size="xs" onClick={() => selectBy((row) => row.status === 'needsEdit')}>{t('library.review.selectNeedsWork')}</Button>
      <Button type="button" variant="outline" size="xs" onClick={() => selectBy((row) => row.status === 'failed' || row.status === 'conflict')}>{t('library.review.selectFailed')}</Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => setSelected([])}>{t('library.review.clearSelection')}</Button>
      {anyDirty && <span className="text-[11px] text-amber-600">{t('library.review.unsaved')}</span>}
      <span className="grow" />
      {retranslatable.length > 0 && <Button type="button" variant="outline" size="xs" disabled={Boolean(batchBusy)} onClick={() => void retranslate(retranslatable)}>
        {batchBusy === 'retranslate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
        {t('library.review.batchRetranslate', { count: retranslatable.length })}
      </Button>}
      {saveable.length > 0 && <Button type="button" variant="outline" size="xs" disabled={Boolean(batchBusy)} onClick={() => void saveEdits(saveable)}>
        {batchBusy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        {t('library.review.batchSave', { count: saveable.length })}
      </Button>}
      {applicable.length > 0 && <Button type="button" size="xs" disabled={Boolean(batchBusy)} onClick={() => void applyRows(applicable, false)}>
        {batchBusy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        {t('library.review.batchApply', { count: applicable.length })}
      </Button>}
      {forceApplicable.length > 0 && <Button type="button" size="xs" variant="outline" disabled={Boolean(batchBusy)} onClick={() => void applyRows(forceApplicable, false, true)}>
        {batchBusy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        {t('library.review.forceBatchApply', { count: forceApplicable.length })}
      </Button>}
      {deletable.length > 0 && <Button type="button" variant="outline" size="xs" disabled={Boolean(batchBusy) || deleteBusy} onClick={() => setDeleteConfirm(deletable)}>
        {deleteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        {t('library.review.batchDelete', { count: deletable.length })}
      </Button>}
    </div>
    {riskConfirm && (
      <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
        <div className="font-medium text-foreground">{t('library.review.highRiskTitle')}</div>
        <p className="mt-1 text-muted-foreground">{t('library.review.highRiskMessage')}</p>
        <ul className="mt-2 list-inside list-disc space-y-1">{riskConfirm.rows.map((row) => <li key={`risk-${row.key}`} className="text-foreground">{row.field_label} <span className="text-muted-foreground">({row.field_path})</span></li>)}</ul>
        <div className="mt-3 flex gap-2">
          <Button type="button" size="xs" disabled={batchBusy === 'apply'} onClick={() => { const confirmation = riskConfirm; setRiskConfirm(null); void applyRows(confirmation.rows, true, confirmation.forceConflicts) }}>{t('library.review.highRiskConfirm')}</Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setRiskConfirm(null)}>{t('common.cancel')}</Button>
        </div>
      </div>
    )}
    <div className="space-y-2">
      {rows.map((row) => {
        const dirty = isDirty(row)
        const checked = selected.includes(row.key)
        const open = openRows.includes(row.key)
        const detailsID = `review-details-${row.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
        const displayReason = row.reason === '人工审核修改' ? '' : row.reason
        return (
          <div key={row.key} className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3 text-xs">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input type="checkbox" aria-label={t('library.selectProposal')} checked={checked} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.key] : current.filter((key) => key !== row.key))} />
              <Button type="button" variant="ghost" size="icon-xs" aria-expanded={open} aria-controls={detailsID} aria-label={t(open ? 'library.review.collapse' : 'library.review.expand')} onClick={() => setOpenRows((current) => open ? current.filter((key) => key !== row.key) : [...current, row.key])}>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
              </Button>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusClassOf(row.status)}`}>{statusLabelOf(row.status)}</span>
              <span className="min-w-0 max-w-full truncate font-medium text-foreground" title={row.field_path}>{row.field_label}</span>
              {row.risk === 'high' && <span title={t('library.review.risk.high')}><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-label={t('library.review.risk.high')} /></span>}
              <span className="min-w-0 grow" />
              {row.task_id && (row.status === 'needsEdit' || row.status === 'failed' || row.status === 'conflict') && (
                <Button type="button" variant="outline" size="xs" className="relative z-10 shrink-0" disabled={Boolean(batchBusy)} onClick={() => void retranslate([row])}><RotateCcw className="h-3.5 w-3.5" />{t('library.review.retranslate')}</Button>
              )}
              {dirty && <Button type="button" variant="outline" size="xs" className="relative z-10 shrink-0" disabled={Boolean(batchBusy)} onClick={() => void saveEdits([row])}><Check className="h-3.5 w-3.5" />{t('library.review.save')}</Button>}
              {(row.proposal || hasCandidate(row) || dirty) && <Button type="button" size="xs" className="relative z-10 shrink-0" disabled={Boolean(busyKey) || Boolean(batchBusy)} onClick={() => void applySingle(row)}>{busyKey === row.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{t(row.proposal?.status === 'conflict' ? 'library.review.forceApply' : row.proposal && !dirty ? 'library.review.apply' : 'library.review.saveApply')}</Button>}
              <Button type="button" variant="outline" size="xs" className="relative z-10 shrink-0 text-[var(--nova-danger)]" disabled={Boolean(busyKey) || Boolean(batchBusy) || deleteBusy} onClick={() => setDeleteConfirm([row])}><Trash2 className="h-3.5 w-3.5" />{t('library.review.delete')}</Button>
            </div>
            {(displayReason || row.codes.length > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                {row.codes.length > 0 ? row.codes.map((code) => t(`library.review.quality.${code}`)).join('；') : null}
                {displayReason ? <span className="text-muted-foreground">{displayReason}</span> : null}
              </div>
            )}
            {open && <div id={detailsID} className="mt-3 grid gap-2 border-t border-[var(--nova-border)] pt-3 lg:grid-cols-2">
              <div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2">
                <div className="mb-1 text-[10px] text-muted-foreground">{t('library.review.source')}</div>
                <p className="max-h-40 overflow-auto whitespace-pre-wrap leading-5 text-foreground">{row.source || '—'}</p>
              </div>
              <div className="grid gap-1">
                <div className="text-[10px] text-muted-foreground">{t('library.review.candidate')}</div>
                <textarea
                  value={draftOf(row)}
                  onChange={(event) => setDrafts((current) => ({ ...current, [row.key]: event.target.value }))}
                  placeholder={t('library.review.editPlaceholder')}
                  className="min-h-28 w-full resize-y rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2 leading-5 text-foreground"
                />
              </div>
            </div>}
            {rowErrors[row.key] && <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">{rowErrors[row.key]}</div>}
          </div>
        )
      })}
    </div>
    <ConfirmDialog
      open={Boolean(deleteConfirm)}
      onOpenChange={(open) => { if (!open && !deleteBusy) setDeleteConfirm(null) }}
      title={deleteConfirm?.length === 1 ? t('library.review.deleteTitle') : t('library.review.deleteBatchTitle', { count: deleteConfirm?.length || 0 })}
      description={deleteConfirm?.some((row) => isDirty(row)) ? t('library.review.deleteUnsavedDescription') : t('library.review.deleteDescription')}
      confirmLabel={t('common.delete')}
      tone="danger"
      details={deleteConfirm?.map((row) => `${row.field_label} · ${row.field_path}`).slice(0, 20)}
      onConfirm={() => deleteRows(deleteConfirm || [])}
    />
  </InfoSection>
}

function IssueList({ pipeline, t }: { pipeline: MasterPipelineStatus; t: (key: string, options?: Record<string, unknown>) => string }) {
  if (pipeline.issues.length === 0) return <p className="text-xs text-muted-foreground">{t('library.noIssues')}</p>
  return <div className="space-y-2">{pipeline.issues.map((issue) => <div key={issue.id} className={`rounded-lg border p-3 text-xs ${issue.blocking ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-foreground">{issue.blocking ? t('library.blocking') : t('library.warning')}</span><span className="font-mono text-[11px] text-muted-foreground">{issue.code}</span><span className="text-[11px] text-muted-foreground">{enumLabel('node', issue.stage, t)}</span></div><p className="mt-1 text-foreground">{issue.message}</p>{issue.reason && <p className="mt-1 text-[11px] text-muted-foreground">{t('library.reason')}: {issue.reason}</p>}</div>)}</div>
}

function TranslationSummary({ pipeline, translations, t }: { pipeline: MasterPipelineStatus; translations: MasterAssetDetail['translations']; t: (key: string, options?: Record<string, unknown>) => string }) {
  const kinds = Object.entries(pipeline.translation.content_version_kind)
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Metric label={t('library.activeFields')} value={`${pipeline.translation.active_fields} / ${pipeline.translation.total_fields}`} /><Metric label={t('library.reviewFields')} value={String(pipeline.translation.review_fields)} /><Metric label={t('library.failedFields')} value={String(pipeline.translation.failed_fields)} /><Metric label={t('library.translation')} value={String(translations.length)} /><div><div className="text-[10px] text-muted-foreground">{t('library.translationKinds')}</div><div className="mt-1 space-y-0.5 text-[11px] text-foreground">{kinds.length === 0 ? t('library.unknown') : kinds.map(([kind, count]) => <div key={kind}>{enumLabel('contentKind', kind, t)}: {count}</div>)}</div></div></div>
}

function activeTranslationVersions(item: Record<string, unknown>, translations: MasterAssetDetail['translations'], t: (key: string) => string) {
  const uniqueIDs = [...activeTranslationVersionIDs(item)]
  if (uniqueIDs.length === 0) return t('library.unknown')
  return uniqueIDs.map((id) => {
    const version = translations.find((entry) => valueOf(entry.version, 'translation_version_id', '') === id)
    return version ? `${id} · ${enumLabel('contentKind', version.content_version_kind, t)}` : id
  }).join(', ')
}

function activeTranslationVersionIDs(item: Record<string, unknown>) {
  const fields = item.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return new Set<string>()
  const ids = Object.values(fields).flatMap((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return []
    const id = (field as Record<string, unknown>).active_translation_version_id
    return typeof id === 'string' && id ? [id] : []
  })
  return new Set(ids)
}

function Metric({ label, value }: { label: string; value: string }) { return <div><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium text-foreground">{value}</div></div> }

function translationFieldLabel(fieldPath: string, t: (key: string, options?: Record<string, unknown>) => string) {
  const field = fieldPath.split('/').pop() || fieldPath.split('.').pop() || fieldPath
  const labels: Record<string, string> = { name: 'library.versionField.name', description: 'library.versionField.description', personality: 'library.versionField.personality', content: 'library.versionField.content', comment: 'library.versionField.comment', keys: 'library.versionField.keys' }
  const key = labels[field]
  const label = key ? t(key) : t('library.versionField.other')
  return fieldPath.includes('/entries/') ? t('library.nestedVersionField', { field: label }) : label
}

function TranslationRow({ entry, activeIDs, t }: { entry: MasterAssetDetail['translations'][number]; activeIDs: Set<string>; t: (key: string, options?: Record<string, unknown>) => string }) {
  const version = entry.version
  const id = valueOf(version, 'translation_version_id', '')
  const current = activeIDs.has(id)
  return <article className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-foreground">{enumLabel('contentKind', entry.content_version_kind, t)}</span>{current && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">{t('library.currentVersion')}</span>}<span className="text-[11px] text-muted-foreground">{t('library.versionFieldLabel')}: {translationFieldLabel(valueOf(version, 'field_path', ''), t)}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{valueOf(version, 'translation', t('library.unknown'))}</p><div className="mt-2 text-[10px] text-muted-foreground">{current ? t('library.currentTranslation') : t('library.historicalTranslation')} · {formatDate(valueOf(version, 'created_at', ''))}</div></article>
}
