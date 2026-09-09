import { Plus, Shield, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { emptyFaction } from '../../world-factory'
import { getBinding } from '../../selectors'
import type { World, WorldFaction } from '../../types'

interface FactionSectionProps {
  world: World
  onChange: (factions: WorldFaction[]) => void
  readOnly?: boolean
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export function FactionSection({ world, onChange, readOnly = false }: FactionSectionProps) {
  const { t } = useTranslation()
  const update = (id: string, patch: Partial<WorldFaction>) =>
    onChange(world.factions.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  if (world.factions.length === 0) {
    return (
      <EmptyState variant="dashed" icon={Shield} title={t('worldWorkspace.console.emptyFactions')}
        action={readOnly ? undefined : { label: t('worldWorkspace.console.addFaction'), onClick: () => onChange([emptyFaction()]) }} />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {world.factions.map((faction) => {
        const bound = getBinding(world, faction.bindingId)
        return (
          <div key={faction.id} className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-3">
            <div className="flex items-center gap-2">
              <input
                className="h-8 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]"
                value={faction.name}
                maxLength={100}
                readOnly={readOnly}
                placeholder={t('worldWorkspace.faction.name')}
                onChange={(e) => update(faction.id, { name: e.target.value })}
              />
              {!readOnly && (
                <Button variant="ghost" size="icon-sm" aria-label="remove"
                  onClick={() => onChange(world.factions.filter((f) => f.id !== faction.id))}><Trash2 /></Button>
              )}
            </div>
            {bound ? <span className="text-[11px] text-[var(--nova-text-muted)]">↳ {bound.nameSnapshot}</span> : null}
            <textarea
              className="min-h-16 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]"
              value={faction.description ?? ''}
              maxLength={4000}
              readOnly={readOnly}
              placeholder={t('worldWorkspace.faction.description')}
              onChange={(e) => update(faction.id, { description: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <ScoreField label={t('worldWorkspace.faction.influence')} value={faction.influence ?? null}
                readOnly={readOnly} onChange={(v) => update(faction.id, { influence: v })} />
              <ScoreField label={t('worldWorkspace.faction.stability')} value={faction.stability ?? null}
                readOnly={readOnly} onChange={(v) => update(faction.id, { stability: v })} />
              <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
                {t('worldWorkspace.faction.headquarters')}
                <select
                  className="h-8 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2 text-sm outline-none focus:border-[var(--nova-ring)]"
                  value={faction.headquartersLocationId ?? ''}
                  disabled={readOnly}
                  onChange={(e) => update(faction.id, { headquartersLocationId: e.target.value || undefined })}
                >
                  <option value="">—</option>
                  {world.locations.map((l) => <option key={l.id} value={l.id}>{l.name || l.id}</option>)}
                </select>
              </label>
            </div>
          </div>
        )
      })}
      {!readOnly && (
        <Button variant="outline" size="xs" className="self-start" data-icon="inline-start"
          onClick={() => onChange([...world.factions, emptyFaction()])}>
          <Plus />{t('worldWorkspace.console.addFaction')}
        </Button>
      )}
    </div>
  )
}

function ScoreField({ label, value, onChange, readOnly }: { label: string; value: number | null; onChange: (v: number | null) => void; readOnly: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
      {label}
      <div className="flex items-center gap-2">
        <input
          type="range" min={0} max={100} value={value ?? 0}
          disabled={readOnly}
          onChange={(e) => onChange(clampScore(Number(e.target.value)))}
          className="flex-1"
        />
        <span className="w-8 text-right text-sm text-[var(--nova-text)]">{value ?? '—'}</span>
      </div>
    </label>
  )
}
