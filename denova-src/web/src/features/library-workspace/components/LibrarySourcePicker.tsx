import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listMasterAssets, type MasterAssetSummary, type WorkLibraryItemInput, type WorkLibraryVocabulary } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { masterToReferenceInput } from '../library-source'

interface Props {
  onCreate: (input: WorkLibraryItemInput) => Promise<boolean>
  onClose: () => void
  vocabulary?: WorkLibraryVocabulary | null
}

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm'

export function LibrarySourcePicker({ onCreate, onClose, vocabulary }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [assets, setAssets] = useState<MasterAssetSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [searched, setSearched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [kind, setKind] = useState('lore')
  const [type, setType] = useState('other')
  const [name, setName] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [revision, setRevision] = useState('')
  const [label, setLabel] = useState('')
  const [locator, setLocator] = useState('')
  const [manualError, setManualError] = useState(false)

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

  const createManualReference = async () => {
    if (!name.trim() || !sourceId.trim() || /^(?:[a-z]:[\\/]|\\\\|\/|file:\/\/)/i.test(locator.trim())) {
      setManualError(true)
      return
    }
    setManualError(false)
    setSaving(true)
    try {
      if (await onCreate({
        name: name.trim(), type, origin: 'reference', loadMode: 'auto', importance: 'important',
        source: { kind, id: sourceId.trim(), revision: revision.trim(), label: label.trim() || name.trim(), locator: locator.trim() },
      })) onClose()
    } finally { setSaving(false) }
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
      <div className="space-y-2 border-t border-[var(--nova-border)] pt-2">
        <h4 className="text-xs font-medium">{t('workLibrary.source.manualTitle')}</h4>
        <p className="text-xs text-muted-foreground">{t('workLibrary.source.manualHint')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">{t('workLibrary.source.kind')}
            <select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value)}>
              {(vocabulary?.sourceKinds ?? ['lore', 'world', 'file', 'manual']).filter((value) => value !== 'master').map((value) =>
                <option key={value} value={value}>{t(`workLibrary.source.kind.${value}`, { defaultValue: value })}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('workLibrary.item.type')}
            <select className={inputClass} value={type} onChange={(event) => setType(event.target.value)}>
              {(vocabulary?.baseItemTypes ?? ['character', 'world', 'location', 'faction', 'rule', 'item', 'other']).map((value) =>
                <option key={value} value={value}>{t(`workLibrary.type.${value}`, { defaultValue: value })}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('workLibrary.item.name')}
            <input className={inputClass} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('workLibrary.source.id')}
            <input className={inputClass} value={sourceId} maxLength={200} onChange={(event) => setSourceId(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('workLibrary.source.revision')}
            <input className={inputClass} value={revision} maxLength={200} onChange={(event) => setRevision(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('workLibrary.source.label')}
            <input className={inputClass} value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs sm:col-span-2">{t('workLibrary.source.locator')}
            <input className={inputClass} value={locator} maxLength={300} placeholder={t('workLibrary.source.locatorPlaceholder')}
              onChange={(event) => setLocator(event.target.value)} />
          </label>
        </div>
        {manualError ? <p role="alert" className="text-xs text-[var(--nova-danger)]">{t('workLibrary.source.manualInvalid')}</p> : null}
        <Button type="button" size="sm" disabled={saving} onClick={() => void createManualReference()}>{t('workLibrary.source.createReference')}</Button>
      </div>
    </section>
  )
}
