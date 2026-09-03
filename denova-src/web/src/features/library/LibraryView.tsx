import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, BookOpen, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, Database, FileUp, Loader2, Menu, MinusCircle, Pencil, Plus, RefreshCw, RotateCcw, Search, UserRound, X, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfigManagerChat } from '@/components/Chat/ConfigManagerChat'
import { EmptyState } from '@/components/common/EmptyState'
import { AdaptiveSurface } from '@/components/layout/adaptive-surface'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { applyMasterProposal, applyMasterProposals, createMasterProposal, fetchMasterAsset, fetchMasterAssetPipeline, fetchMasterAssetProposals, fetchMasterAssetTranslations, fetchMasterAssetUsages, fetchMasterTranslationRuntime, instantiateMasterAsset, listMasterAssets, retryTranslationJob, startMasterAgent, validateMasterProposal, type MasterAssetDetail, type MasterAssetSummary, type MasterPipelineNode, type MasterPipelineStatus, type MasterProposal, type MasterTranslationFieldRuntime, type MasterTranslationRuntime } from '@/lib/api-client'
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
  if (status === 'failed') return <XCircle className="size-4" aria-hidden="true" />
  if (status === 'warning' || status === 'review_required' || status === 'stale') return <AlertTriangle className="size-4" aria-hidden="true" />
  if (status === 'skipped') return <MinusCircle className="size-4" aria-hidden="true" />
  return <Circle className="size-3.5" aria-hidden="true" />
}

function statusClass(status: string) {
  if (status === 'completed') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed') return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
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
    void listMasterAssets({ query, recordKind, semanticType, availability: availability || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((result) => { setAssets(result.assets); setTotal(result.total) })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const closeDetail = () => {
    setSelectedID(null)
    setAgentOpen(false)
    setAgentContext({})
  }
  const openAgent = (context: Record<string, string> = {}) => {
    setAgentContext(context)
    setAgentOpen(true)
  }
  const detail = selectedID ? <LibraryDetail masterItemID={selectedID} workspace={workspace} externalReloadToken={detailReloadToken} onBack={closeDetail} onOpenAgent={openAgent} t={t} /> : null

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
        {loading ? <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">{t('library.loading')}</div> : error ? null : assets.length === 0 ? (
          <EmptyState icon={Database} title={t('library.empty')} variant="page" className="text-xs text-[var(--nova-text-faint)]" />
        ) : (
          <div className="nova-library-card-grid grid gap-3">
            {assets.map((asset) => (
              <button key={asset.master_item_id} type="button" onClick={() => { setSelectedID(asset.master_item_id); setAgentOpen(false) }} className="nova-library-card flex min-h-40 w-full flex-col rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface)] p-4 text-left transition-colors hover:bg-[var(--nova-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
                <span className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--nova-surface-2)] text-[var(--nova-text-muted)]">{asset.record_kind === 'character_template' ? <UserRound className="size-4" /> : <BookOpen className="size-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{asset.name || asset.master_item_id}</span>
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
    </FeaturePageShell>
  )
}

function LibraryDetail({ masterItemID, workspace, externalReloadToken, onBack, onOpenAgent, t }: { masterItemID: string; workspace: string; externalReloadToken: number; onBack: () => void; onOpenAgent: (context?: Record<string, string>) => void; t: (key: string, options?: Record<string, unknown>) => string }) {
  const [detail, setDetail] = useState<MasterAssetDetail | null>(null)
  const [pipeline, setPipeline] = useState<MasterPipelineStatus | null>(null)
  const [runtime, setRuntime] = useState<MasterTranslationRuntime | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [proposals, setProposals] = useState<MasterProposal[]>([])
  const [instantiating, setInstantiating] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setPipeline(null)
    setRuntime(null)
    setProposals([])
    setError(null)
    setActionMessage(null)
    Promise.all([
      fetchMasterAsset(masterItemID),
      fetchMasterAssetPipeline(masterItemID),
      fetchMasterAssetTranslations(masterItemID),
      fetchMasterAssetUsages(masterItemID),
    ]).then(async ([asset, nextPipeline, translations, usages]) => {
      const nextDetail = { ...asset, translations: translations.translations, usages: usages.usages }
      const [nextRuntime, nextProposals] = await Promise.all([fetchMasterTranslationRuntime(nextDetail), fetchMasterAssetProposals(masterItemID)])
      if (cancelled) return
      setDetail(nextDetail)
      setPipeline(nextPipeline)
      setRuntime(nextRuntime)
      setProposals(nextProposals.proposals)
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
  const description = detail.summary.description || masterFieldText(item, 'character.description') || firstNestedContent(item, detail.summary.record_kind) || t('library.noDescription')
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
    } catch {
      setActionMessage(t('library.addToAdventureUnavailable'))
    } finally {
      setInstantiating(false)
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

  const polishField = async (field: MasterTranslationFieldRuntime) => {
    try {
      await startMasterAgent(masterItemID, field.field_path, 'polish')
      setActionMessage(t('library.agentProcessing'))
      window.setTimeout(() => setReloadToken((value) => value + 1), 4000)
    } catch {
      setActionMessage(t('library.agentUnavailable'))
    }
  }

  const applyProposal = async (proposal: MasterProposal, confirmed: boolean) => {
    try {
      await applyMasterProposal(proposal.proposal_id, confirmed)
      setActionMessage(confirmed ? t('library.proposalApplied') : t('library.candidateCreated'))
      setReloadToken((value) => value + 1)
    } catch {
      setActionMessage(t('library.proposalUnavailable'))
    }
  }

  const applyProposals = async (selected: MasterProposal[]) => {
    try {
      const result = await applyMasterProposals(masterItemID, selected.map((proposal) => proposal.proposal_id))
      setActionMessage(t('library.batchApplyResult', { applied: result.applied_count, total: selected.length }))
      setReloadToken((value) => value + 1)
    } catch {
      setActionMessage(t('library.proposalUnavailable'))
    }
  }

  const saveEntry = async (entry: Record<string, unknown>, values: EntryEditValues) => {
    const prefix = `${detail.summary.record_kind === 'character_template' ? 'character_book.entries' : 'lorebook.entries'}/${valueOf(entry, 'entry_id', '')}`
    const changes: Array<[string, string]> = [['comment', values.comment], ['content', values.content], ['keys', values.keys], ['secondary_keys', values.secondary_keys]]
    let changed = 0
    for (const [field, translation] of changes) {
      const current = field === 'comment' ? nestedEntryText(item, detail.summary.record_kind, entry, 'comment') : field === 'content' ? nestedEntryText(item, detail.summary.record_kind, entry, 'content') : masterFieldText(item, `${prefix}/${field}`)
      if (translation.trim() === current.trim()) continue
      if (!translation.trim()) throw new Error(t('library.editEmptyField'))
      const created = await createMasterProposal(masterItemID, { field_path: `${prefix}/${field}`, translation, kind: 'polish', apply_mode: 'confirm', reason: '用户直接编辑条目' })
      await validateMasterProposal(created.proposal.proposal_id)
      await applyMasterProposal(created.proposal.proposal_id, true)
      changed += 1
    }
    if (changed === 0) throw new Error(t('library.editNoChanges'))
    setActionMessage(t('library.entrySaved'))
    setReloadToken((value) => value + 1)
  }

  const saveCharacter = async (values: CharacterEditValues) => {
    const changes: Array<[string, string]> = Object.entries(values)
    let changed = 0
    for (const [fieldPath, translation] of changes) {
      const current = masterFieldText(item, fieldPath)
      if (translation.trim() === current.trim()) continue
      if (!translation.trim()) throw new Error(t('library.editEmptyField'))
      const created = await createMasterProposal(masterItemID, { field_path: fieldPath, translation, kind: 'polish', apply_mode: 'confirm', reason: '用户直接编辑角色卡' })
      await validateMasterProposal(created.proposal.proposal_id)
      await applyMasterProposal(created.proposal.proposal_id, true)
      changed += 1
    }
    if (changed === 0) throw new Error(t('library.editNoChanges'))
    setActionMessage(t('library.characterSaved'))
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
              <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-foreground">{description}</p>
              <p className={`mt-3 text-xs ${userState === 'needs_user' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>{statusSummary}</p>
              <p className="mt-3 text-[11px] text-muted-foreground">{t('library.sourceFile')}: {valueOf(source, 'filename', detail.summary.source_name)} · {t('library.importedAt')}: {formatDate(valueOf(sourceRevision, 'imported_at', ''))}</p>
            </div>
            <Button type="button" size="sm" disabled={!workspace || detail.summary.availability !== 'usable' || instantiating} onClick={() => void addToAdventure()}><Plus data-icon="inline-start" />{instantiating ? t('library.addingToAdventure') : t('library.addToAdventure')}</Button>
          </div>
        </div>
        {actionMessage && <div className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-2 text-xs text-foreground">{actionMessage}</div>}
        <Tabs defaultValue="content" className="gap-3">
          <TabsList variant="line" className="h-auto w-full justify-start gap-1 overflow-x-auto border-b border-[var(--nova-border)] bg-transparent p-0">
            {(['content', 'progress', 'versions', 'adventures', 'technical'] as const).map((tab) => <TabsTrigger key={tab} value={tab} className="h-10 flex-none rounded-none px-3 text-xs after:bottom-0">{t(`library.tab.${tab}`)}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="content"><AssetContent item={item} recordKind={detail.summary.record_kind} t={t} onSaveEntry={saveEntry} onSaveCharacter={saveCharacter} onOpenAgent={onOpenAgent} /></TabsContent>
          <TabsContent value="progress" className="space-y-3">
            <ProcessingSummary pipeline={pipeline} runtime={runtime} onOpenAgent={onOpenAgent} t={t} />
            <details className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)]">
              <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-foreground">{t('library.showDetailedPipeline')}</summary>
              <div className="border-t border-[var(--nova-border)] p-3"><PipelineOverview pipeline={pipeline} item={item} runtime={runtime} t={t} onRetry={retryField} onPolish={polishField} /></div>
            </details>
            <ProposalList proposals={proposals} t={t} onApply={applyProposal} onBatchApply={applyProposals} />
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

function nestedPrefix(recordKind: string) {
  return recordKind === 'character_template' ? 'character_book.entries' : 'lorebook.entries'
}

function nestedEntryText(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, field: string) {
  const path = `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${field}`
  const original = recordValue(entry.original)
  return masterFieldText(item, path) || valueOf(original, field, '') || (field === 'comment' ? valueOf(original, 'name', '') : '')
}

function nestedEntryField(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, field: string) {
  const path = `${nestedPrefix(recordKind)}/${valueOf(entry, 'entry_id', '')}/${field}`
  const active = masterFieldText(item, path)
  if (active) return active
  return sourceEntryValues(recordValue(entry.original), field).join('\n')
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

function nestedEntryTitle(item: Record<string, unknown>, recordKind: string, entry: Record<string, unknown>, index: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const comment = nestedEntryText(item, recordKind, entry, 'comment')
  const genericComment = ['comment', 'comments', '评论', 'entry', '条目'].includes(comment.trim().toLowerCase())
  return (!genericComment && comment) || nestedEntryKeywords(item, recordKind, entry)[0] || t('library.unnamedEntry', { index: index + 1 })
}

function firstNestedContent(item: Record<string, unknown>, recordKind: string) {
  const entry = nestedEntries(item)[0]
  return entry ? nestedEntryText(item, recordKind, entry, 'content') : ''
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
type CharacterEditValues = Record<'character.name' | 'character.description' | 'character.personality' | 'character.creator_notes' | 'character.scenario' | 'character.first_mes' | 'character.alternate_greetings' | 'character.mes_example', string>

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

function AssetContent({ item, recordKind, t, onSaveEntry, onSaveCharacter, onOpenAgent }: { item: Record<string, unknown>; recordKind: string; t: (key: string, options?: Record<string, unknown>) => string; onSaveEntry?: (entry: Record<string, unknown>, values: EntryEditValues) => Promise<void>; onSaveCharacter?: (values: CharacterEditValues) => Promise<void>; onOpenAgent?: (context?: Record<string, string>) => void }) {
  return recordKind === 'lorebook_template' ? <LorebookReader item={item} recordKind={recordKind} t={t} onSaveEntry={onSaveEntry} onOpenAgent={onOpenAgent} /> : <CharacterReader item={item} t={t} onSaveCharacter={onSaveCharacter} onOpenAgent={onOpenAgent} />
}

function CharacterReader({ item, t, onSaveCharacter, onOpenAgent }: { item: Record<string, unknown>; t: (key: string, options?: Record<string, unknown>) => string; onSaveCharacter?: (values: CharacterEditValues) => Promise<void>; onOpenAgent?: (context?: Record<string, string>) => void }) {
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CharacterEditValues>({ 'character.name': '', 'character.description': '', 'character.personality': '', 'character.creator_notes': '', 'character.scenario': '', 'character.first_mes': '', 'character.alternate_greetings': '', 'character.mes_example': '' })
  const groups = [
    { title: t('library.character.overview'), values: [[t('library.character.description'), masterFieldText(item, 'character.description')]] },
    { title: t('library.character.personalityBackground'), values: [[t('library.character.personality'), masterFieldText(item, 'character.personality')], [t('library.character.creatorNotes'), masterFieldText(item, 'character.creator_notes')]] },
    { title: t('library.character.sceneOpening'), values: [[t('library.character.scenario'), masterFieldText(item, 'character.scenario')], [t('library.character.firstMessage'), masterFieldText(item, 'character.first_mes')], [t('library.character.alternateGreetings'), masterFieldText(item, 'character.alternate_greetings')]] },
    { title: t('library.character.exampleDialogue'), values: [[t('library.character.exampleDialogue'), masterFieldText(item, 'character.mes_example')]] },
  ]
  const entries = nestedEntries(item)
  const advanced = [[t('library.character.systemPrompt'), masterFieldText(item, 'character.system_prompt')], [t('library.character.postHistory'), masterFieldText(item, 'character.post_history_instructions')]].filter(([, value]) => value)
  const editFields: Array<[keyof CharacterEditValues, string, boolean]> = [
    ['character.name', t('library.character.name'), false], ['character.description', t('library.character.description'), true], ['character.personality', t('library.character.personality'), true], ['character.creator_notes', t('library.character.creatorNotes'), true],
    ['character.scenario', t('library.character.scenario'), true], ['character.first_mes', t('library.character.firstMessage'), true], ['character.alternate_greetings', t('library.character.alternateGreetings'), true], ['character.mes_example', t('library.character.exampleDialogue'), true],
  ]
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
  if (editing) return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-foreground">{t('library.editCharacter')}</h2><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setPreview((value) => !value)} disabled={saving}>{t(preview ? 'library.hidePreview' : 'library.previewChanges')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving || changedCharacterFields(editFields, draft, item).length === 0}>{saving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t('library.saveCharacter')}</Button></div></div><p className="text-xs text-muted-foreground">{t('library.editCharacterHint')}</p>{editError && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{editError}</p>}{preview && <EditPreview changes={changedCharacterFields(editFields, draft, item)} t={t} />}{editFields.map(([path, label, multiline]) => <div key={path} className="block text-xs font-medium text-foreground"><div className="flex items-center justify-between gap-2"><span>{label}</span>{onOpenAgent && <Button type="button" variant="ghost" size="sm" onClick={() => onOpenAgent({ field_path: path, field_label: label })}>{t('library.askAgentField')}</Button>}</div>{multiline ? <textarea aria-label={label} className="mt-1 min-h-28 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft[path]} onChange={(event) => setDraft((current) => ({ ...current, [path]: event.target.value }))} /> : <Input aria-label={label} className="mt-1" value={draft[path]} onChange={(event) => setDraft((current) => ({ ...current, [path]: event.target.value }))} />}</div>)}</div>
  return <div className="space-y-3">{onSaveCharacter && <div className="flex justify-end"><Button type="button" variant="outline" size="sm" onClick={beginEdit}><Pencil data-icon="inline-start" />{t('library.editCharacter')}</Button></div>}{groups.map((group) => <ReadingSection key={group.title} title={group.title} values={group.values} />)}{entries.length > 0 && <InfoSection title={t('library.character.internalSettings')}><div className="space-y-2">{entries.map((entry, index) => <details key={valueOf(entry, 'entry_id', String(index))} className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)]"><summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">{nestedEntryTitle(item, 'character_template', entry, index, t)}</summary><p className="whitespace-pre-wrap border-t border-[var(--nova-border)] px-3 py-3 text-sm leading-6 text-foreground">{nestedEntryText(item, 'character_template', entry, 'content') || t('library.noContent')}</p></details>)}</div></InfoSection>}{advanced.length > 0 && <InfoSection title={t('library.character.advancedInstructions')}><div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('library.character.advancedHint')}</div><ReadingValues values={advanced} /></InfoSection>}</div>
}

function ReadingSection({ title, values }: { title: string; values: string[][] }) {
  const visible = values.filter(([, value]) => value)
  if (visible.length === 0) return null
  return <InfoSection title={title}><ReadingValues values={visible} /></InfoSection>
}

function ReadingValues({ values }: { values: string[][] }) {
  return <div className="space-y-4">{values.map(([label, value]) => <div key={label}><h3 className="text-[11px] font-medium text-muted-foreground">{label}</h3><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground">{value}</p></div>)}</div>
}

function LorebookReader({ item, recordKind, t, onSaveEntry, onOpenAgent }: { item: Record<string, unknown>; recordKind: string; t: (key: string, options?: Record<string, unknown>) => string; onSaveEntry?: (entry: Record<string, unknown>, values: EntryEditValues) => Promise<void>; onOpenAgent?: (context?: Record<string, string>) => void }) {
  const entries = nestedEntries(item)
  const [query, setQuery] = useState('')
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [selectedID, setSelectedID] = useState(valueOf(entries[0], 'entry_id', ''))
  const [editing, setEditing] = useState(false)
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
  const save = async () => {
    if (!active || !onSaveEntry) return
    setSaving(true)
    setEditError(null)
    try { await onSaveEntry(active, draft); setEditing(false) } catch (reason: unknown) { setEditError(reason instanceof Error ? reason.message : t('library.editSaveFailed')) } finally { setSaving(false) }
  }
  if (entries.length === 0) return <InfoSection title={t('library.fullContent')}><p className="text-sm text-muted-foreground">{t('library.noEntries')}</p></InfoSection>
  return <div className="overflow-hidden rounded-xl border border-[var(--nova-border)] bg-[var(--nova-surface)]">
    <div className="flex items-center justify-between border-b border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3 lg:hidden"><span className="text-xs font-medium text-foreground">{t('library.entryDirectory')}</span><Button type="button" variant="outline" size="sm" onClick={() => setDirectoryOpen(true)}><Menu data-icon="inline-start" />{t('library.openEntryDirectory')}</Button></div>
    <div className="relative grid min-h-[34rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
    <aside className={`${directoryOpen ? 'fixed inset-y-0 left-0 z-50 block w-[min(86vw,20rem)] shadow-2xl' : 'hidden'} border-b border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3 lg:static lg:block lg:border-b-0 lg:border-r lg:shadow-none`}>
      <div className="mb-3 flex items-center justify-between lg:hidden"><span className="text-xs font-semibold text-foreground">{t('library.entryDirectory')}</span><Button type="button" variant="ghost" size="icon-xs" onClick={() => setDirectoryOpen(false)} aria-label={t('library.closeEntryDirectory')}><X /></Button></div>
      <label className="relative block"><span className="sr-only">{t('library.searchEntries')}</span><Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('library.searchEntries')} className="bg-[var(--nova-surface)] pl-8" /></label>
      <div className="mt-3 max-h-72 space-y-1 overflow-auto lg:max-h-[30rem]">{filtered.length === 0 ? <p className="px-2 py-4 text-xs text-muted-foreground">{t('library.noMatchingEntries')}</p> : filtered.map((entry) => { const id = valueOf(entry, 'entry_id', ''); return <button key={id} type="button" onClick={() => { setSelectedID(id); setDirectoryOpen(false) }} aria-current={active === entry ? 'true' : undefined} className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${active === entry ? 'bg-[var(--nova-active)] font-medium text-foreground' : 'text-[var(--nova-text-muted)] hover:bg-[var(--nova-hover)] hover:text-foreground'}`}><span className="block truncate">{nestedEntryTitle(item, recordKind, entry, entries.indexOf(entry), t)}</span><span className="mt-0.5 block truncate text-[10px] opacity-70">{nestedEntryKeywords(item, recordKind, entry).slice(0, 3).join(' · ')}</span></button> })}</div>
    </aside>
    <article className="min-w-0 p-4 md:p-6">{active ? <>{!editing ? <><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-lg font-semibold text-foreground">{nestedEntryTitle(item, recordKind, active, entries.indexOf(active), t)}</h2><div className="flex flex-wrap gap-2">{onOpenAgent && <Button type="button" variant="outline" size="sm" onClick={() => onOpenAgent({ field_path: `${nestedPrefix(recordKind)}/${valueOf(active, 'entry_id', '')}/content`, field_label: t('library.content') })}><Bot data-icon="inline-start" />{t('library.askAgentField')}</Button>}{onSaveEntry && <Button type="button" variant="outline" size="sm" onClick={beginEdit}><Pencil data-icon="inline-start" />{t('library.editEntry')}</Button>}</div></div><p className="mt-5 whitespace-pre-wrap text-sm leading-7 text-foreground">{nestedEntryText(item, recordKind, active, 'content') || t('library.noContent')}</p>{nestedEntryKeywords(item, recordKind, active).length > 0 && <div className="mt-6 border-t border-[var(--nova-border)] pt-4"><h3 className="text-[11px] font-medium text-muted-foreground">{t('library.keywords')}</h3><div className="mt-2 flex flex-wrap gap-1.5">{nestedEntryKeywords(item, recordKind, active).map((keyword) => <span key={keyword} className="rounded-full border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2 py-1 text-[11px] text-foreground">{keyword}</span>)}</div></div>}</> : <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-foreground">{t('library.editEntry')}</h2><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setPreview((value) => !value)} disabled={saving}>{t(preview ? 'library.hidePreview' : 'library.previewChanges')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>{t('library.cancelEdit')}</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving || changedEntryFields(item, recordKind, active, draft, t).length === 0}>{saving ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}{t('library.saveEntry')}</Button></div></div><p className="text-xs text-muted-foreground">{t('library.editEntryHint')}</p>{editError && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{editError}</p>}{preview && <EditPreview changes={changedEntryFields(item, recordKind, active, draft, t)} t={t} />}{<label className="block text-xs font-medium text-foreground">{t('library.entryTitle')}<Input className="mt-1" value={draft.comment} onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))} /></label>}<label className="block text-xs font-medium text-foreground">{t('library.content')}<textarea className="mt-1 min-h-48 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} /></label><div className="grid gap-3 md:grid-cols-2"><label className="block text-xs font-medium text-foreground">{t('library.keywords')}<textarea className="mt-1 min-h-24 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.keys} onChange={(event) => setDraft((current) => ({ ...current, keys: event.target.value }))} /></label><label className="block text-xs font-medium text-foreground">{t('library.secondaryKeywords')}<textarea className="mt-1 min-h-24 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={draft.secondary_keys} onChange={(event) => setDraft((current) => ({ ...current, secondary_keys: event.target.value }))} /></label></div></div>}</> : <p className="text-sm text-muted-foreground">{t('library.noMatchingEntries')}</p>}</article>
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

function PipelineOverview({ pipeline, item, runtime, t, onRetry, onPolish }: { pipeline: MasterPipelineStatus; item: Record<string, unknown>; runtime: MasterTranslationRuntime; t: (key: string, options?: Record<string, unknown>) => string; onRetry: (field: MasterTranslationFieldRuntime) => Promise<void>; onPolish: (field: MasterTranslationFieldRuntime) => Promise<void> }) {
  const [selectedNode, setSelectedNode] = useState<LibraryNodeKey>('translation')
  const node = nodeFor(pipeline, selectedNode)
  return <InfoSection title={t('library.pipeline')}><p className="mb-3 text-[11px] text-muted-foreground">{t('library.pipelineReadOnly')}</p><div className="grid gap-2 md:grid-cols-7">{NODE_KEYS.map((key) => { const nextNode = nodeFor(pipeline, key); return <button key={key} type="button" onClick={() => setSelectedNode(key)} className={`rounded-lg border p-2 text-left transition-colors hover:brightness-95 ${statusClass(nextNode.status)} ${selectedNode === key ? 'ring-2 ring-primary/30' : ''}`} title={nextNode.reason ? t('library.nodeReason', { reason: nextNode.reason }) : undefined}><div className="flex items-center gap-1.5"><StatusIcon status={nextNode.status} /><span className="text-xs font-medium">{nodeLabel(key, t)}</span></div><div className="mt-1 text-[10px] opacity-80">{key === 'translation' ? translationSummaryLabel(runtime, pipeline.translation.total_fields, t) : statusLabel(nextNode.status, t)}</div>{nextNode.inferred && <div className="mt-1 text-[10px] opacity-70">{t('library.inferred')}</div>}</button> })}</div><div className="mt-4 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3"><div className="flex items-center gap-2 text-xs font-medium text-foreground"><span>{nodeLabel(selectedNode, t)}</span><span className="text-[11px] font-normal text-muted-foreground">{statusLabel(node.status, t)}</span></div><div className="mt-3">{selectedNode === 'translation' ? <TranslationFieldList runtime={runtime} t={t} onRetry={onRetry} onPolish={onPolish} /> : selectedNode === 'check' ? <IssueList pipeline={pipeline} t={t} /> : <NodeEvidence node={node} item={item} nodeKey={selectedNode} t={t} />}</div></div></InfoSection>
}

function NodeEvidence({ node, item, nodeKey, t }: { node: MasterPipelineNode; item: Record<string, unknown>; nodeKey: LibraryNodeKey; t: (key: string, options?: Record<string, unknown>) => string }) {
  const original = item.original && typeof item.original === 'object' && !Array.isArray(item.original) ? Object.keys(item.original) : []
  const fields = item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields) ? Object.keys(item.fields) : []
  const names = nodeKey === 'parse' ? original : fields
  return <div className="space-y-2 text-xs"><div className="text-muted-foreground">{node.reason || t('library.inferred')}</div><div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface)] p-2"><div className="text-[11px] text-muted-foreground">{nodeKey === 'parse' ? t('library.recognizedFields') : t('library.normalizedFields')}</div><div className="mt-1 break-words text-foreground">{names.length ? names.join(', ') : t('library.noFieldEvidence')}</div></div>{node.input_revision && <div className="font-mono text-[10px] text-muted-foreground">{t('library.inputRevision')}: {node.input_revision}</div>}{node.output_revision && <div className="font-mono text-[10px] text-muted-foreground">{t('library.outputRevision')}: {node.output_revision}</div>}</div>
}

function TranslationFieldList({ runtime, t, onRetry, onPolish }: { runtime: MasterTranslationRuntime; t: (key: string, options?: Record<string, unknown>) => string; onRetry: (field: MasterTranslationFieldRuntime) => Promise<void>; onPolish: (field: MasterTranslationFieldRuntime) => Promise<void> }) {
  if (runtime.fields.length === 0) return <p className="text-xs text-muted-foreground">{t('library.noFieldEvidence')}</p>
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-medium text-foreground">{translationSummaryLabel(runtime, runtime.total_fields, t)}</span><span className="text-[11px] text-muted-foreground">{runtime.runtime_available ? t('library.runtimeAggregated') : t('library.translationUnavailable')}</span></div>{runtime.fields.map((field) => <TranslationFieldRow key={field.field_path} field={field} t={t} onRetry={onRetry} onPolish={onPolish} />)}</div>
}

function TranslationFieldRow({ field, t, onRetry, onPolish }: { field: MasterTranslationFieldRuntime; t: (key: string, options?: Record<string, unknown>) => string; onRetry: (field: MasterTranslationFieldRuntime) => Promise<void>; onPolish: (field: MasterTranslationFieldRuntime) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const needsRetry = field.task_status === 'failed' && Boolean(field.task_id)
  const recoveryProcessing = ['eligible', 'agent_running', 'proposal_ready', 'applying', 'revalidating'].includes(field.recovery_status || '')
  const userStatus = recoveryProcessing ? t('library.agentProcessing') : field.recovery_status === 'recovered' ? t('library.fieldCompleted') : field.recovery_status === 'needs_user' ? t('library.fieldNeedsConfirmation') : field.review_required ? t('library.fieldNeedsConfirmation') : field.task_status === 'failed' ? t('library.fieldNeedsAttention') : field.task_status === 'completed' && field.content_version_status !== 'original' ? t('library.fieldCompleted') : field.task_status === 'running' || field.task_status === 'queued' || field.task_status === 'paused' ? t('library.fieldProcessing') : t('library.fieldNotCompleted')
  return <div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface)] p-2.5"><div className="flex items-center gap-2"><button type="button" onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${field.review_required || field.task_status === 'failed' ? 'border-amber-500/40 bg-amber-500/10 text-amber-600' : field.task_status === 'completed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'border-blue-500/40 bg-blue-500/10 text-blue-600'}`}>{field.task_status === 'completed' && !field.review_required ? <Check className="size-3" /> : field.task_status === 'failed' ? <XCircle className="size-3" /> : field.task_status === 'running' ? <Loader2 className="size-3 animate-spin" /> : <Circle className="size-2.5" />}</span><span className="min-w-0 truncate font-mono text-[11px] text-foreground">{field.field_path}</span><span className="truncate text-[11px] text-muted-foreground">{userStatus}</span><ChevronDown className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} /></button><Button type="button" variant="ghost" size="sm" onClick={() => void onPolish(field)}>{t('library.polish')}</Button>{needsRetry && <Button type="button" variant="outline" size="icon-xs" disabled={retrying} onClick={async () => { setRetrying(true); try { await onRetry(field) } finally { setRetrying(false) } }} title={t('library.retry')} aria-label={t('library.retry')}>{retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}</Button>}</div>{field.task_status === 'failed' && <div className="mt-1 pl-7 text-[11px] text-amber-700 dark:text-amber-300">{t('library.fieldNotCompleted')}</div>}{open && <div className="mt-2 grid gap-1 border-t border-[var(--nova-border)] pt-2 text-[11px] text-muted-foreground sm:grid-cols-2"><span>{t('library.taskStatus')}: {enumLabel('status', field.task_status, t)}</span><span>{t('library.contentVersion')}: {enumLabel('contentKind', field.content_version_status, t)}</span><span>{t('library.translationVersion')}: {field.translation_version || t('library.unknown')}</span><span>{t('library.inputRevision')}: {field.input_revision || t('library.unknown')}</span>{field.failure_reason && <span className="sm:col-span-2">{t('library.failureReason')}: {field.failure_reason}</span>}</div>}</div>
}

function ProposalList({ proposals, t, onApply, onBatchApply }: { proposals: MasterProposal[]; t: (key: string, options?: Record<string, unknown>) => string; onApply: (proposal: MasterProposal, confirmed: boolean) => Promise<void>; onBatchApply: (proposals: MasterProposal[]) => Promise<void> }) {
  const batchable = proposals.filter((proposal) => proposal.risk !== 'high' && (proposal.status === 'candidate_ready' || (proposal.status === 'validated' && proposal.apply_mode === 'confirm')))
  const [selected, setSelected] = useState<string[]>(batchable.map((proposal) => proposal.proposal_id))
  if (proposals.length === 0) return null
  const selectedProposals = batchable.filter((proposal) => selected.includes(proposal.proposal_id))
  return <InfoSection title={t('library.proposals')}><div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-3"><div><div className="text-xs font-medium text-foreground">{t('library.batchApplyTitle')}</div><div className="mt-1 text-[11px] text-muted-foreground">{t('library.batchApplyHint')}</div></div><Button type="button" size="sm" disabled={selectedProposals.length === 0} onClick={() => void onBatchApply(selectedProposals)}>{t('library.batchApply', { count: selectedProposals.length })}</Button></div><div className="space-y-2">{proposals.map((proposal) => { const canApply = proposal.status === 'candidate_ready' || (proposal.status === 'validated' && proposal.apply_mode === 'confirm'); const canBatch = canApply && proposal.risk !== 'high'; const before = proposal.current_translation || proposal.original; return <div key={proposal.proposal_id} className="rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3 text-xs"><div className="flex flex-wrap items-center gap-2">{canBatch && <input type="checkbox" aria-label={t('library.selectProposal')} checked={selected.includes(proposal.proposal_id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, proposal.proposal_id] : ids.filter((id) => id !== proposal.proposal_id))} />}<span className="font-medium text-foreground">{proposal.kind === 'polish' ? t('library.polishCandidate') : t('library.recoveryProposal')}</span><span className="text-[11px] text-muted-foreground">{proposal.field_path}</span>{proposal.risk === 'high' && <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-600">{t('library.highRisk')}</span>}</div><div className="mt-3 grid gap-2 lg:grid-cols-2"><div className="rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2"><div className="mb-1 text-[10px] text-muted-foreground">{t('library.beforeChange')}</div><p className="whitespace-pre-wrap text-foreground">{before}</p></div><div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2"><div className="mb-1 text-[10px] text-emerald-700 dark:text-emerald-300">{t('library.afterChange')}</div><p className="whitespace-pre-wrap text-foreground">{proposal.patch.translation}</p></div></div>{proposal.reason && <p className="mt-2 text-[11px] text-muted-foreground">{proposal.reason}</p>}{canApply && <Button type="button" size="sm" className="mt-2" onClick={() => { if (proposal.risk === 'high' && !window.confirm(t('library.highRiskConfirm'))) return; void onApply(proposal, true) }}>{t('library.applyChange')}</Button>}</div> })}</div></InfoSection>
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
