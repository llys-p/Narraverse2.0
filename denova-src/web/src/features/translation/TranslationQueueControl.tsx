import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Languages, Loader2, Pause, Play, RefreshCw, RotateCcw, Trash2, X, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  cancelTranslationJob,
  applyMasterTranslation,
  deleteTranslationJob,
  getLoreItems,
  getTranslationJob,
  getTranslationQueue,
  resolveTranslationJob,
  retryTranslationJob,
  setTranslationQueuePaused,
  updateLoreItem,
  type LoreTranslationField,
  type TranslationJob,
  type TranslationQueueStatus,
} from '@/lib/api'
import { useWorkspaceStore, type WorkspaceMode } from '@/stores/workspace-store'

const POLL_MS = 1200
const VISIBLE_JOB_LIMIT = 100

export function visibleTranslationJobs(jobs: TranslationJob[]): TranslationJob[] {
  return jobs.filter((job) => job.status !== 'applied' && job.status !== 'deleted').slice(-VISIBLE_JOB_LIMIT).reverse()
}

function isMasterJob(job: TranslationJob): boolean {
  return job.apply_policy === 'master_auto' || job.apply_policy === 'master_review'
}

function translationFieldLabel(t: TFunction, field: string): string {
  return field === 'name' || field === 'brief_description' || field === 'content'
    ? t(`settingPanel.translationQueue.field.${field}`)
    : field
}

export function TranslationQueueControl({ workspace, mode }: { workspace: string; mode: WorkspaceMode }) {
  const { t } = useTranslation()
  const setMode = useWorkspaceStore((state) => state.setMode)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<TranslationQueueStatus | null>(null)
  const [error, setError] = useState('')
  const [bulkApply, setBulkApply] = useState({ running: false, done: 0, total: 0 })
  const [editJob, setEditJob] = useState<TranslationJob | null>(null)
  const [editText, setEditText] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const applyingRef = useRef(new Set<string>())
  // 清空失败任务：串行删除，逐项容错，避免一个失败就中断。
  const [clearFailedState, setClearFailedState] = useState({ running: false, done: 0, total: 0, success: 0, failed: 0 })

  const refresh = useCallback(async () => {
    try {
      const next = await getTranslationQueue(workspace)
      setStatus(next)
      setError('')
      return next
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settingPanel.translationQueue.offline'))
      return null
    }
  }, [t, workspace])

  const applyJob = useCallback(async (summary: TranslationJob, automatic: boolean, refreshAfter = true) => {
    if (applyingRef.current.has(summary.id)) return false
    if (automatic && summary.status !== 'completed') return false
    applyingRef.current.add(summary.id)
    try {
      const job = await getTranslationJob(summary.id)
      if (!job.translation || !job.source_text) throw new Error(t('settingPanel.translationQueue.missingResult'))
      if (isMasterJob(job)) {
        if (!job.import_id || !job.master_item_id) throw new Error(t('settingPanel.translationQueue.masterIdentityMissing'))
        const applied = await applyMasterTranslation({
          import_id: job.import_id,
          master_item_id: job.master_item_id,
          field_path: job.field,
          source_sha256: job.source_sha256,
          translation: job.translation,
          model: job.model,
          job_id: job.id,
          confirmed: !automatic,
        })
        await resolveTranslationJob(job.id, 'applied')
        const itemIDs = applied.import?.item_ids || []
        if (itemIDs.length > 0) window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { item_ids: itemIDs } }))
        return true
      }
      const items = await getLoreItems()
      const item = items.find((candidate) => candidate.id === job.item_id)
      if (!item) throw new Error(t('settingPanel.translationQueue.itemMissing'))
      const field = job.field as LoreTranslationField
      if (String(item[field] || '') !== job.source_text) throw new Error(t('settingPanel.translationQueue.sourceChanged'))
      const { created_at: _createdAt, updated_at: _updatedAt, provenance: _provenance, ...input } = item
      await updateLoreItem(item.id, { ...input, [field]: job.translation }, item.updated_at)
      await resolveTranslationJob(job.id, 'applied')
      window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { item_ids: [item.id] } }))
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('settingPanel.translationQueue.applyFailed')
      await resolveTranslationJob(summary.id, 'conflict', message).catch(() => undefined)
      if (!automatic) setError(message)
      return false
    } finally {
      applyingRef.current.delete(summary.id)
      if (refreshAfter) void refresh()
    }
  }, [refresh, t])

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const poll = async () => {
      const next = await refresh()
      if (!cancelled && next) {
        for (const job of next.jobs) {
          if (job.status === 'completed' && (job.apply_policy === 'auto_apply_metadata' || job.apply_policy === 'master_auto')) void applyJob(job, true)
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [applyJob, refresh])

  useEffect(() => {
    void setTranslationQueuePaused(mode === 'interactive', 'game').then(setStatus).catch(() => undefined)
  }, [mode])

  const jobs = status?.jobs || []
  const visibleJobs = visibleTranslationJobs(jobs)
  const hiddenActionable = jobs.filter((job) => job.status !== 'applied').length - visibleJobs.length
  const active = jobs.find((job) => job.id === status?.active_id)
  const pending = (status?.counts.queued || 0) + (status?.counts.running || 0)
  const review = status?.counts.pending_review || 0
  const inlineReviewJobs = jobs.filter((job) => job.status === 'pending_review' && !isMasterJob(job))
  const failed = (status?.counts.failed || 0) + (status?.counts.conflict || 0)
  const manualPaused = status?.pause_reasons.includes('manual') || false
  const gameDraining = mode === 'interactive' && Boolean(status?.active_id)

  const openEditor = async (summary: TranslationJob) => {
    setEditLoading(true)
    try {
      const job = await getTranslationJob(summary.id)
      setEditJob(job)
      setEditText(job.translation || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settingPanel.translationQueue.editFailed'))
    } finally { setEditLoading(false) }
  }

  const saveEdited = async () => {
    if (!editJob || !editText.trim()) return
    setEditLoading(true)
    try {
      if (isMasterJob(editJob)) {
        if (!editJob.import_id || !editJob.master_item_id) throw new Error(t('settingPanel.translationQueue.masterIdentityMissing'))
        const applied = await applyMasterTranslation({
          import_id: editJob.import_id,
          master_item_id: editJob.master_item_id,
          field_path: editJob.field,
          source_sha256: editJob.source_sha256,
          translation: editText.trim(),
          model: editJob.model,
          job_id: editJob.id,
          confirmed: true,
        })
        await resolveTranslationJob(editJob.id, 'applied')
        const itemIDs = applied.import?.item_ids || []
        if (itemIDs.length > 0) window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { item_ids: itemIDs } }))
        setEditJob(null)
        await refresh()
        return
      }
      const items = await getLoreItems()
      const item = items.find((candidate) => candidate.id === editJob.item_id)
      if (!item) throw new Error(t('settingPanel.translationQueue.itemMissing'))
      const { created_at: _createdAt, updated_at: _updatedAt, provenance: _provenance, ...input } = item
      await updateLoreItem(item.id, { ...input, [editJob.field as LoreTranslationField]: editText }, item.updated_at)
      await resolveTranslationJob(editJob.id, 'applied')
      window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { item_ids: [item.id] } }))
      setEditJob(null)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settingPanel.translationQueue.editFailed'))
    } finally { setEditLoading(false) }
  }

  const applyAllReview = async () => {
    const reviewJobs = inlineReviewJobs
    if (reviewJobs.length === 0 || bulkApply.running) return
    setError('')
    setBulkApply({ running: true, done: 0, total: reviewJobs.length })
    for (let index = 0; index < reviewJobs.length; index += 1) {
      await applyJob(reviewJobs[index], false, false)
      setBulkApply({ running: true, done: index + 1, total: reviewJobs.length })
    }
    await refresh()
    setBulkApply({ running: false, done: reviewJobs.length, total: reviewJobs.length })
  }

  const clearFailedJobs = async () => {
    // 仅清理失败/冲突/取消态：进行中和待确认任务一律保留，交由主流程处理。
    const targets = jobs.filter((job) => job.status === 'failed' || job.status === 'conflict' || job.status === 'cancelled')
    if (targets.length === 0 || clearFailedState.running) return
    setError('')
    const progress = { running: true, done: 0, total: targets.length, success: 0, failed: 0 }
    setClearFailedState({ ...progress })
    for (let index = 0; index < targets.length; index += 1) {
      try {
        await deleteTranslationJob(targets[index].id)
        progress.success += 1
      } catch (reason) {
        progress.failed += 1
        // 不中断：记录最近一条错误，其余继续清理。
        if (reason instanceof Error) setError(reason.message)
      }
      progress.done = index + 1
      setClearFailedState({ ...progress })
    }
    progress.running = false
    setClearFailedState({ ...progress })
    await refresh()
  }
  const label = error
    ? t('settingPanel.translationQueue.offlineShort')
    : status?.pause_reasons.includes('game')
      ? t('settingPanel.translationQueue.gamePaused')
      : pending > 0
        ? t('settingPanel.translationQueue.progress', { count: pending })
        : review > 0
          ? t('settingPanel.translationQueue.reviewCount', { count: review })
          : t('settingPanel.translationQueue.idle')

  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" onClick={() => setOpen(true)} title={label}>
        {active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
        <span className="max-w-28 truncate">{label}</span>
        {failed > 0 && <span className="text-[var(--nova-danger)]">{failed}</span>}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(calc(100vw-2rem),760px)] border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
          <DialogHeader>
            <DialogTitle>{t('settingPanel.translationQueue.title')}</DialogTitle>
            <DialogDescription>{t('settingPanel.translationQueue.description')}</DialogDescription>
          </DialogHeader>
          {error && <div className="rounded-md border border-[var(--nova-danger-border)] bg-[var(--nova-danger-bg)] px-3 py-2 text-xs text-[var(--nova-danger)]">{error}</div>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--nova-text-faint)]">
            <span>{t('settingPanel.translationQueue.waiting', { count: pending })}</span>
            <span>{t('settingPanel.translationQueue.reviewCount', { count: review })}</span>
            <span>{t('settingPanel.translationQueue.failedCount', { count: failed })}</span>
            <Button variant="outline" size="xs" onClick={() => void refresh()} title={t('settingPanel.translationQueue.refresh')}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('settingPanel.translationQueue.refresh')}
            </Button>
            <Button variant="outline" size="xs" onClick={() => void setTranslationQueuePaused(!manualPaused, 'manual').then(setStatus)}>
              {manualPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {manualPaused ? t('settingPanel.translationQueue.resume') : t('settingPanel.translationQueue.pause')}
            </Button>
            {failed > 0 && (
              <Button variant="outline" size="xs" disabled={clearFailedState.running} data-testid="translation-clear-failed" onClick={() => void clearFailedJobs()}>
                {clearFailedState.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {clearFailedState.running
                  ? t('settingPanel.translationQueue.clearingFailed', { done: clearFailedState.done, total: clearFailedState.total, success: clearFailedState.success, failed: clearFailedState.failed })
                  : t('settingPanel.translationQueue.clearFailed')}
              </Button>
            )}
            {inlineReviewJobs.length > 0 && (
              <Button size="xs" disabled={bulkApply.running} data-testid="translation-adopt-all" onClick={() => void applyAllReview()}>
                {bulkApply.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {bulkApply.running
                  ? t('settingPanel.translationQueue.adoptingAll', { done: bulkApply.done, total: bulkApply.total })
                  : t('settingPanel.translationQueue.adoptAll', { count: inlineReviewJobs.length })}
              </Button>
            )}
          </div>
          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="grid gap-2">
              {visibleJobs.length === 0 && <div className="py-10 text-center text-xs text-[var(--nova-text-faint)]">{t('settingPanel.translationQueue.empty')}</div>}
              {hiddenActionable > 0 && <div className="text-center text-[11px] text-[var(--nova-text-faint)]">{t('settingPanel.translationQueue.hiddenCount', { count: hiddenActionable })}</div>}
              {visibleJobs.map((job) => (
                <TranslationJobRow
                  key={job.id}
                  job={job}
                  masterJob={isMasterJob(job)}
                  onApply={() => void applyJob(job, false)}
                  onCancel={() => void cancelTranslationJob(job.id).then(() => refresh())}
                  onRetry={() => void retryTranslationJob(job.id).then(() => refresh())}
                  onDelete={() => void deleteTranslationJob(job.id).then(() => refresh()).catch((reason) => setError(reason instanceof Error ? reason.message : t('settingPanel.translationQueue.deleteFailed')))}
                  onEdit={() => void openEditor(job)}
                  onOpenLibrary={() => { setOpen(false); setMode('library') }}
                />
              ))}
            </div>
          </ScrollArea>
          <DialogFooter><Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('common.close')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editJob)} onOpenChange={(next) => { if (!next && !editLoading) setEditJob(null) }}>
        <DialogContent className="max-w-[min(calc(100vw-2rem),1000px)] border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
          <DialogHeader><DialogTitle>{editJob ? `${editJob.item_name} · ${translationFieldLabel(t, editJob.field)}` : ''}</DialogTitle><DialogDescription>{t('settingPanel.translationQueue.compareDescription')}</DialogDescription></DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-1"><div className="text-xs font-medium">{t('settingPanel.translationQueue.sourceLabel')}</div><textarea readOnly value={editJob?.source_text || ''} className="min-h-64 w-full resize-y rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2 text-xs leading-5" /></div>
            <div className="grid gap-1"><div className="text-xs font-medium">{t('settingPanel.translationQueue.translationLabel')}</div><textarea value={editText} onChange={(event) => setEditText(event.target.value)} className="min-h-64 w-full resize-y rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2 text-xs leading-5" disabled={editLoading} /></div>
          </div>
          <DialogFooter><Button variant="outline" size="sm" onClick={() => setEditJob(null)} disabled={editLoading}>{t('common.cancel')}</Button><Button size="sm" onClick={() => void saveEdited()} disabled={editLoading || !editText.trim()}>{editLoading ? <Loader2 className="animate-spin" /> : <Check />}{t('settingPanel.translationQueue.adopt')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {gameDraining && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface)] px-5 py-4 text-sm text-[var(--nova-text)] shadow-xl">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t('settingPanel.translationQueue.stoppingForGame')}
          </div>
        </div>
      )}
    </>
  )
}

function TranslationJobRow({ job, masterJob, onApply, onCancel, onRetry, onDelete, onEdit, onOpenLibrary }: {
  job: TranslationJob
  masterJob: boolean
  onApply: () => void
  onCancel: () => void
  onRetry: () => void
  onDelete: () => void
  onEdit: () => void
  onOpenLibrary: () => void
}) {
  const { t } = useTranslation()
  const icon = job.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" />
    : job.status === 'applied' ? <Check className="h-4 w-4 text-[var(--nova-success)]" />
      : job.status === 'failed' || job.status === 'conflict' ? <AlertTriangle className="h-4 w-4 text-[var(--nova-danger)]" />
        : <Languages className="h-4 w-4" />
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-2 text-xs">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[var(--nova-text)]">{job.item_name || job.item_id} · {translationFieldLabel(t, job.field)}</div>
        <div className="truncate text-[11px] text-[var(--nova-text-faint)]">{t(`settingPanel.translationQueue.status.${job.status}`)}{job.error ? ` · ${job.error}` : ''}</div>
      </div>
      {/* 总库翻译任务的内容审核集中在「叙界总资料库 → Denova 处理结果」，
          本地队列不再提供逐条应用/编辑入口，避免与总库 Proposal 流程冲突。 */}
      {masterJob && (job.status === 'pending_review' || job.status === 'failed' || job.status === 'conflict') && (
        <Button variant="outline" size="xs" onClick={onOpenLibrary}>{t('settingPanel.translationQueue.masterJobHint')}</Button>
      )}
      {!masterJob && job.status === 'pending_review' && <Button size="xs" onClick={onApply}>{t('settingPanel.translationQueue.adopt')}</Button>}
      {!masterJob && (job.status === 'failed' || job.status === 'conflict' || job.status === 'pending_review') && (
        <Button variant="outline" size="xs" onClick={onEdit} title={t('settingPanel.translationQueue.edit')}>
          <Pencil className="h-3.5 w-3.5" />
          {t('settingPanel.translationQueue.edit')}
        </Button>
      )}
      {(job.status === 'failed' || job.status === 'conflict' || job.status === 'cancelled') && <Button variant="outline" size="icon-xs" onClick={onRetry} title={t('settingPanel.translationQueue.retry')}><RotateCcw /></Button>}
      {(job.status === 'queued' || job.status === 'running') && <Button variant="outline" size="icon-xs" onClick={onCancel} title={t('settingPanel.translationQueue.cancel')}><X /></Button>}
      {job.status !== 'running' && job.status !== 'applied' && <Button variant="outline" size="icon-xs" onClick={onDelete} title={t('settingPanel.translationQueue.delete')}><Trash2 /></Button>}
    </div>
  )
}
