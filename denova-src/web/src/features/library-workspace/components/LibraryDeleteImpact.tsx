import { useTranslation } from 'react-i18next'
import type { WorkLibraryImpact } from '@/lib/api-client'

export function LibraryDeleteImpact({ impact }: { impact: WorkLibraryImpact }) {
  const { t } = useTranslation()
  const affected = impact.relations.length + impact.events.length
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded border border-[var(--nova-border)] p-2 text-xs">
      {affected === 0 ? <p>{t('workLibrary.itemInUse.noImpact')}</p> : <p>{t('workLibrary.itemInUse.body')}</p>}
      {impact.relations.length > 0 ? <section>
        <h4>{t('workLibrary.itemInUse.relations', { count: impact.relations.length })}</h4>
        <ul>{impact.relations.map((relation) => <li key={relation.id} className="break-all">
          {relation.id}: {relation.fromItemId} → {relation.toItemId} ({relation.kind})
        </li>)}</ul>
      </section> : null}
      {impact.events.length > 0 ? <section>
        <h4>{t('workLibrary.itemInUse.events', { count: impact.events.length })}</h4>
        <ul>{impact.events.map((event) => <li key={event.itemId}>{event.title} · {event.itemId}</li>)}</ul>
        <p className="text-muted-foreground">{t('workLibrary.itemInUse.cascadeHint')}</p>
      </section> : null}
    </div>
  )
}
