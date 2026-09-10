import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { listMasterAssets, type MasterAssetSummary } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { newClientId } from '../world-factory'
import { analyzeWorldStructure } from '../world-api'
import { proposalToWorldCreateInput, type ProposalBaseInput } from '../world-proposal'
import type {
  ProposalChoices,
  ProposalItemDecision,
  ProposedCharacter,
  StructureProposal,
  WorldCreateInput,
} from '../types'

const FIELD_OPTIONS: Record<'character_template' | 'lorebook_template', { path: string; labelKey: string }[]> = {
  character_template: [
    { path: 'character.name', labelKey: 'worldWorkspace.aiAnalyzer.field.name' },
    { path: 'character.description', labelKey: 'worldWorkspace.aiAnalyzer.field.description' },
    { path: 'character.personality', labelKey: 'worldWorkspace.aiAnalyzer.field.personality' },
    { path: 'character.scenario', labelKey: 'worldWorkspace.aiAnalyzer.field.scenario' },
    { path: 'character.tags', labelKey: 'worldWorkspace.aiAnalyzer.field.tags' },
  ],
  lorebook_template: [
    { path: 'lorebook.name', labelKey: 'worldWorkspace.aiAnalyzer.field.name' },
    { path: 'lorebook.description', labelKey: 'worldWorkspace.aiAnalyzer.field.description' },
  ],
}

interface AiStructureAnalyzerProps {
  open: boolean
  base: ProposalBaseInput
  onClose: () => void
  onApply: (input: WorldCreateInput) => void
}

export function AiStructureAnalyzer({ open, base, onClose, onApply }: AiStructureAnalyzerProps) {
  const { t } = useTranslation()
  const [assets, setAssets] = useState<MasterAssetSummary[]>([])
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  // 选中的字段：masterItemId -> fieldPaths
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [snippets, setSnippets] = useState<{ snippetId: string; label: string; text: string }[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<StructureProposal | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProposalItemDecision>>({})
  const [adoptedBindingIds, setAdoptedBindingIds] = useState<string[]>([])
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({})
  const [toneOverride, setToneOverride] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setState('loading')
    setError(null)
    void listMasterAssets({ availability: 'usable', limit: 200 })
      .then((res) => setAssets((res.assets ?? []).filter((a) => a.record_kind === 'character_template' || a.record_kind === 'lorebook_template')))
      .then(() => setState('ready'))
      .catch(() => setState('error'))
  }, [open])

  const toggleAsset = (asset: MasterAssetSummary) => {
    setSelected((prev) => {
      const next = { ...prev }
      if (next[asset.master_item_id]) delete next[asset.master_item_id]
      else {
        const kind = asset.record_kind === 'lorebook_template' ? 'lorebook_template' : 'character_template'
        next[asset.master_item_id] = new Set(FIELD_OPTIONS[kind].map((f) => f.path))
      }
      return next
    })
  }

  const toggleField = (asset: MasterAssetSummary, path: string) => {
    setSelected((prev) => {
      const next = { ...prev }
      const set = new Set(next[asset.master_item_id] ?? [])
      if (set.has(path)) set.delete(path); else set.add(path)
      next[asset.master_item_id] = set
      return next
    })
  }

  const addSnippet = () => {
    setSnippets((prev) => (prev.length >= 4 ? prev : [...prev, { snippetId: newClientId(), label: '', text: '' }]))
  }

  const analyze = useCallback(async () => {
    setError(null)
    setAnalyzing(true)
    setProposal(null)
    try {
      const sources = Object.entries(selected)
        .filter(([, fields]) => fields.size > 0)
        .map(([masterItemId, fields]) => {
          const asset = assets.find((a) => a.master_item_id === masterItemId)!
          return { masterItemId, expectedMasterRevision: asset.master_revision ?? '', fieldPaths: [...fields] }
        })
      if (sources.length === 0) {
        setError(t('worldWorkspace.aiAnalyzer.noSources'))
        return
      }
      const res = await analyzeWorldStructure({ sources, snippets: snippets.map((s) => ({ snippetId: s.snippetId, label: s.label.trim() || undefined, text: s.text })) })
      const p = res.proposal
      setProposal(p)
      const initDecisions: Record<string, ProposalItemDecision> = {}
      const all: { proposalItemId: string }[] = [...(p.setting ? [p.setting, ...p.setting.rules] : []), ...p.characters, ...p.locations, ...p.factions]
      for (const item of all) initDecisions[item.proposalItemId] = 'adopt'
      setDecisions(initDecisions)
      setAdoptedBindingIds(p.bindingCandidates.map((c) => c.bindingCandidateId))
      setEdits({})
      setToneOverride(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('worldWorkspace.aiAnalyzer.error'))
    } finally {
      setAnalyzing(false)
    }
  }, [selected, snippets, assets, t])

  const edit = (proposalItemId: string, patch: Record<string, unknown>) => {
    setEdits((prev) => ({ ...prev, [proposalItemId]: { ...(prev[proposalItemId] ?? {}), ...patch } }))
  }

  const apply = () => {
    if (!proposal) return
    const choices: ProposalChoices = {
      decisions,
      adoptedBindingCandidateIds: adoptedBindingIds,
      edits: edits as ProposalChoices['edits'],
      settingOverride: toneOverride !== undefined ? { tone: toneOverride } : undefined,
    }
    onApply(proposalToWorldCreateInput(proposal, choices, base))
  }

  if (!open) return null

  const selectedCount = useMemo(() => Object.values(selected).filter((s) => s.size > 0).length, [selected])

  const inputCls = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--nova-border)] px-3 py-2">
          <h3 className="text-sm font-medium">{t('worldWorkspace.aiAnalyzer.title')}</h3>
          <div className="ml-auto" />
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('worldWorkspace.bindingPicker.close')}><X /></Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!proposal && (
            <div className="flex flex-col gap-3">
              <section>
                <div className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.aiAnalyzer.sourceSelect')}</div>
                {state === 'loading' && <div className="flex items-center gap-2 py-4 text-xs text-[var(--nova-text-muted)]"><Loader2 className="size-4 animate-spin" />{t('worldWorkspace.bindingPicker.loading')}</div>}
                {state === 'error' && <div className="py-2 text-xs text-[var(--nova-text-muted)]">{t('worldWorkspace.bindingPicker.unavailable')}</div>}
                {state === 'ready' && assets.length === 0 && <div className="py-2 text-xs text-[var(--nova-text-muted)]">{t('worldWorkspace.bindingPicker.empty')}</div>}
                {state === 'ready' && assets.map((asset) => {
                  const picked = Boolean(selected[asset.master_item_id])
                  const kind = asset.record_kind === 'lorebook_template' ? 'lorebook_template' : 'character_template'
                  return (
                    <div key={asset.master_item_id} className="mb-1 rounded-[var(--radius-md)] border border-[var(--nova-border)] px-2 py-1.5">
                      <button type="button" onClick={() => toggleAsset(asset)} className="flex w-full items-center gap-2 text-left">
                        <span className={cn('flex size-4 items-center justify-center rounded border border-[var(--nova-border)]', picked && 'bg-[var(--nova-active)] text-[var(--nova-active-text)]')}>
                          {picked ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{asset.name}</span>
                        <span className="text-[11px] text-[var(--nova-text-muted)]">{asset.semantic_type}</span>
                      </button>
                      {picked && (
                        <div className="ml-6 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          {FIELD_OPTIONS[kind].map((f) => (
                            <label key={f.path} className="flex items-center gap-1 text-[11px] text-[var(--nova-text-muted)]">
                              <input type="checkbox" checked={selected[asset.master_item_id].has(f.path)} onChange={() => toggleField(asset, f.path)} />
                              {t(f.labelKey)}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </section>

              <section>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.aiAnalyzer.snippets')}</span>
                  <Button variant="outline" size="xs" onClick={addSnippet} disabled={snippets.length >= 4}>{t('worldWorkspace.aiAnalyzer.addSnippet')}</Button>
                </div>
                {snippets.map((s, i) => (
                  <div key={s.snippetId} className="mb-1 flex gap-2">
                    <input className={cn(inputCls, 'max-w-32')} placeholder={t('worldWorkspace.aiAnalyzer.snippetLabel')} value={s.label} onChange={(e) => setSnippets((prev) => prev.map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))} />
                    <textarea className={cn(inputCls, 'h-14 flex-1')} placeholder={t('worldWorkspace.aiAnalyzer.snippetText')} value={s.text} onChange={(e) => setSnippets((prev) => prev.map((x, idx) => idx === i ? { ...x, text: e.target.value } : x))} />
                    <Button variant="ghost" size="icon-xs" onClick={() => setSnippets((prev) => prev.filter((_, idx) => idx !== i))} aria-label="remove"><X /></Button>
                  </div>
                ))}
              </section>

              {error && <div className="rounded-[var(--radius-md)] border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-300">{error}</div>}
            </div>
          )}

          {proposal && <ProposalReview proposal={proposal} decisions={decisions} setDecisions={setDecisions} adoptedBindingIds={adoptedBindingIds} setAdoptedBindingIds={setAdoptedBindingIds} edits={edits} edit={edit} toneOverride={toneOverride} setToneOverride={setToneOverride} t={t} inputCls={inputCls} />}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--nova-border)] p-2">
          {!proposal ? (
            <Button size="sm" className="ml-auto" disabled={analyzing || selectedCount === 0} onClick={() => void analyze()} data-icon="inline-start">
              {analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {analyzing ? t('worldWorkspace.aiAnalyzer.analyzing') : t('worldWorkspace.aiAnalyzer.analyze')}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => { setProposal(null); setDecisions({}); setEdits({}) }}>{t('worldWorkspace.aiAnalyzer.reanalyze')}</Button>
              <Button size="sm" onClick={apply} data-icon="inline-start"><Check className="size-3.5" />{t('worldWorkspace.aiAnalyzer.apply')}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface ProposalReviewProps {
  proposal: StructureProposal
  decisions: Record<string, ProposalItemDecision>
  setDecisions: (fn: (prev: Record<string, ProposalItemDecision>) => Record<string, ProposalItemDecision>) => void
  adoptedBindingIds: string[]
  setAdoptedBindingIds: (ids: string[]) => void
  edits: Record<string, Record<string, unknown>>
  edit: (proposalItemId: string, patch: Record<string, unknown>) => void
  toneOverride: string | undefined
  setToneOverride: (v: string | undefined) => void
  t: (k: string, o?: Record<string, unknown>) => string
  inputCls: string
}

function ProposalReview({ proposal, decisions, setDecisions, adoptedBindingIds, setAdoptedBindingIds, edits, edit, toneOverride, setToneOverride, t, inputCls }: ProposalReviewProps) {
  const confidenceLabel = (c: string) => t(`worldWorkspace.aiAnalyzer.confidence.${c}`)

  const toggle = (id: string) => setDecisions((prev) => ({ ...prev, [id]: prev[id] === 'discard' ? 'adopt' : 'discard' }))
  const isAdopt = (id: string) => decisions[id] !== 'discard'

  const toggleBinding = (id: string) => setAdoptedBindingIds(adoptedBindingIds.includes(id) ? adoptedBindingIds.filter((x) => x !== id) : [...adoptedBindingIds, id])

  const row = (id: string, content: React.ReactNode, confidence: string) => (
    <div className={cn('mb-1 flex items-start gap-2 rounded-[var(--radius-md)] border px-2 py-1.5', isAdopt(id) ? 'border-[var(--nova-border)]' : 'border-transparent opacity-50')}>
      <button type="button" onClick={() => toggle(id)} className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-[var(--nova-border)]">
        {isAdopt(id) ? <Check className="size-3" /> : null}
      </button>
      <div className="min-w-0 flex-1">{content}</div>
      <span className="shrink-0 text-[10px] text-[var(--nova-text-muted)]">{confidenceLabel(confidence)}</span>
    </div>
  )

  return (
    <div className="flex flex-col gap-3 text-sm">
      {proposal.setting && (
        <section>
          <div className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.aiAnalyzer.setting')}</div>
          {row(proposal.setting.proposalItemId, (
            <div className="flex flex-col gap-1">
              <input className={cn(inputCls, 'max-w-56')} placeholder={t('worldWorkspace.aiAnalyzer.tone')} value={toneOverride ?? proposal.setting.tone ?? ''} onChange={(e) => setToneOverride(e.target.value || undefined)} />
              {proposal.setting.rules.map((r) => (
                <div key={r.proposalItemId} className="flex items-start gap-2">
                  <button type="button" onClick={() => toggle(r.proposalItemId)} className="mt-1.5 flex size-4 shrink-0 items-center justify-center rounded border border-[var(--nova-border)]">
                    {isAdopt(r.proposalItemId) ? <Check className="size-3" /> : null}
                  </button>
                  <input className={cn(inputCls, 'flex-1')} value={(edits[r.proposalItemId]?.text as string | undefined) ?? r.text} onChange={(e) => edit(r.proposalItemId, { text: e.target.value })} />
                </div>
              ))}
            </div>
          ), proposal.setting.confidence)}
        </section>
      )}

      {proposal.characters.length > 0 && (
        <section>
          <div className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.characters')}</div>
          {proposal.characters.map((c) => (
            <div key={c.proposalItemId}>{row(c.proposalItemId, <CharacterEditor item={c} edits={edits} edit={edit} inputCls={inputCls} t={t} />, c.confidence)}</div>
          ))}
        </section>
      )}

      {proposal.locations.length > 0 && (
        <section>
          <div className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.locations')}</div>
          {proposal.locations.map((l) => (
            <div key={l.proposalItemId}>{row(l.proposalItemId, <input className={inputCls} value={(edits[l.proposalItemId]?.name as string | undefined) ?? l.name} onChange={(e) => edit(l.proposalItemId, { name: e.target.value })} />, l.confidence)}</div>
          ))}
        </section>
      )}

      {proposal.factions.length > 0 && (
        <section>
          <div className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.factions')}</div>
          {proposal.factions.map((f) => (
            <div key={f.proposalItemId}>{row(f.proposalItemId, <input className={inputCls} value={(edits[f.proposalItemId]?.name as string | undefined) ?? f.name} onChange={(e) => edit(f.proposalItemId, { name: e.target.value })} />, f.confidence)}</div>
          ))}
        </section>
      )}

      {proposal.bindingCandidates.length > 0 && (
        <section>
          <div className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.aiAnalyzer.bindingCandidates')}</div>
          {proposal.bindingCandidates.map((c) => {
            const on = adoptedBindingIds.includes(c.bindingCandidateId)
            return (
              <button key={c.bindingCandidateId} type="button" onClick={() => toggleBinding(c.bindingCandidateId)} className={cn('mb-1 flex w-full items-center gap-2 rounded-[var(--radius-md)] border border-[var(--nova-border)] px-2 py-1.5 text-left', !on && 'opacity-50')}>
                <span className={cn('flex size-4 items-center justify-center rounded border border-[var(--nova-border)]', on && 'bg-[var(--nova-active)] text-[var(--nova-active-text)]')}>{on ? <Check className="size-3" /> : null}</span>
                <span className="min-w-0 flex-1 truncate text-xs">{c.nameSnapshot}</span>
                <span className="text-[11px] text-[var(--nova-text-muted)]">{c.semanticType} · {c.scope}</span>
              </button>
            )
          })}
        </section>
      )}
    </div>
  )
}

function CharacterEditor({ item, edits, edit, inputCls, t }: { item: ProposedCharacter; edits: Record<string, Record<string, unknown>>; edit: (id: string, patch: Record<string, unknown>) => void; inputCls: string; t: (k: string) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={cn(inputCls, 'max-w-48')} value={(edits[item.proposalItemId]?.displayName as string | undefined) ?? item.displayName} onChange={(e) => edit(item.proposalItemId, { displayName: e.target.value })} />
      <select className={cn(inputCls, 'max-w-32')} value={(edits[item.proposalItemId]?.role as string | undefined) ?? item.role ?? ''} onChange={(e) => edit(item.proposalItemId, { role: e.target.value || undefined })}>
        <option value="">—</option>
        <option value="protagonist">{t('worldWorkspace.role.protagonist')}</option>
        <option value="major">{t('worldWorkspace.role.major')}</option>
        <option value="minor">{t('worldWorkspace.role.minor')}</option>
        <option value="npc">{t('worldWorkspace.role.npc')}</option>
      </select>
    </div>
  )
}
