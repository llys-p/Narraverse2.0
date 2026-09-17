import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { WorkLibraryItem, WorkLibraryItemInput, WorkLibraryLoadMode } from '@/lib/api-client'

interface Props {
  items: WorkLibraryItem[]
  onSave: (itemId: string, patch: WorkLibraryItemInput) => Promise<boolean>
  onDirtyChange?: (dirty: boolean) => void
}

type Choice = { loadMode: WorkLibraryLoadMode; enabled: boolean }
const MODES: WorkLibraryLoadMode[] = ['resident', 'auto', 'manual']

export function LibraryLoadSettings({ items, onSave, onDirtyChange }: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Record<string, Choice>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const current = (item: WorkLibraryItem): Choice => draft[item.id] ?? { loadMode: item.loadMode, enabled: item.enabled }
  const changed = useMemo(() => items.some((item) => {
    const choice = draft[item.id]
    return choice && (choice.loadMode !== item.loadMode || choice.enabled !== item.enabled)
  }), [items, draft])
  useEffect(() => onDirtyChange?.(Boolean(changed)), [changed, onDirtyChange])

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError(false)
    try {
      for (const item of items) {
        const choice = current(item)
        if (choice.loadMode === item.loadMode && choice.enabled === item.enabled) continue
        if (!await onSave(item.id, { baseUpdatedAt: item.updatedAt, ...choice })) {
          setError(true)
          return
        }
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <p className="text-muted-foreground">{t('workLibrary.settings.hint')}</p>
      <Button type="button" size="sm" disabled={saving || !changed} onClick={() => void save()}>{t('workLibrary.settings.save')}</Button>
      {error ? <p role="alert" className="text-[var(--nova-danger)]">{t('workLibrary.settings.error')}</p> : null}
      {items.length === 0 ? <p>{t('workLibrary.items.empty.title')}</p> : null}
      {MODES.map((mode) => (
        <section key={mode} className="space-y-1">
          <h3 className="font-medium">{t(`workLibrary.loadMode.${mode}`)}</h3>
          {items.filter((item) => current(item).loadMode === mode).map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--nova-border)] p-2 sm:flex-nowrap">
              <span className="min-w-0 flex-1 truncate" title={item.id}>{item.name}</span>
              <label className="flex items-center gap-1">
                <span>{t('workLibrary.loadMode.label')}</span>
                <select className="rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-1"
                  aria-label={`${item.name} ${t('workLibrary.loadMode.label')}`} value={current(item).loadMode}
                  onChange={(event) => setDraft((old) => ({ ...old, [item.id]: { ...current(item), loadMode: event.target.value as WorkLibraryLoadMode } }))}>
                  {MODES.map((option) => <option key={option} value={option}>{t(`workLibrary.loadMode.${option}`)}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" aria-label={`${item.name} ${t('workLibrary.item.enabled')}`}
                  checked={current(item).enabled}
                  onChange={(event) => setDraft((old) => ({ ...old, [item.id]: { ...current(item), enabled: event.target.checked } }))} />
                <span>{t('workLibrary.item.enabled')}</span>
              </label>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
