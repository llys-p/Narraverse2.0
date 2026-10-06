import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { LoreItem } from '@/lib/api'
import { TYPE_OPTIONS, loreTypeLabel } from '@/features/interactive/components/setting-panel/editor-shared'
import type { NewEntryInput } from './use-book-library-lore'

interface NewEntryDialogProps {
  open: boolean
  busy: boolean
  defaultType?: LoreItem['type']
  onOpenChange: (open: boolean) => void
  onCreate: (input: NewEntryInput) => Promise<LoreItem | null>
}

/** 新建只收集真实存在的字段：名称、类型与可选摘要，不预设档案或事件。 */
export function NewEntryDialog({ open, busy, defaultType = 'character', onOpenChange, onCreate }: NewEntryDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [type, setType] = useState<LoreItem['type']>(defaultType)
  const [brief, setBrief] = useState('')
  const [error, setError] = useState('')

  const reset = () => {
    setName('')
    setBrief('')
    setError('')
  }

  const submit = async () => {
    if (!name.trim()) {
      setError(t('bookLibrary.entry.nameRequired'))
      return
    }
    const created = await onCreate({ name, type, brief_description: brief })
    if (created) {
      reset()
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-[min(calc(100vw-2rem),480px)] gap-3 border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
        <DialogHeader>
          <DialogTitle>{t('bookLibrary.entry.create')}</DialogTitle>
          <DialogDescription>{t('bookLibrary.entry.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs">
            <span>{t('settingPanel.field.name')}</span>
            <Input autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder={t('bookLibrary.entry.namePlaceholder')} />
          </label>
          <label className="grid gap-1 text-xs">
            <span>{t('settingPanel.field.type')}</span>
            <Select value={type} disabled={busy} onValueChange={(value) => setType(value as LoreItem['type'])}>
              <SelectTrigger size="sm" aria-label={t('settingPanel.field.type')}><SelectValue /></SelectTrigger>
              <SelectContent className="nova-panel border text-[var(--nova-text)]">
                <SelectGroup>
                  {TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{loreTypeLabel(option.value, t)}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-xs">
            <span>{t('settingPanel.field.brief')}</span>
            <Textarea className="nova-field min-h-16 resize-y text-xs" value={brief} disabled={busy} onChange={(event) => setBrief(event.target.value)} placeholder={t('bookLibrary.entry.briefPlaceholder')} />
          </label>
        </div>
        {error ? <p role="alert" className="text-[11px] text-[var(--nova-danger)]">{error}</p> : null}
        <DialogFooter className="border-[var(--nova-border)] bg-[var(--nova-surface-2)]">
          <Button className="text-xs" variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button className="text-xs" size="sm" disabled={busy} onClick={() => void submit()}>{t('bookLibrary.entry.createConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
