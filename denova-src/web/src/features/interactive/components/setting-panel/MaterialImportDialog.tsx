import { useEffect, useMemo, useRef, useState } from 'react'
import { Database, FileUp, Loader2, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  createTranslationJobs,
  enqueueMasterTranslationTargets,
  fetchNarraverseMaterial,
  getLoreItems,
  importMaterial,
  instantiateMasterAsset,
  listMasterAssets,
  listNarraverseMaterials,
  previewMaterial,
  type MaterialImportResult,
  type MaterialPreview,
  type NarraverseMaterialRef,
  type MasterAssetSummary,
  type TranslationJobInput,
} from '@/lib/api'

interface PreparedMaterial {
  key: string
  file: File
  source?: NarraverseMaterialRef
  preview?: MaterialPreview
  error?: string
  result?: MaterialImportResult
  acceptIncomplete: boolean
}

export function MaterialImportDialog({ open, onOpenChange, workspace, onImported }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: string
  onImported: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [catalog, setCatalog] = useState<NarraverseMaterialRef[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [showAdult, setShowAdult] = useState(false)
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [prepared, setPrepared] = useState<PreparedMaterial[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [directImport, setDirectImport] = useState(false)
  const [catalogMode, setCatalogMode] = useState<'source' | 'master'>('source')
  const [masterAssets, setMasterAssets] = useState<MasterAssetSummary[]>([])
  const [selectedMasterAssets, setSelectedMasterAssets] = useState<string[]>([])
  const [addingMasterAssets, setAddingMasterAssets] = useState(false)

  useEffect(() => {
    if (!open) return
    setCatalogError('')
    void listNarraverseMaterials().then(setCatalog).catch((reason) => setCatalogError(reason instanceof Error ? reason.message : String(reason)))
    void listMasterAssets({ limit: 200 }).then((result) => setMasterAssets(result.assets)).catch((reason) => setCatalogError(reason instanceof Error ? reason.message : String(reason)))
  }, [open])

  const visibleCatalog = useMemo(() => catalog.filter((item) => {
    if (!showAdult && /(?:nsfw|hentai|成人|色情)/i.test(item.relative_path)) return false
    const needle = query.trim().toLowerCase()
    return !needle || item.relative_path.toLowerCase().includes(needle)
  }), [catalog, query, showAdult])

  const visibleMasterAssets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return masterAssets.filter((item) => !needle || `${item.name} ${item.source_name} ${item.semantic_type}`.toLowerCase().includes(needle))
  }, [masterAssets, query])

  const prepareFiles = async (inputs: Array<{ file: File; source?: NarraverseMaterialRef }>) => {
    setLoading(true)
    try {
      const next = await Promise.all(inputs.map(async ({ file, source }) => {
        const key = source?.source_id || `${file.name}:${file.size}:${file.lastModified}`
        try {
          return { key, file, source, preview: await previewMaterial(file), acceptIncomplete: false } satisfies PreparedMaterial
        } catch (reason) {
          return { key, file, source, error: reason instanceof Error ? reason.message : String(reason), acceptIncomplete: false } satisfies PreparedMaterial
        }
      }))
      setPrepared((current) => [...current.filter((item) => !next.some((candidate) => candidate.key === item.key)), ...next])
    } finally {
      setLoading(false)
    }
  }

  const addKnowledgeSelection = async () => {
    const references = catalog.filter((item) => selectedSources.includes(item.source_id))
    if (references.length === 0) return
    setLoading(true)
    try {
      const inputs = await Promise.all(references.map(async (source) => ({ file: await fetchNarraverseMaterial(source), source })))
      await prepareFiles(inputs)
      setSelectedSources([])
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const runImport = async () => {
    const ready = prepared.filter((item) => item.preview && !item.result && (!item.preview.truncated || item.acceptIncomplete))
    if (ready.length === 0 || importing) return
    setImporting(true)
    const importedIDs: string[] = []
    for (const candidate of ready) {
      try {
        const result = await importMaterial(candidate.file, {
          sourceId: candidate.source?.source_id,
          sourceKind: candidate.source ? 'narraverse_knowledge_base' : 'user_upload',
          acceptIncomplete: candidate.acceptIncomplete,
          managementMode: directImport ? 'unmanaged_direct' : 'master_managed',
        })
        if (result.management_mode === 'master_managed') await enqueueMasterTranslationTargets(workspace, result.translation_targets)
        else await enqueueImportedMetadata(workspace, result.item_ids)
        importedIDs.push(...result.item_ids)
        setPrepared((current) => current.map((item) => item.key === candidate.key ? { ...item, result, error: result.failed.length ? result.failed.join('；') : '' } : item))
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : String(reason)
        setPrepared((current) => current.map((item) => item.key === candidate.key ? { ...item, error } : item))
      }
    }
    setImporting(false)
    if (importedIDs.length > 0) onImported([...new Set(importedIDs)])
  }

  const addMasterSelection = async () => {
    if (selectedMasterAssets.length === 0 || addingMasterAssets) return
    setAddingMasterAssets(true)
    const importedIDs: string[] = []
    try {
      for (const masterItemID of selectedMasterAssets) {
        const result = await instantiateMasterAsset(masterItemID)
        importedIDs.push(...result.item_ids)
      }
      setSelectedMasterAssets([])
      if (importedIDs.length > 0) onImported([...new Set(importedIDs)])
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAddingMasterAssets(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!importing) onOpenChange(next) }}>
      <DialogContent className="max-w-[min(calc(100vw-2rem),900px)] gap-3 border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
        <DialogHeader>
          <DialogTitle>{t('settingPanel.materialImport.title')}</DialogTitle>
          <DialogDescription>{t('settingPanel.materialImport.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 md:grid-cols-2">
          <section className="grid min-h-0 gap-2 rounded-md border border-[var(--nova-border)] p-3">
            <div className="flex items-center justify-between gap-2 text-xs font-medium"><span className="flex items-center gap-2"><Database className="h-4 w-4" />{catalogMode === 'source' ? t('settingPanel.materialImport.knowledgeBase') : t('library.title')}</span>{catalogMode === 'source' && <label className="flex items-center gap-1 text-[11px] font-normal"><input type="checkbox" checked={showAdult} onChange={(event) => setShowAdult(event.target.checked)} />{t('settingPanel.materialImport.showAdult')}</label>}</div>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-[var(--nova-surface-2)] p-1"><button type="button" className={`h-7 rounded px-2 text-[11px] ${catalogMode === 'source' ? 'bg-[var(--nova-surface)] font-medium' : 'text-[var(--nova-text-faint)]'}`} onClick={() => setCatalogMode('source')}>{t('settingPanel.materialImport.knowledgeBase')}</button><button type="button" className={`h-7 rounded px-2 text-[11px] ${catalogMode === 'master' ? 'bg-[var(--nova-surface)] font-medium' : 'text-[var(--nova-text-faint)]'}`} onClick={() => setCatalogMode('master')}>{t('library.title')}</button></div>
            <label className="nova-field flex h-8 items-center gap-2 rounded-md px-2"><Search className="h-3.5 w-3.5" /><input className="min-w-0 flex-1 bg-transparent text-xs outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('settingPanel.materialImport.search')} /></label>
            <ScrollArea className="h-52 rounded-md border border-[var(--nova-border)]">
              <div className="divide-y divide-[var(--nova-border)]">
                {catalogMode === 'source' ? visibleCatalog.map((item) => <label key={item.source_id} className="flex cursor-pointer items-start gap-2 px-2 py-2 text-xs"><input type="checkbox" checked={selectedSources.includes(item.source_id)} onChange={() => setSelectedSources((current) => current.includes(item.source_id) ? current.filter((id) => id !== item.source_id) : [...current, item.source_id])} /><span className="min-w-0"><span className="block truncate">{item.name}</span><span className="block truncate text-[10px] text-[var(--nova-text-faint)]">{item.relative_path} · {formatBytes(item.bytes)}</span></span></label>) : visibleMasterAssets.map((item) => <label key={item.master_item_id} className="flex cursor-pointer items-start gap-2 px-2 py-2 text-xs"><input type="checkbox" disabled={item.availability !== 'usable'} checked={selectedMasterAssets.includes(item.master_item_id)} onChange={() => setSelectedMasterAssets((current) => current.includes(item.master_item_id) ? current.filter((id) => id !== item.master_item_id) : [...current, item.master_item_id])} /><span className="min-w-0"><span className="block truncate">{item.name}</span><span className="block truncate text-[10px] text-[var(--nova-text-faint)]">{item.record_kind} · {item.availability} · {item.usage_count} {t('library.usages')}</span></span></label>)}
                {(catalogMode === 'source' ? visibleCatalog.length : visibleMasterAssets.length) === 0 && <div className="p-6 text-center text-xs text-[var(--nova-text-faint)]">{t('settingPanel.materialImport.none')}</div>}
              </div>
            </ScrollArea>
            {catalogError && <div className="text-xs text-[var(--nova-danger)]">{catalogError}</div>}
            {catalogMode === 'source' ? <Button variant="outline" size="sm" disabled={loading || selectedSources.length === 0} onClick={() => void addKnowledgeSelection()}>{loading ? <Loader2 className="animate-spin" /> : <Database />}{t('settingPanel.materialImport.addSelected', { count: selectedSources.length })}</Button> : <Button variant="outline" size="sm" disabled={addingMasterAssets || selectedMasterAssets.length === 0 || !workspace} onClick={() => void addMasterSelection()}>{addingMasterAssets ? <Loader2 className="animate-spin" /> : <Database />}{t('library.addToAdventure')} ({selectedMasterAssets.length})</Button>}
          </section>

          <section className="grid content-start gap-3 rounded-md border border-[var(--nova-border)] p-3">
            <div className="flex items-center gap-2 text-xs font-medium"><FileUp className="h-4 w-4" />{t('settingPanel.materialImport.upload')}</div>
            <p className="text-xs text-[var(--nova-text-faint)]">{t('settingPanel.materialImport.uploadHint')}</p>
            <input ref={inputRef} type="file" multiple accept=".json,.png,application/json,image/png" className="hidden" onChange={(event) => { const files = [...(event.target.files || [])]; if (files.length) void prepareFiles(files.map((file) => ({ file }))); event.target.value = '' }} />
            <Button variant="outline" size="sm" disabled={loading} onClick={() => inputRef.current?.click()}><FileUp />{t('settingPanel.materialImport.chooseFiles')}</Button>
            <label className="mt-1 flex items-start gap-2 border-t border-[var(--nova-border)] pt-3 text-[11px] text-[var(--nova-text-faint)]">
              <input type="checkbox" checked={directImport} onChange={(event) => setDirectImport(event.target.checked)} />
              <span><span className="block text-[var(--nova-text)]">{t('settingPanel.materialImport.directAdvanced')}</span>{t('settingPanel.materialImport.directWarning')}</span>
            </label>
          </section>
        </div>

        <ScrollArea className="max-h-[34vh] rounded-md border border-[var(--nova-border)]">
          <div className="divide-y divide-[var(--nova-border)]">
            {prepared.map((item) => <div key={item.key} className="flex items-start gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.preview?.name || item.file.name}</span><span className="block text-[11px] text-[var(--nova-text-faint)]">{item.preview ? t('settingPanel.materialImport.previewLine', { type: t(`settingPanel.materialImport.kind.${item.preview.kind}`), count: item.preview.entry_count, bytes: formatBytes(item.preview.resident_bytes) }) : item.error}</span>{(item.preview?.warnings || []).map((warning) => <span key={warning} className="block text-[11px] text-[var(--nova-warning)]">{warning}</span>)}{item.preview && item.error && <span className="block text-[11px] text-[var(--nova-danger)]">{item.error}</span>}{item.preview?.truncated && <label className="mt-1 flex items-center gap-1 text-[11px] text-[var(--nova-danger)]"><input type="checkbox" checked={item.acceptIncomplete} onChange={(event) => setPrepared((current) => current.map((candidate) => candidate.key === item.key ? { ...candidate, acceptIncomplete: event.target.checked } : candidate))} />{t('settingPanel.materialImport.acceptIncomplete')}</label>}{item.result && <span className={item.result.conflict_ids.length ? 'block text-[11px] text-[var(--nova-warning)]' : 'block text-[11px] text-[var(--nova-success)]'}>{t('settingPanel.materialImport.result', { created: item.result.created_ids.length, updated: item.result.updated_ids.length, skipped: item.result.skipped_ids.length, conflicts: item.result.conflict_ids.length })}</span>}</span>
              {item.result?.status === 'pending_translation' && <span className="block text-[11px] text-[var(--nova-warning)]">{t('settingPanel.materialImport.pendingTranslation', { count: item.result.translation_targets.filter((target) => target.status !== 'active').length })}</span>}
              {item.result?.management_mode === 'master_managed' && item.result.status === 'instantiated' && item.result.translation_targets.some((target) => target.status !== 'active') && <span className="block text-[11px] text-[var(--nova-warning)]">{t('settingPanel.materialImport.optionalReview', { count: item.result.translation_targets.filter((target) => target.status !== 'active').length })}</span>}
              {!importing && !item.result && <Button variant="ghost" size="icon-xs" onClick={() => setPrepared((current) => current.filter((candidate) => candidate.key !== item.key))} title={t('common.delete')}><Trash2 /></Button>}
            </div>)}
            {prepared.length === 0 && <div className="p-6 text-center text-xs text-[var(--nova-text-faint)]">{t('settingPanel.materialImport.queueEmpty')}</div>}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={importing} onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
          <Button size="sm" disabled={importing || !prepared.some((item) => item.preview && !item.result && (!item.preview.truncated || item.acceptIncomplete))} onClick={() => void runImport()}>{importing ? <Loader2 className="animate-spin" /> : <FileUp />}{t('settingPanel.materialImport.importReady')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

async function enqueueImportedMetadata(workspace: string, itemIDs: string[]) {
  if (!workspace || itemIDs.length === 0) return
  const selected = new Set(itemIDs)
  const items = (await getLoreItems()).filter((item) => selected.has(item.id))
  const jobs: TranslationJobInput[] = items.flatMap((item) => (['name', 'brief_description'] as const).flatMap((field) => {
    const source = String(item[field] || '').trim()
    if (!source || !/[A-Za-z]/.test(source)) return []
    return [{ item_id: item.id, item_name: item.name, field, source_text: source, base_revision: item.updated_at || '', mode: field === 'name' ? 'name_zh' : 'faithful_zh', apply_policy: 'auto_apply_metadata' } satisfies TranslationJobInput]
  }))
  for (let index = 0; index < jobs.length; index += 100) await createTranslationJobs(workspace, jobs.slice(index, index + 100))
}

function formatBytes(value: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KiB`
}
