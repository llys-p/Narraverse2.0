import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Bookmark, Check, Eye, Pencil, Search, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  organizeBookOverview,
  updateLoreItem,
  type BookOverviewOrganizeResult,
  type LoreItem,
  type LoreItemInput,
} from '@/lib/api'
import { parseOverview } from './book-overview-reading'
import { BookOverviewReadView } from './BookOverviewReadView'
import './book-overview.css'
import { isSaveShortcut } from '@/lib/keyboard'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { presetActionButtonClassName as actionButtonClassName } from '../preset-config/editor-styles'
import { loreTypeLabel } from './editor-shared'

export const BOOK_OVERVIEW_PATH = 'setting/book-overview.md'
export const BOOK_OVERVIEW_ENTRY_ID = '__book_overview__'

const SELECTED_MAX = 50

// 关键条目在总览里的分组顺序：与资料库目录的类型口径一致，空组不显示。
const OVERVIEW_TYPE_ORDER: LoreItem['type'][] = ['rule', 'character', 'location', 'faction', 'item', 'world', 'other']

function toInput(item: LoreItem): LoreItemInput {
  const { created_at: _created, updated_at: _updated, ...rest } = item
  return rest
}

export function BookOverviewPanel({
  workspace,
  onOpenItem,
  content,
  setContent,
  items,
  onSave,
}: {
  workspace: string
  onOpenItem?: (id: string) => void
  content: string
  setContent: (value: string) => void
  items: LoreItem[]
  onSave: () => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [pinQuery, setPinQuery] = useState('')
  const [pinnedBusy, setPinnedBusy] = useState(false)
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizeQuery, setOrganizeQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [includeOutline, setIncludeOutline] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<BookOverviewOrganizeResult | null>(null)

  const [resultBaseContent, setResultBaseContent] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const pinSeq = useRef(0)
  const pinBusyRef = useRef(false)
  const activeWorkspace = useRef(workspace)
  activeWorkspace.current = workspace

  useEffect(() => {
    requestSeq.current += 1
    pinSeq.current += 1
    pinBusyRef.current = false
    setResult(null)
    setResultBaseContent(null)
    setSelectedIds([])
    setOrganizeQuery('')
    setOrganizeOpen(false)
    setGenerating(false)
    setPinOpen(false)
    setPinQuery('')
    setPinnedBusy(false)
    setEditing(false)
    return () => { requestSeq.current += 1; pinSeq.current += 1 }
  }, [workspace])

  const selectedSet = new Set(selectedIds)
  const query = organizeQuery.trim().toLowerCase()
  const filteredItems = query
    ? items.filter((item) => `${item.name} ${item.brief_description || ''}`.toLowerCase().includes(query))
    : items

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id)
      if (current.length >= SELECTED_MAX) return current
      return [...current, id]
    })
  }

  const draft = useMemo(() => parseOverview(content), [content])
  const pinned = useMemo(
    () => items
      .filter((item) => item.pinned)
      .sort((a, b) => ((a.pin_order ?? 0) - (b.pin_order ?? 0)) || a.name.localeCompare(b.name)),
    [items],
  )
  const pinCandidateQuery = pinQuery.trim().toLowerCase()
  const candidates = useMemo(() => items.filter((item) => (
    !item.pinned
    && (!pinCandidateQuery || `${item.name} ${item.brief_description || ''}`.toLowerCase().includes(pinCandidateQuery))
  )), [items, pinCandidateQuery])
  const grouped = useMemo(() => OVERVIEW_TYPE_ORDER
    .map((type) => ({ type, entries: pinned.filter((item) => item.type === type) }))
    .filter((group) => group.entries.length > 0), [pinned])
  // 只列现在能确定的缺失，冲突与「矛盾检测」需要后端支持，本轮不假装有。
  const gaps = useMemo(() => {
    const list: string[] = []
    if (!content.trim()) list.push(t('settingPanel.bookOverview.gapNoOverview'))
    if (!pinned.length) list.push(t('settingPanel.bookOverview.gapNoPinned'))
    if (!items.some((item) => item.enabled && item.load_mode === 'resident')) list.push(t('settingPanel.bookOverview.gapNoResident'))
    return list
  }, [content, pinned.length, items, t])

  const patchPinned = async (targets: { item: LoreItem; pinned: boolean; pinOrder: number }[]) => {
    if (pinBusyRef.current) return
    pinBusyRef.current = true
    setPinnedBusy(true)
    const sourceWorkspace = workspace
    const seq = ++pinSeq.current
    const isCurrent = () => seq === pinSeq.current && sourceWorkspace === activeWorkspace.current
    let changed = false
    try {
      for (const target of targets) {
        if (!isCurrent()) break
        await updateLoreItem(target.item.id, {
          ...toInput(target.item),
          pinned: target.pinned,
          pin_order: target.pinOrder,
        }, target.item.updated_at, sourceWorkspace)
        changed = true
      }
    } catch (error) {
      if (isCurrent()) toast.error(error instanceof Error ? error.message : t('editor.saveFailed'))
    } finally {
      // A partial swap must refresh too; never select a row or switch away from overview.
      if (isCurrent()) {
        if (changed) window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { workspace: sourceWorkspace } }))
        pinBusyRef.current = false
        setPinnedBusy(false)
      }
    }
  }

  const pinItem = (item: LoreItem) => {
    const maxOrder = pinned.reduce((max, entry) => Math.max(max, entry.pin_order ?? 0), -1)
    void patchPinned([{ item, pinned: true, pinOrder: maxOrder + 1 }])
  }
  const unpinItem = (item: LoreItem) => void patchPinned([{ item, pinned: false, pinOrder: 0 }])
  const moveItem = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= pinned.length) return
    const a = pinned[index]
    const b = pinned[target]
    const orders = pinned.map((entry) => entry.pin_order ?? 0)
    if (new Set(orders).size !== orders.length) {
      // Only tied legacy pins need normalization. Unpinned entries are never rewritten.
      const reordered = [...pinned]
      ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
      void patchPinned(reordered.flatMap((item, order) => (
        item.pin_order === order ? [] : [{ item, pinned: true, pinOrder: order }]
      )))
      return
    }
    void patchPinned([
      { item: a, pinned: true, pinOrder: b.pin_order ?? 0 },
      { item: b, pinned: true, pinOrder: a.pin_order ?? 0 },
    ])
  }

  const handleGenerate = async () => {
    if (generating) return
    setGenerating(true)
    const sourceContent = content
    const sourceWorkspace = workspace
    const seq = ++requestSeq.current
    const isCurrent = () => seq === requestSeq.current && sourceWorkspace === activeWorkspace.current
    try {
      const next = await organizeBookOverview({
        current_draft: sourceContent,
        selected_lore_ids: selectedIds,
        include_outline: includeOutline,
      })
      if (!isCurrent()) return
      setResult(next)
      setResultBaseContent(sourceContent)
      setOrganizeOpen(false)
    } catch (error) {
      if (!isCurrent()) return
      toast.error(error instanceof Error ? error.message : t('editor.saveFailed'))
    } finally {
      if (isCurrent()) setGenerating(false)
    }
  }

  const used = result?.used
  const usedMissing = used?.missing || []
  const usedSelected = used?.selected_ids || []
  const usedParts: string[] = result
    ? [
        t('settingPanel.bookOverview.usedResident', { count: used?.resident_count || 0 }),
        t('settingPanel.bookOverview.usedSelected', { count: usedSelected.length }),
      ]
    : []
  if (used?.include_outline) {
    usedParts.push(used.outline_found ? t('settingPanel.bookOverview.usedOutline') : t('settingPanel.bookOverview.usedOutlineMissing'))
  }
  const unavailableIds = used?.unknown_ids || []

  const resultIsStale = result !== null && resultBaseContent !== content

  const headerBar = (
    <div className="bo-toolbar">
      <p className="bo-toolbar-note">{t('settingPanel.bookOverview.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button className={actionButtonClassName} variant="outline" size="sm" onClick={() => setEditing((current) => !current)}>
          {editing ? <Eye data-icon="inline-start" /> : <Pencil data-icon="inline-start" />}
          {editing ? t('settingPanel.bookOverview.readMode') : t('settingPanel.bookOverview.editMode')}
        </Button>
        {editing ? (
          <Button className={actionButtonClassName} variant="outline" size="sm" onClick={onSave}>
            <Check data-icon="inline-start" />
            {t('settingPanel.bookOverview.saveNow')}
          </Button>
        ) : null}
        <Button className={actionButtonClassName} variant="outline" size="sm" onClick={() => setPinOpen(true)}>
          <Bookmark data-icon="inline-start" />
          {t('settingPanel.bookOverview.pickKey', { count: pinned.length })}
        </Button>
        <Button className={actionButtonClassName} variant="outline" size="sm" onClick={() => setOrganizeOpen(true)}>
          <Sparkles data-icon="inline-start" />
          {t('settingPanel.bookOverview.organize')}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="book-overview flex min-h-0 flex-1 flex-col">
      {headerBar}

      {editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Textarea
            autoResize={false}
            className="nova-field h-full min-h-[320px] resize-none font-mono text-sm leading-7 shadow-none focus-visible:ring-0"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t('settingPanel.bookOverview.placeholder')}
            onKeyDown={(event) => {
              if (isSaveShortcut(event)) {
                event.preventDefault()
                event.stopPropagation()
                onSave()
              }
            }}
          />
        </div>
      ) : (
        <BookOverviewReadView content={content} draft={draft} items={items} grouped={grouped} gaps={gaps} onEdit={() => setEditing(true)} onOpenItem={onOpenItem} />
      )}

      {result ? (
        <div className="flex max-h-[45%] min-h-0 flex-col border-t border-[var(--nova-border)] bg-[var(--nova-surface)]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <div className="min-w-0 text-xs text-[var(--nova-text-muted)]">
              <span className="font-medium text-[var(--nova-text)]">{t('settingPanel.bookOverview.draftTitle')}</span>
              <span className="ml-2">{usedParts.join(' · ')}</span>
              {usedMissing.length > 0 ? (
                <span className="ml-2 text-[var(--nova-warning,var(--nova-text-faint))]">
                  {t('settingPanel.bookOverview.missing', { list: usedMissing.join('；') })}
                </span>
              ) : null}
              {unavailableIds.length > 0 ? (
                <span className="ml-2 text-[var(--nova-text-faint)]">
                  {t('settingPanel.bookOverview.unavailableIds', { list: unavailableIds.join('、') })}
                </span>
              ) : null}
              {resultIsStale ? <span role="status" className="ml-2 text-[var(--nova-warning,var(--nova-text-faint))]">{t('settingPanel.bookOverview.staleDraft')}</span> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                className={actionButtonClassName}
                variant="outline"
                size="sm"
                disabled={resultIsStale}
                onClick={() => {
                  if (resultIsStale) return
                  setContent(result.draft)
                  setResult(null)
                  setResultBaseContent(null)
                  setEditing(true)
                }}
              >
                <Check data-icon="inline-start" />
                {t('settingPanel.bookOverview.apply')}
              </Button>
              <Button className={actionButtonClassName} variant="outline" size="sm" onClick={() => { setResult(null); setResultBaseContent(null) }}>
                <X data-icon="inline-start" />
                {t('settingPanel.bookOverview.discard')}
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1 px-4 pb-3">
            <pre className="whitespace-pre-wrap font-mono text-xs leading-6 text-[var(--nova-text-muted)]">{result.draft}</pre>
          </ScrollArea>
        </div>
      ) : null}

      <Dialog open={pinOpen} onOpenChange={(next) => { if (!pinnedBusy) setPinOpen(next) }}>
        <DialogContent className="max-w-[min(calc(100vw-2rem),680px)] gap-3 border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
          <DialogHeader>
            <DialogTitle>{t('settingPanel.bookOverview.pickKey', { count: pinned.length })}</DialogTitle>
            <DialogDescription>{t('settingPanel.bookOverview.pickKeyDesc')}</DialogDescription>
          </DialogHeader>

          <div className="nova-field flex h-8 items-center gap-2 rounded-[var(--nova-radius)] px-2 text-xs text-[var(--nova-text-faint)]">
            <Search className="h-3.5 w-3.5" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[var(--nova-text-muted)] outline-none placeholder:text-[var(--nova-text-faint)]"
              value={pinQuery}
              onChange={(event) => setPinQuery(event.target.value)}
              placeholder={t('settingPanel.bookOverview.searchItems')}
              disabled={pinnedBusy}
            />
          </div>

          <ScrollArea className="h-[min(46vh,360px)] rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)]">
            <div className="divide-y divide-[var(--nova-border)]">
              {pinned.length === 0 ? (
                <p className="px-3 py-3 text-[11px] text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.noPinnedYet')}</p>
              ) : pinned.map((item, index) => (
                <div key={item.id} className="flex min-h-10 items-center gap-2 px-3 py-2 text-xs">
                  <span className="w-5 shrink-0 text-[11px] text-[var(--nova-text-faint)]">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[var(--nova-text)]">{item.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--nova-text-faint)]">
                      {loreTypeLabel(item.type, t)}{item.load_mode === 'resident' ? ` · ${t('settingPanel.bookOverview.residentTag')}` : ''}
                    </span>
                  </span>
                  <Button className={actionButtonClassName} variant="outline" size="icon" disabled={pinnedBusy || index === 0} onClick={() => moveItem(index, -1)} aria-label={t('settingPanel.bookOverview.moveUp')}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button className={actionButtonClassName} variant="outline" size="icon" disabled={pinnedBusy || index === pinned.length - 1} onClick={() => moveItem(index, 1)} aria-label={t('settingPanel.bookOverview.moveDown')}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button className={actionButtonClassName} variant="outline" size="sm" disabled={pinnedBusy} onClick={() => unpinItem(item)}>
                    {t('settingPanel.bookOverview.unpin')}
                  </Button>
                </div>
              ))}

              <p className="px-3 py-2 text-[11px] font-medium text-[var(--nova-text-muted)]">{t('settingPanel.bookOverview.addFromList')}</p>
              {candidates.length === 0 ? (
                <p className="px-3 py-6 text-center text-[11px] text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.noItems')}</p>
              ) : candidates.map((item) => (
                <div key={item.id} className="flex min-h-10 items-center gap-3 px-3 py-2 text-xs hover:bg-[var(--nova-hover)]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[var(--nova-text)]">{item.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--nova-text-faint)]">
                      {loreTypeLabel(item.type, t)}{item.enabled ? '' : ` · ${t('settingPanel.bookOverview.disabledTag')}`}
                    </span>
                  </span>
                  <Button className={actionButtonClassName} variant="outline" size="sm" disabled={pinnedBusy} onClick={() => pinItem(item)}>
                    <Bookmark data-icon="inline-start" />
                    {t('settingPanel.bookOverview.pin')}
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>

          <p className="text-[11px] leading-5 text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.pickKeyFootnote')}</p>

          <DialogFooter className="border-[var(--nova-border)] bg-[var(--nova-surface-2)]">
            <Button className={actionButtonClassName} variant="outline" size="sm" disabled={pinnedBusy} onClick={() => setPinOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={organizeOpen} onOpenChange={(next) => { if (!generating) setOrganizeOpen(next) }}>
        <DialogContent className="max-w-[min(calc(100vw-2rem),680px)] gap-3 border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
          <DialogHeader>
            <DialogTitle>{t('settingPanel.bookOverview.organizeTitle')}</DialogTitle>
            <DialogDescription>{t('settingPanel.bookOverview.organizeDesc')}</DialogDescription>
          </DialogHeader>

          <div className="nova-field flex h-8 items-center gap-2 rounded-[var(--nova-radius)] px-2 text-xs text-[var(--nova-text-faint)]">
            <Search className="h-3.5 w-3.5" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[var(--nova-text-muted)] outline-none placeholder:text-[var(--nova-text-faint)]"
              value={organizeQuery}
              onChange={(event) => setOrganizeQuery(event.target.value)}
              placeholder={t('settingPanel.bookOverview.searchItems')}
              disabled={generating}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.selectedCount', { count: selectedIds.length, max: SELECTED_MAX })}</div>
            {selectedIds.length > 0 ? (
              <Button className={actionButtonClassName} variant="outline" size="sm" disabled={generating} onClick={() => setSelectedIds([])}>
                {t('settingPanel.bookOverview.clearSelection')}
              </Button>
            ) : null}
          </div>

          <ScrollArea className="h-[min(40vh,320px)] rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)]">
            <div className="divide-y divide-[var(--nova-border)]">
              {filteredItems.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.noItems')}</div>
              ) : filteredItems.map((item) => (
                <label key={item.id} className="flex min-h-10 cursor-pointer items-center gap-3 px-3 py-2 text-xs hover:bg-[var(--nova-hover)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--nova-accent)]"
                    checked={selectedSet.has(item.id)}
                    disabled={generating || (!selectedSet.has(item.id) && selectedIds.length >= SELECTED_MAX)}
                    onChange={() => toggleSelected(item.id)}
                    aria-label={item.name}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[var(--nova-text)]">{item.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--nova-text-faint)]">{loreTypeLabel(item.type, t)}{item.load_mode === 'resident' ? ` · ${t('settingPanel.bookOverview.residentTag')}` : ''}</span>
                  </span>
                </label>
              ))}
            </div>
          </ScrollArea>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-2">
            <span className="min-w-0 text-xs text-[var(--nova-text-muted)]">{t('settingPanel.bookOverview.includeOutline')}</span>
            <Switch checked={includeOutline} onCheckedChange={setIncludeOutline} disabled={generating} />
          </div>

          <DialogFooter className="border-[var(--nova-border)] bg-[var(--nova-surface-2)]">
            <Button className={actionButtonClassName} variant="outline" size="sm" disabled={generating} onClick={() => setOrganizeOpen(false)}>
              {t('common.close')}
            </Button>
            <Button className={actionButtonClassName} variant="outline" size="sm" disabled={generating} onClick={() => void handleGenerate()}>
              <Sparkles data-icon="inline-start" />
              {generating ? t('settingPanel.bookOverview.generating') : t('settingPanel.bookOverview.generate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
