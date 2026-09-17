import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listMasterAssets, type MasterAssetSummary, type WorkLibraryItemInput } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { masterToReferenceInput } from '../library-source'

interface Props {
  onCreate: (input: WorkLibraryItemInput) => Promise<boolean>
  onClose: () => void
}

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm'

export function LibrarySourcePicker({ onCreate, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [assets, setAssets] = useState<MasterAssetSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [searched, setSearched] = useState(false)
  const [saving, setSaving] = useState(false)

  const search = async () => {
    setLoading(true)
    setError(false)
    try {
      const result = await listMasterAssets({ query: query.trim(), availability: 'usable', limit: 40, offset: 0 })
      setAssets(result.assets ?? [])
      setSearched(true)
    } catch {
      setAssets([])
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const select = async (asset: MasterAssetSummary) => {
    setSaving(true)
    try {
      if (await onCreate(masterToReferenceInput(asset))) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="min-w-0 space-y-2 border-b border-[var(--nova-border)] p-3" aria-label={t('workLibrary.items.newFromSource')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t('workLibrary.items.newFromSource')}</h3>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onClose}>{t('workLibrary.close')}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('workLibrary.source.referencePointerHint')}</p>
      <div className="flex gap-2">
        <input className={inputClass} aria-label={t('workLibrary.source.searchPlaceholder')}
          placeholder={t('workLibrary.source.searchPlaceholder')} value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void search() }} />
        <Button type="button" size="sm" disabled={loading || saving} onClick={() => void search()}>
          {t('workLibrary.source.search')}
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--nova-danger)]">{t('workLibrary.loadError')}</p> : null}
      {searched && !error && assets.length === 0 ? <p className="text-xs text-muted-foreground">{t('workLibrary.source.noMatches')}</p> : null}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {assets.map((asset) => (
          <li key={asset.master_item_id}>
            <button type="button" disabled={saving} className="flex w-full min-w-0 items-center gap-2 rounded border border-[var(--nova-border)] p-2 text-left text-xs hover:border-[var(--nova-ring)]"
              onClick={() => void select(asset)}>
              <span className="min-w-0 flex-1 truncate">{asset.name}</span>
              <span className="shrink-0 text-muted-foreground">{t('workLibrary.items.referenceBadge')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
