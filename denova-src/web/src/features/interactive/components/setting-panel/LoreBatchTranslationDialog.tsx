import { useMemo, useState } from 'react'
import { Languages, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createTranslationJobs, type LoreItem, type TranslationJobInput } from '@/lib/api'

type Scope = 'metadata' | 'content' | 'all'

export function LoreBatchTranslationDialog({ open, onOpenChange, workspace, items }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: string
  items: LoreItem[]
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<Scope>('metadata')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const jobs = useMemo(() => batchTranslationJobs(items, scope), [items, scope])

  const enqueue = async () => {
    if (!workspace || jobs.length === 0) return
    setSubmitting(true)
    setError('')
    try {
      for (let index = 0; index < jobs.length; index += 100) {
        await createTranslationJobs(workspace, jobs.slice(index, index + 100))
      }
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settingPanel.translationQueue.enqueueFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent className="max-w-[min(calc(100vw-2rem),560px)] border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Languages className="h-4 w-4" />{t('settingPanel.translationBatch.title')}</DialogTitle>
          <DialogDescription>{t('settingPanel.translationBatch.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {(['metadata', 'content', 'all'] as Scope[]).map((option) => (
            <label key={option} className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--nova-border)] px-3 py-2 text-xs">
              <input type="radio" name="translation-scope" value={option} checked={scope === option} disabled={submitting} onChange={() => setScope(option)} className="mt-0.5 accent-[var(--nova-accent)]" />
              <span><span className="block font-medium">{t(`settingPanel.translationBatch.scope.${option}`)}</span><span className="text-[11px] text-[var(--nova-text-faint)]">{t(`settingPanel.translationBatch.scope.${option}Hint`)}</span></span>
            </label>
          ))}
          <div className="rounded-md bg-[var(--nova-surface-2)] px-3 py-2 text-xs text-[var(--nova-text-muted)]">{t('settingPanel.translationBatch.estimate', { items: new Set(jobs.map((job) => job.item_id)).size, fields: jobs.length })}</div>
          {error && <div className="rounded-md border border-[var(--nova-danger-border)] bg-[var(--nova-danger-bg)] px-3 py-2 text-xs text-[var(--nova-danger)]">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={submitting} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={submitting || jobs.length === 0} onClick={() => void enqueue()} data-testid="batch-translate-enqueue">
            {submitting ? <Loader2 className="animate-spin" /> : <Languages />}{t('settingPanel.translationBatch.enqueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function batchTranslationJobs(items: LoreItem[], scope: Scope): TranslationJobInput[] {
  const fields = scope === 'metadata' ? ['name', 'brief_description'] as const : scope === 'content' ? ['content'] as const : ['name', 'brief_description', 'content'] as const
  return items.flatMap((item) => fields.flatMap((field) => {
    const source = String(item[field] || '').trim()
    if (!source || !/[A-Za-z]/.test(source)) return []
    return [{
      item_id: item.id, item_name: item.name || item.id, field, source_text: source,
      base_revision: item.updated_at || '', mode: field === 'name' ? 'name_zh' : 'faithful_zh',
      apply_policy: 'auto_apply_metadata',
    } satisfies TranslationJobInput]
  }))
}
