import { useState } from 'react'
import { Check, Search, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { organizeBookOverview, type BookOverviewOrganizeResult, type LoreItem } from '@/lib/api'
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

export function BookOverviewPanel({
  content,
  setContent,
  items,
  onSave,
}: {
  content: string
  setContent: (value: string) => void
  items: LoreItem[]
  onSave: () => void
}) {
  const { t } = useTranslation()
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizeQuery, setOrganizeQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [includeOutline, setIncludeOutline] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<BookOverviewOrganizeResult | null>(null)
  const [resultBaseContent, setResultBaseContent] = useState<string | null>(null)

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

  const handleGenerate = async () => {
    if (generating) return
    setGenerating(true)
    const sourceContent = content
    try {
      const next = await organizeBookOverview({
        current_draft: sourceContent,
        selected_lore_ids: selectedIds,
        include_outline: includeOutline,
      })
      setResult(next)
      setResultBaseContent(sourceContent)
      setOrganizeOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('editor.saveFailed'))
    } finally {
      setGenerating(false)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--nova-border)] px-4 py-2">
        <p className="min-w-0 flex-1 text-xs text-[var(--nova-text-muted)]">{t('settingPanel.bookOverview.hint')}</p>
        <Button className={actionButtonClassName} variant="outline" size="sm" onClick={() => setOrganizeOpen(true)}>
          <Sparkles data-icon="inline-start" />
          {t('settingPanel.bookOverview.organize')}
        </Button>
      </div>

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
