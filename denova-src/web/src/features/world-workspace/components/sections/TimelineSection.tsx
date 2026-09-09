import { ArrowDown, ArrowUp, History as HistoryIcon, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { emptyTimelineEntry } from '../../world-factory'
import type { TimelineCategory, World, WorldTimelineEntry } from '../../types'

interface TimelineSectionProps {
  world: World
  onChange: (entries: WorldTimelineEntry[]) => void
  readOnly?: boolean
}

function sortByOrder(entries: WorldTimelineEntry[]): WorldTimelineEntry[] {
  return [...entries].sort((a, b) => a.order - b.order)
}

export function TimelineSection({ world, onChange, readOnly = false }: TimelineSectionProps) {
  const { t } = useTranslation()
  const ordered = sortByOrder(world.timeline)

  const update = (id: string, patch: Partial<WorldTimelineEntry>) =>
    onChange(world.timeline.map((e) => (e.id === id ? { ...e, ...patch } : e)))

  const add = () => {
    const nextOrder = world.timeline.reduce((max, e) => Math.max(max, e.order), 0) + 1
    onChange([...world.timeline, emptyTimelineEntry(nextOrder)])
  }

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= ordered.length) return
    const a = ordered[index]
    const b = ordered[target]
    onChange(world.timeline.map((e) => {
      if (e.id === a.id) return { ...e, order: b.order }
      if (e.id === b.id) return { ...e, order: a.order }
      return e
    }))
  }

  if (world.timeline.length === 0) {
    return (
      <EmptyState variant="dashed" icon={HistoryIcon} title={t('worldWorkspace.console.emptyTimeline')}
        action={readOnly ? undefined : { label: t('worldWorkspace.console.addEntry'), onClick: add }} />
    )
  }

  const inputCls = 'h-8 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'

  return (
    <div className="flex flex-col gap-2">
      {ordered.map((entry, index) => (
        <div key={entry.id} className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-3">
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--nova-surface-2)] text-[11px] text-[var(--nova-text-muted)]">{entry.order}</span>
            <input
              className={`${inputCls} min-w-0 flex-1`}
              value={entry.title}
              maxLength={200}
              readOnly={readOnly}
              placeholder={t('worldWorkspace.timeline.title')}
              onChange={(e) => update(entry.id, { title: e.target.value })}
            />
            <select
              className={`${inputCls} w-24`}
              value={entry.category ?? 'canon'}
              disabled={readOnly}
              onChange={(e) => update(entry.id, { category: e.target.value as TimelineCategory })}
            >
              <option value="canon">{t('worldWorkspace.timeline.category.canon')}</option>
              <option value="planned">{t('worldWorkspace.timeline.category.planned')}</option>
            </select>
            {!readOnly && (
              <span className="flex items-center">
                <Button variant="ghost" size="icon-xs" disabled={index === 0} aria-label="up" onClick={() => move(index, -1)}><ArrowUp /></Button>
                <Button variant="ghost" size="icon-xs" disabled={index === ordered.length - 1} aria-label="down" onClick={() => move(index, 1)}><ArrowDown /></Button>
                <Button variant="ghost" size="icon-xs" aria-label="remove" onClick={() => onChange(world.timeline.filter((e) => e.id !== entry.id))}><Trash2 /></Button>
              </span>
            )}
          </div>
          <input
            className={inputCls}
            value={entry.eraLabel ?? ''}
            maxLength={100}
            readOnly={readOnly}
            placeholder={t('worldWorkspace.timeline.era')}
            onChange={(e) => update(entry.id, { eraLabel: e.target.value })}
          />
          <textarea
            className="min-h-14 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]"
            value={entry.description ?? ''}
            maxLength={4000}
            readOnly={readOnly}
            placeholder={t('worldWorkspace.timeline.description')}
            onChange={(e) => update(entry.id, { description: e.target.value })}
          />
        </div>
      ))}
      {!readOnly && (
        <Button variant="outline" size="xs" className="self-start" data-icon="inline-start" onClick={add}>
          <Plus />{t('worldWorkspace.console.addEntry')}
        </Button>
      )}
    </div>
  )
}
