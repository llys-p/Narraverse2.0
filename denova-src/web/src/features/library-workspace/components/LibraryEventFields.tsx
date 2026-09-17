import { useTranslation } from 'react-i18next'
import type { WorkLibraryEventDetail, WorkLibraryItem } from '@/lib/api-client'
import { parseEventOrder } from '../library-errors'

interface Props {
  value: WorkLibraryEventDetail
  onChange: (value: WorkLibraryEventDetail) => void
  items: WorkLibraryItem[]
  readOnly: boolean
}

const input = 'rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-1.5 text-xs'

export function LibraryEventFields({ value, onChange, items, readOnly }: Props) {
  const { t } = useTranslation()
  const participants = new Set(value.participantItemIds ?? [])
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(participants)
    if (checked) next.add(id)
    else next.delete(id)
    onChange({ ...value, participantItemIds: [...next] })
  }

  return (
    <section className="space-y-2 rounded border border-[var(--nova-border)] p-2.5 text-xs">
      <h3 className="font-medium">{t('workLibrary.timeline.title')}</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1">{t('workLibrary.timeline.order')}
          <input className={input} type="number" value={value.order} disabled={readOnly}
            onChange={(event) => onChange({ ...value, order: parseEventOrder(event.target.value) })} />
        </label>
        <label className="flex flex-col gap-1">{t('workLibrary.timeline.era')}
          <input className={input} value={value.era} disabled={readOnly} onChange={(event) => onChange({ ...value, era: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1">{t('workLibrary.timeline.category')}
          <select className={input} value={value.category} disabled={readOnly}
            onChange={(event) => onChange({ ...value, category: event.target.value })}>
            {['background', 'historical', 'planned'].map((category) =>
              <option key={category} value={category}>{t(`workLibrary.eventCategory.${category}`)}</option>)}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">{t('workLibrary.timeline.location')}
        <select className={input} value={value.locationItemId ?? ''} disabled={readOnly}
          onChange={(event) => onChange({ ...value, locationItemId: event.target.value })}>
          <option value="">—</option>
          {items.filter((item) => item.type === 'location').map((item) =>
            <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
        </select>
      </label>
      <fieldset disabled={readOnly} className="space-y-1">
        <legend>{t('workLibrary.timeline.participants')}</legend>
        <div className="flex flex-wrap gap-2">
          {items.filter((item) => item.type !== 'event').map((item) => (
            <label key={item.id} className="flex items-center gap-1">
              <input type="checkbox" checked={participants.has(item.id)} onChange={(event) => toggle(item.id, event.target.checked)} />
              {item.name} · {item.id}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  )
}
