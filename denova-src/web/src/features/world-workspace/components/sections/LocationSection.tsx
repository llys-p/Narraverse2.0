import { MapPin, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { emptyLocation } from '../../world-factory'
import { getBinding } from '../../selectors'
import type { World, WorldLocation } from '../../types'

interface LocationSectionProps {
  world: World
  onChange: (locations: WorldLocation[]) => void
  readOnly?: boolean
  /** 提供时删除走该回调（控制台用于级联解除引用并清理 orphan 绑定）；否则仅本地过滤。 */
  onRemove?: (id: string) => void
}

export function LocationSection({ world, onChange, readOnly = false, onRemove }: LocationSectionProps) {
  const { t } = useTranslation()
  const update = (id: string, patch: Partial<WorldLocation>) =>
    onChange(world.locations.map((l) => (l.id === id ? { ...l, ...patch } : l)))

  if (world.locations.length === 0) {
    return (
      <EmptyState variant="dashed" icon={MapPin} title={t('worldWorkspace.console.emptyLocations')}
        action={readOnly ? undefined : { label: t('worldWorkspace.console.addLocation'), onClick: () => onChange([emptyLocation()]) }} />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {world.locations.map((loc) => {
        const bound = getBinding(world, loc.bindingId)
        return (
          <div key={loc.id} className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-3">
            <div className="flex items-center gap-2">
              <input
                className="h-8 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]"
                value={loc.name}
                maxLength={100}
                readOnly={readOnly}
                placeholder={t('worldWorkspace.location.name')}
                onChange={(e) => update(loc.id, { name: e.target.value })}
              />
              {!readOnly && (
                <Button variant="ghost" size="icon-sm" aria-label="remove"
                  onClick={() => (onRemove ? onRemove(loc.id) : onChange(world.locations.filter((l) => l.id !== loc.id)))}><Trash2 /></Button>
              )}
            </div>
            {bound ? <span className="text-[11px] text-[var(--nova-text-muted)]">↳ {bound.nameSnapshot}</span> : null}
            <textarea
              className="min-h-16 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]"
              value={loc.description ?? ''}
              maxLength={4000}
              readOnly={readOnly}
              placeholder={t('worldWorkspace.location.description')}
              onChange={(e) => update(loc.id, { description: e.target.value })}
            />
            <input
              className="h-8 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]"
              value={(loc.tags ?? []).join(', ')}
              readOnly={readOnly}
              placeholder={t('worldWorkspace.location.tags')}
              onChange={(e) => update(loc.id, { tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </div>
        )
      })}
      {!readOnly && (
        <Button variant="outline" size="xs" className="self-start" data-icon="inline-start"
          onClick={() => onChange([...world.locations, emptyLocation()])}>
          <Plus />{t('worldWorkspace.console.addLocation')}
        </Button>
      )}
    </div>
  )
}
