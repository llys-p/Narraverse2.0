import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { characterDisplayName } from '../../selectors'
import { worldScopedBindings } from '../../world-ops'
import type { World } from '../../types'
import {
  SELECTION_LIMITS,
  MAX_SELECTED_TOTAL,
  findSelectionOverflow,
  isIdentityOnlySelection,
  toggleRuleIndex,
  toggleSelectionId,
  type SelectionLimitKey,
  type WorldContextConsumer,
  type WorldContextSelection as Selection,
} from '../../world-context'

/**
 * Phase 3.1B1：Context Preview 选择控件（受控、纯内存）。
 *
 * - 默认 identity-only：identity 永远由服务端包含，这里不提供 includeIdentity 开关；
 * - 可选：基调(tone)、规则(按 World 内下标 ruleIndexes，不存正文)、角色/地点/势力/时间线，
 *   以及仅 world-scope 的资料绑定（entity 绑定由已选实体自动派生，不出现在可勾选列表）；
 * - consumer 只有 writing/game，绝不出现 narraverse/module4；
 * - 只做与后端冻结上限一致的数量预检：超限明确提示但绝不静默截断；
 * - 不发任何网络请求、不访问浏览器持久化、不修改 World。
 */
interface WorldContextSelectionProps {
  world: World
  consumer: WorldContextConsumer
  selection: Selection
  onConsumerChange: (consumer: WorldContextConsumer) => void
  onChange: (next: Selection) => void
}

interface Option {
  id: string
  label: string
}

export function WorldContextSelection({
  world,
  consumer,
  selection,
  onConsumerChange,
  onChange,
}: WorldContextSelectionProps) {
  const { t } = useTranslation()

  const characters: Option[] = world.characters.map((c) => ({ id: c.id, label: characterDisplayName(world, c) || c.id }))
  const locations: Option[] = world.locations.map((l) => ({ id: l.id, label: l.name || l.id }))
  const factions: Option[] = world.factions.map((f) => ({ id: f.id, label: f.name || f.id }))
  const timeline: Option[] = [...world.timeline]
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ id: e.id, label: e.title || e.id }))
  // 仅 world-scope 绑定可手动选择；entity 绑定随实体自动派生。
  const materials: Option[] = worldScopedBindings(world).map((b) => ({
    id: b.bindingId, label: b.nameSnapshot || t('worldWorkspace.context.source.unknown'),
  }))
  const rules = world.worldSetting?.rules ?? []
  const tone = world.worldSetting?.tone ?? ''

  const overflows = findSelectionOverflow(selection)
  const overflowByKey = new Map(overflows.map((o) => [o.key, o]))
  const totalOverflow = overflowByKey.get('total')

  const patch = (part: Partial<Selection>) => onChange({ ...selection, ...part })
  const toggleIdKey = (key: 'characterIds' | 'locationIds' | 'factionIds' | 'timelineEntryIds' | 'bindingIds', id: string) =>
    patch({ [key]: toggleSelectionId(selection[key], id) } as Partial<Selection>)

  const setAll = (key: SelectionLimitKey, ids: string[]) => patch({ [key]: ids } as Partial<Selection>)

  const consumers: { value: WorldContextConsumer; label: string }[] = [
    { value: 'writing', label: t('worldWorkspace.context.consumer.writing') },
    { value: 'game', label: t('worldWorkspace.context.consumer.game') },
  ]

  return (
    <div data-testid="context-selection" className="space-y-3 text-sm">
      {/* consumer 可信边界：仅写作/游戏。 */}
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-[var(--nova-text-muted)]">
          {t('worldWorkspace.context.consumerLabel')}
        </legend>
        <div data-testid="context-consumer" className="inline-flex rounded-[var(--radius-md)] border border-[var(--nova-border)] p-0.5" role="group">
          {consumers.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={consumer === c.value}
              onClick={() => onConsumerChange(c.value)}
              className={cn(
                'rounded-[var(--radius-sm)] px-3 py-1 text-xs transition-colors',
                consumer === c.value ? 'bg-[var(--nova-active)] text-[var(--nova-active-text)]' : 'text-[var(--nova-text-muted)] hover:bg-[var(--nova-surface-2)]',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </fieldset>

      {/* 叙事基调（布尔开关；无基调时给出空态说明）。 */}
      <section className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
        <CheckRow
          checked={selection.includeTone}
          label={t('worldWorkspace.console.tone')}
          detail={tone ? undefined : t('worldWorkspace.context.toneEmpty')}
          onToggle={() => patch({ includeTone: !selection.includeTone })}
        />
      </section>

      {/* 世界规则：按索引选择，不存正文；空集合显示空态。 */}
      <OptionGroup
        title={t('worldWorkspace.console.rules')}
        options={rules.map((rule, i) => ({ id: String(i), label: rule.trim() ? rule.trim() : `#${i + 1}` }))}
        selectedIds={selection.ruleIndexes.map(String)}
        overflow={overflowByKey.get('ruleIndexes')}
        onToggle={(id) => patch({ ruleIndexes: toggleRuleIndex(selection.ruleIndexes, Number(id)) })}
        onSelectAll={() => patch({ ruleIndexes: rules.map((_, i) => i) })}
        onClear={() => patch({ ruleIndexes: [] })}
        emptyText={t('worldWorkspace.context.emptyRules')}
      />

      <OptionGroup
        title={t('worldWorkspace.characters')}
        options={characters}
        selectedIds={selection.characterIds}
        overflow={overflowByKey.get('characterIds')}
        onToggle={(id) => toggleIdKey('characterIds', id)}
        onSelectAll={() => setAll('characterIds', characters.map((o) => o.id))}
        onClear={() => patch({ characterIds: [] })}
        emptyText={t('worldWorkspace.context.emptyCharacters')}
      />
      <OptionGroup
        title={t('worldWorkspace.locations')}
        options={locations}
        selectedIds={selection.locationIds}
        overflow={overflowByKey.get('locationIds')}
        onToggle={(id) => toggleIdKey('locationIds', id)}
        onSelectAll={() => setAll('locationIds', locations.map((o) => o.id))}
        onClear={() => patch({ locationIds: [] })}
        emptyText={t('worldWorkspace.context.emptyLocations')}
      />
      <OptionGroup
        title={t('worldWorkspace.factions')}
        options={factions}
        selectedIds={selection.factionIds}
        overflow={overflowByKey.get('factionIds')}
        onToggle={(id) => toggleIdKey('factionIds', id)}
        onSelectAll={() => setAll('factionIds', factions.map((o) => o.id))}
        onClear={() => patch({ factionIds: [] })}
        emptyText={t('worldWorkspace.context.emptyFactions')}
      />
      <OptionGroup
        title={t('worldWorkspace.timeline')}
        options={timeline}
        selectedIds={selection.timelineEntryIds}
        overflow={overflowByKey.get('timelineEntryIds')}
        onToggle={(id) => toggleIdKey('timelineEntryIds', id)}
        onSelectAll={() => setAll('timelineEntryIds', timeline.map((o) => o.id))}
        onClear={() => patch({ timelineEntryIds: [] })}
        emptyText={t('worldWorkspace.context.emptyTimeline')}
      />
      <OptionGroup
        title={t('worldWorkspace.context.worldBindings')}
        options={materials}
        selectedIds={selection.bindingIds}
        overflow={overflowByKey.get('bindingIds')}
        onToggle={(id) => toggleIdKey('bindingIds', id)}
        onSelectAll={() => setAll('bindingIds', materials.map((o) => o.id))}
        onClear={() => patch({ bindingIds: [] })}
        emptyText={t('worldWorkspace.context.emptyMaterials')}
      />

      {isIdentityOnlySelection(selection) ? (
        <p data-testid="context-selection-identity-only" className="text-xs text-[var(--nova-text-muted)]">
          {t('worldWorkspace.context.identityOnly')}
        </p>
      ) : null}
      {totalOverflow ? (
        <p data-testid="context-selection-total-overflow" className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">
          {t('worldWorkspace.context.overflow', {
            label: t('worldWorkspace.context.totalSelection'),
            count: totalOverflow.count,
            max: MAX_SELECTED_TOTAL,
          })}
        </p>
      ) : null}
    </div>
  )
}

/** 单行复选项：长名称截断，窄屏可换行布局。 */
function CheckRow({ checked, label, detail, onToggle }: {
  checked: boolean
  label: string
  detail?: string
  onToggle: () => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs">
      <input type="checkbox" className="mt-0.5 shrink-0" checked={checked} onChange={onToggle} />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {detail ? <span className="block text-[var(--nova-text-muted)]">{detail}</span> : null}
      </span>
    </label>
  )
}

function OptionGroup({ title, options, selectedIds, overflow, onToggle, onSelectAll, onClear, emptyText }: {
  title: string
  options: Option[]
  selectedIds: string[]
  overflow?: { count: number; max: number }
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  emptyText: string
}) {
  const { t } = useTranslation()
  const selected = new Set(selectedIds)
  const allSelected = options.length > 0 && options.every((o) => selected.has(o.id))

  let headerActions: ReactNode = null
  if (options.length > 0) {
    headerActions = allSelected ? (
      <button type="button" className="text-[var(--nova-text-muted)] underline-offset-2 hover:underline" onClick={onClear}>
        {t('worldWorkspace.context.clearSection')}
      </button>
    ) : (
      <button type="button" className="text-[var(--nova-text-muted)] underline-offset-2 hover:underline" onClick={onSelectAll}>
        {t('worldWorkspace.context.selectAll')}
      </button>
    )
  }

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{title}</span>
        {headerActions}
      </div>
      {overflow ? (
        <p data-testid="context-selection-overflow" className="mb-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">
          {t('worldWorkspace.context.overflow', { label: title, count: overflow.count, max: overflow.max })}
        </p>
      ) : null}
      {options.length === 0 ? (
        <p className="text-[11px] text-[var(--nova-text-muted)]">{emptyText}</p>
      ) : (
        <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
          {options.map((o) => (
            <li key={o.id}>
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={selected.has(o.id)}
                  aria-label={o.label}
                  onChange={() => onToggle(o.id)}
                />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 供页面在发请求前判断“生成预览”是否应被禁用（超限或正在加载）。 */
export function selectionBlocksPreview(selection: Selection): boolean {
  return findSelectionOverflow(selection).length > 0
}

/** re-export 便于测试与页面共用同一上限真源。 */
export { SELECTION_LIMITS }
