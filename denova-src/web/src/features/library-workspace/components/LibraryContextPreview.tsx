import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { WorkLibrary } from '@/lib/api-client'
import { previewWorkLibrary, type LibraryPreview } from '../library-context-api'

interface Props { library: WorkLibrary; revision: string; dirty: boolean }

/** Session-only read preview. Opening the tab never issues a request. */
export function LibraryContextPreview({ library, revision, dirty }: Props) {
  const { t } = useTranslation()
  const [manual, setManual] = useState<string[]>([])
  const [auto, setAuto] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<{ key: string; data: LibraryPreview } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const eligible = library.items.filter((item) => item.enabled)
  const manualIDs = manual.filter((id) => eligible.some((item) => item.id === id && item.loadMode === 'manual')).sort()
  const autoIDs = auto.filter((id) => eligible.some((item) => item.id === id && item.loadMode === 'auto')).sort()
  const request = { expectedRevision: revision, manualItemIds: manualIDs, autoItemIds: autoIDs, catalogOffset: offset, catalogLimit: 50 }
  const key = JSON.stringify([library.id, request, dirty])
  const activeKey = useRef(key)
  activeKey.current = key
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current++ }
  }, [])
  useEffect(() => {
    sequence.current++
    setLoading(false)
    setError(null)
  }, [key])

  const generate = async () => {
    if (dirty || loading || !revision) return
    const ticket = ++sequence.current
    setLoading(true); setError(null)
    const current = () => mounted.current && ticket === sequence.current && key === activeKey.current
    try {
      const data = await previewWorkLibrary(library.id, request)
      if (current()) setResult({ key, data })
    } catch (failure) {
      if (current()) {
        const code = typeof failure === 'object' && failure && 'code' in failure ? String(failure.code) : ''
        setError(t(`workLibrary.preview.errors.${code}`, { defaultValue: t('workLibrary.loadError') }))
      }
    } finally { if (current()) setLoading(false) }
  }
  const stale = result !== null && (result.key !== key || dirty)
  const data = result?.data
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-3" aria-label={t('workLibrary.tab.preview')}>
      <p className="mb-3 text-sm text-muted-foreground">{t('workLibrary.preview.hint')}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t('workLibrary.preview.resident', { count: eligible.filter((item) => item.loadMode === 'resident').length })}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {(['auto', 'manual'] as const).map((mode) => (
          <label key={mode} className="flex min-w-0 flex-col gap-1 text-sm">
            <span>{t(`workLibrary.preview.${mode}`)}</span>
            <select multiple size={5} value={mode === 'auto' ? autoIDs : manualIDs}
              className="w-full min-w-0 rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2"
              onChange={(event) => {
                const ids = Array.from(event.target.selectedOptions, (option) => option.value)
                if (mode === 'auto') setAuto(ids); else setManual(ids)
              }}>
              {eligible.filter((item) => item.loadMode === mode).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('workLibrary.preview.selectionHint')}</p>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <Button type="button" disabled={dirty || loading || !revision} onClick={() => void generate()}>
          {loading ? t('workLibrary.loading') : t('workLibrary.preview.generate')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => { setAuto([]); setManual([]); setOffset(0) }}>{t('workLibrary.preview.clear')}</Button>
        {dirty ? <span role="status">{t('workLibrary.preview.saveFirst')}</span> : null}
        {stale ? <span role="status">{t('workLibrary.preview.stale')}</span> : null}
      </div>
      {error ? <p role="alert" className="mb-3 text-sm">{error}</p> : null}
      {data ? <div className="space-y-4" aria-busy={loading}>
        <p className="break-all text-xs text-muted-foreground">{data.name} · {data.revision}</p>
        <p className="text-xs">{t('workLibrary.preview.budget', data.budget)}</p>
        <div className="whitespace-pre-wrap break-words text-sm">{[data.summary, data.tone, data.startingPoint].filter(Boolean).join('\n')}</div>
        <h3 className="font-medium">{t('workLibrary.preview.catalog', { total: data.catalog.total })}</h3>
        {data.catalog.items.length === 0 ? <p>{t('workLibrary.preview.empty')}</p> : <ul className="space-y-2">
          {data.catalog.items.map((item) => <li key={item.itemId} className="break-words"><strong>{item.name}</strong><span className="ml-2 text-xs">{item.itemId}</span><p>{item.briefDescription}</p></li>)}
        </ul>}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t('workLibrary.preview.previous')}</Button>
          <Button type="button" variant="ghost" disabled={stale || data.catalog.nextOffset === undefined} onClick={() => setOffset(data.catalog.nextOffset ?? 0)}>{t('workLibrary.preview.next')}</Button>
        </div>
        <h3 className="font-medium">{t('workLibrary.preview.loaded', { count: data.loaded.length })}</h3>
        {data.loaded.length === 0 ? <p>{t('workLibrary.preview.empty')}</p> : data.loaded.map((item) => (
          <details key={item.itemId} className="rounded border border-[var(--nova-border)] p-2">
            <summary className="cursor-pointer break-words">{item.name} · {item.itemId}</summary>
            {item.sourceRevision ? <p className="break-all text-xs">{item.sourceRevision}</p> : null}
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{item.content}</pre>
            {Object.entries(item.fields).map(([field, value]) => <p className="whitespace-pre-wrap break-words text-sm" key={field}><strong>{field}: </strong>{value}</p>)}
            {item.event ? <p className="text-xs">{item.event.era} · {item.event.category} · {(item.event.participantItemIds ?? []).join(', ')}</p> : null}
          </details>
        ))}
        <h3 className="font-medium">{t('workLibrary.preview.relations', { count: data.relations.length })}</h3>
        <ul>{data.relations.map((relation) => <li key={relation.id} className="break-words">{relation.fromItemId} → {relation.toItemId} · {relation.label || relation.kind}</li>)}</ul>
        {data.issues.length > 0 ? <div role="status"><h3>{t('workLibrary.preview.issues')}</h3><ul>{data.issues.map((issue) => <li key={issue.itemId}>{library.items.find((item) => item.id === issue.itemId)?.name ?? issue.itemId}：{t(`workLibrary.preview.errors.${issue.code}`, { defaultValue: t('workLibrary.loadError') })}</li>)}</ul></div> : null}
      </div> : !loading && !error ? <p className="text-sm text-muted-foreground">{t('workLibrary.preview.notGenerated')}</p> : null}
    </section>
  )
}
