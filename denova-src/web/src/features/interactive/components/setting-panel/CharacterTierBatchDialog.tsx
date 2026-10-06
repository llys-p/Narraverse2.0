import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getLoreItems, updateLoreItem, type LoreItem } from '@/lib/api'

type CharacterTier = NonNullable<LoreItem['character_tier']>

export function CharacterTierBatchDialog({
  workspace, items, disabled = false, onBeforeWrite, onSaved, onChanged,
}: {
  workspace: string
  items: LoreItem[]
  disabled?: boolean
  onBeforeWrite: () => Promise<boolean>
  onSaved: (item: LoreItem) => void
  onChanged: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [tier, setTier] = useState<CharacterTier>('unclassified')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const activeWorkspace = useRef(workspace)
  const alive = useRef(true)
  const sequence = useRef(0)
  activeWorkspace.current = workspace

  useEffect(() => {
    alive.current = true
    sequence.current += 1
    setOpen(false)
    setSelected([])
    setQuery('')
    setError('')
    setBusy(false)
    return () => { alive.current = false; sequence.current += 1 }
  }, [workspace])

  const isCurrent = (source: string, request: number) => alive.current
    && activeWorkspace.current === source && sequence.current === request
  const characters = items.filter((item) => item.type === 'character')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = characters.filter((item) => !normalizedQuery
    || `${item.name} ${item.brief_description || ''}`.toLocaleLowerCase().includes(normalizedQuery))

  const save = async () => {
    if (busy || selected.length === 0) return
    const sourceWorkspace = workspace
    const request = ++sequence.current
    setBusy(true)
    setError('')
    const changed: string[] = []
    let failed = false
    let missing = false
    try {
      if (!await onBeforeWrite()) {
        if (isCurrent(sourceWorkspace, request)) setError(t('settingPanel.characterTier.saveFailed'))
        return
      }
      if (!isCurrent(sourceWorkspace, request)) return
      const latestItems = await getLoreItems()
      if (!isCurrent(sourceWorkspace, request)) return
      for (const id of selected) {
        if (!isCurrent(sourceWorkspace, request)) return
        const latest = latestItems.find((item) => item.id === id)
        if (!latest || latest.type !== 'character') {
          failed = true
          missing = true
          continue
        }
        const { created_at: _createdAt, updated_at: _updatedAt, ...fullInput } = latest
        try {
          const saved = await updateLoreItem(id, {
            ...fullInput,
            character_tier: tier,
          }, latest.updated_at, sourceWorkspace)
          if (!isCurrent(sourceWorkspace, request)) return
          changed.push(id)
          onSaved(saved)
        } catch {
          failed = true
        }
      }
      if (!isCurrent(sourceWorkspace, request)) return
      if (changed.length) onChanged(changed)
      if (changed.length) toast.success(t('settingPanel.characterTier.applied', { count: changed.length }))
      if (failed) setError([
        ...(missing ? [t('settingPanel.characterTier.missing')] : []),
        ...(changed.length < selected.length ? [t('settingPanel.characterTier.saveFailed')] : []),
      ].join(' '))
      else {
        setOpen(false)
        setSelected([])
      }
    } catch {
      if (isCurrent(sourceWorkspace, request)) setError(t('settingPanel.characterTier.saveFailed'))
    } finally {
      if (isCurrent(sourceWorkspace, request)) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); if (!next) setError('') } }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>{t('settingPanel.characterTier.batchOpen')}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(calc(100vw-2rem),620px)] gap-3 border border-[var(--nova-border)] bg-[var(--nova-surface)] text-[var(--nova-text)]">
        <DialogHeader>
          <DialogTitle>{t('settingPanel.characterTier.batchOpen')}</DialogTitle>
          <DialogDescription>{t('settingPanel.characterTier.batchDescription')}</DialogDescription>
        </DialogHeader>
        <Input aria-label={t('common.search')} value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder={t('common.search')} />
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>{t('settingPanel.characterTier.selected', { count: selected.length })}</span>
          <Button type="button" variant="ghost" size="sm" disabled={busy || visible.length === 0} onClick={() => setSelected((current) => (
            visible.every((item) => current.includes(item.id))
              ? current.filter((id) => !visible.some((item) => item.id === id))
              : Array.from(new Set([...current, ...visible.map((item) => item.id)]))
          ))}>{t('library.review.selectAll')}</Button>
        </div>
        {selected.length === 0 && <p className="text-xs text-[var(--nova-muted)]">{t('settingPanel.characterTier.noSelection')}</p>}
        <div className="max-h-56 space-y-1 overflow-y-auto" role="group" aria-label={t('settingPanel.characterTier.batchOpen')}>
          {visible.length ? visible.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--nova-hover)]">
              <input type="checkbox" aria-label={item.name} checked={selected.includes(item.id)} disabled={busy}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, item.id] : current.filter((id) => id !== item.id))} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="text-xs text-[var(--nova-muted)]">{t(`settingPanel.characterTier.${item.character_tier || 'unclassified'}`)}</span>
            </label>
          )) : <p className="py-4 text-center text-sm text-[var(--nova-muted)]">{t('settingPanel.characterTier.empty')}</p>}
        </div>
        <div className="space-y-1">
          <label className="text-sm" htmlFor="character-tier-batch-select">{t('settingPanel.characterTier.field')}</label>
          <Select value={tier} onValueChange={(value) => setTier(value as CharacterTier)} disabled={busy}>
            <SelectTrigger id="character-tier-batch-select"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(['major', 'minor', 'unclassified'] as const).map((value) => (
                <SelectItem key={value} value={value}>{t(`settingPanel.characterTier.${value}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button type="button" disabled={busy || selected.length === 0} onClick={() => void save()}>
            {t('settingPanel.characterTier.batchApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
