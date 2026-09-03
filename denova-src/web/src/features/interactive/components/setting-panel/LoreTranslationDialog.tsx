import { useMemo, useState } from 'react'
import { Languages, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createTranslationJobs, type LoreItem, type LoreTranslationField, type TranslationJobInput } from '@/lib/api'

const FIELD_ORDER: LoreTranslationField[] = ['name', 'brief_description', 'content']

export function LoreTranslationDialog({ open, onOpenChange, workspace, draft }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: string
  draft: LoreItem | null
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<LoreTranslationField, boolean>>({ name: false, brief_description: false, content: true })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const canStart = useMemo(() => Boolean(draft && workspace && FIELD_ORDER.some((field) => (
    selected[field] && String(draft[field] || '').trim().length > 0
  ))), [draft, selected, workspace])

  const close = () => {
    if (submitting) return
    setError('')
    onOpenChange(false)
  }

  const enqueue = async () => {
    if (!draft || !canStart) return
    const jobs: TranslationJobInput[] = FIELD_ORDER.flatMap((field) => {
      const source = selected[field] ? String(draft[field] || '').trim() : ''
      if (!source) return []
      return [{
        item_id: draft.id, item_name: draft.name || draft.id, field,
        source_text: source, base_revision: draft.updated_at || '',
        mode: field === 'name' ? 'name_zh' : 'faithful_zh',
        apply_policy: field === 'content' ? 'review_content' : 'auto_apply_metadata',
      }]
    })
    setSubmitting(true)
    setError('')
    try {
      await createTranslationJobs(workspace, jobs)
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settingPanel.loreTranslate.error.unknown'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(true) }}>
      <DialogContent className="max-w-[min(calc(100vw-2rem),620px)] gap-3 border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Languages className="h-4 w-4" />{t('settingPanel.loreTranslate.title')}</DialogTitle>
          <DialogDescription>{draft ? t('settingPanel.loreTranslate.queueDesc', { name: draft.name }) : ''}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs text-[var(--nova-text-faint)]">{t('settingPanel.loreTranslate.queueHint')}</p>
          {FIELD_ORDER.map((field) => {
            const value = String(draft?.[field] || '').trim()
            return (
              <label key={field} className={cn(
                'flex items-center gap-3 rounded-md border px-3 py-2 text-xs',
                selected[field] ? 'border-[var(--nova-accent)] bg-[var(--nova-accent-bg)]' : 'border-[var(--nova-border)]',
                !value && 'cursor-not-allowed opacity-50',
              )}>
                <input type="checkbox" checked={selected[field]} disabled={!value || submitting}
                  onChange={(event) => setSelected((current) => ({ ...current, [field]: event.target.checked }))}
                  className="h-4 w-4 accent-[var(--nova-accent)]" />
                <span className="font-medium">{t(`settingPanel.translationQueue.field.${field}`)}</span>
                <span className="ml-auto max-w-[65%] truncate text-[var(--nova-text-faint)]">{value.slice(0, 80)}</span>
              </label>
            )
          })}
          {error && <div className="rounded-md border border-[var(--nova-danger-border)] bg-[var(--nova-danger-bg)] px-3 py-2 text-xs text-[var(--nova-danger)]">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={submitting} onClick={close}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={!canStart || submitting} onClick={() => void enqueue()} data-testid="lore-translate-enqueue">
            {submitting ? <Loader2 className="animate-spin" /> : <Languages />}{t('settingPanel.loreTranslate.enqueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
