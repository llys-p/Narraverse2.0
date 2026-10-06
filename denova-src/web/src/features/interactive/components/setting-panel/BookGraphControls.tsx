import type { Dispatch, SetStateAction } from 'react'
import { RotateCcw, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LoreItem } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { presetActionButtonClassName as actionButtonClassName } from '../preset-config/editor-styles'
import { loreTypeLabel } from './editor-shared'
import { CHARACTER_TIER_FILTERS, GRAPH_TYPE_ORDER, TYPE_COLORS } from './book-graph-model'
import type { CharacterTierFilter, LoreGraph, LoreGraphNode } from './book-graph-model'

interface Props {
  items: LoreItem[]
  graph: LoreGraph
  baseNodes: LoreGraphNode[]
  query: string
  setQuery: (query: string) => void
  hidden: ReadonlySet<string>
  setHidden: Dispatch<SetStateAction<ReadonlySet<string>>>
  characterTierFilter: CharacterTierFilter
  setCharacterTierFilter: (filter: CharacterTierFilter) => void
  showInferred: boolean
  setShowInferred: (show: boolean) => void
  relationLabel: string | null
  setRelationLabel: (label: string | null) => void
  relationLabels: string[]
  focusId: string | null
  setFocusId: (id: string | null) => void
  depth: 1 | 2
  setDepth: (depth: 1 | 2) => void
  spacing: number
  setSpacing: (spacing: number) => void
  fullscreen: boolean
  onFullscreen: () => void
  onOpenItem?: (id: string) => void
  handleReset: () => void
}
export function BookGraphControls({
  items, graph, baseNodes, query, setQuery, hidden, setHidden, characterTierFilter, setCharacterTierFilter,
  showInferred, setShowInferred, relationLabel, setRelationLabel, relationLabels, focusId, setFocusId,
  depth, setDepth, spacing, setSpacing, fullscreen, onFullscreen, onOpenItem, handleReset,
}: Props) {
  const { t } = useTranslation()
  const visibleEdges = graph.edges
  const stats = t('settingPanel.bookOverview.graphStats', { nodes: graph.nodes.length, edges: graph.edges.length })
  return (
      <aside className="flex w-full max-h-56 shrink-0 flex-col gap-3 overflow-y-auto border-b border-[var(--nova-border)] p-3 md:max-h-none md:w-56 md:border-r md:border-b-0">
        <div className="nova-field flex h-8 items-center gap-2 rounded-[var(--nova-radius)] px-2 text-xs text-[var(--nova-text-faint)]">
          <Search className="h-3.5 w-3.5" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[var(--nova-text-muted)] outline-none placeholder:text-[var(--nova-text-faint)]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settingPanel.bookOverview.graphSearch')}
            aria-label={t('settingPanel.bookOverview.graphSearch')}
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-[var(--nova-text-muted)]">
          <input type="checkbox" checked={showInferred} onChange={(event) => setShowInferred(event.target.checked)} />
          {t('settingPanel.bookOverview.graphShowInferred')}
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
          {t('settingPanel.bookOverview.graphRelationType')}
          <select className="nova-field h-8 w-full rounded px-2" value={relationLabel ?? ''} onChange={(event) => setRelationLabel(event.target.value || null)}>
            <option value="">{t('settingPanel.bookOverview.graphAllRelations')}</option>
            {relationLabels.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
          {t('settingPanel.bookOverview.graphLocalCenter')}
          <select className="nova-field h-8 w-full rounded px-2" value={focusId ?? ''} onChange={(event) => setFocusId(event.target.value || null)}>
            <option value="">{t('settingPanel.bookOverview.graphFullGraph')}</option>
            {baseNodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
          </select>
        </label>
        {focusId && <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
            {t('settingPanel.bookOverview.graphDepth')}
            <select className="nova-field h-8 rounded px-2" value={depth} onChange={(event) => setDepth(Number(event.target.value) as 1 | 2)}>
              <option value={1}>{t('settingPanel.bookOverview.graphOneHop')}</option>
              <option value={2}>{t('settingPanel.bookOverview.graphTwoHops')}</option>
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={() => setFocusId(null)}>{t('settingPanel.bookOverview.graphReturnFull')}</Button>
          {onOpenItem && <Button variant="outline" size="sm" onClick={() => onOpenItem(focusId)}>{t('settingPanel.bookOverview.graphOpenCenter')}</Button>}
        </div>}
        <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
          {t('settingPanel.bookOverview.graphSpacing')}
          <input type="range" min="0.7" max="2" step="0.1" value={spacing} onChange={(event) => setSpacing(Number(event.target.value))} />
        </label>
        {!fullscreen && <Button variant="outline" size="sm" onClick={onFullscreen}>{t('settingPanel.bookOverview.graphFullscreen')}</Button>}

        <div className="flex flex-col gap-0.5">
          <p className="mb-1 text-[11px] text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.graphFilterTitle')}</p>
          <label className="mb-2 flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
            <span>{t('settingPanel.characterTier.graphFilter')}</span>
            <Select value={characterTierFilter} onValueChange={(value) => setCharacterTierFilter(value as CharacterTierFilter)}>
              <SelectTrigger aria-label={t('settingPanel.characterTier.graphFilter')} className="nova-field h-8 w-full text-xs focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="nova-panel border text-[var(--nova-text)]">
                {CHARACTER_TIER_FILTERS.map((filter) => (
                  <SelectItem key={filter} value={filter}>{t(`settingPanel.characterTier.${filter}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {GRAPH_TYPE_ORDER.map((type) => {
            const count = items.filter((item) => item.type === type).length
            if (!count) return null
            const checked = !hidden.has(type)
            return (
              <label
                key={type}
                className="flex min-h-7 cursor-pointer items-center gap-2 rounded px-1 text-xs text-[var(--nova-text-muted)] hover:bg-[var(--nova-hover)]"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--nova-accent)]"
                  checked={checked}
                  onChange={() => {
                    setHidden((current) => {
                      const next = new Set(current)
                      if (next.has(type)) next.delete(type)
                      else next.add(type)
                      return next
                    })
                  }}
                  aria-label={loreTypeLabel(type, t)}
                />
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                <span className="min-w-0 flex-1 truncate">{loreTypeLabel(type, t)}</span>
                <span className="text-[11px] text-[var(--nova-text-faint)]">{count}</span>
              </label>
            )
          })}
        </div>


        <div className="mt-auto flex flex-col gap-2">
          <p className="text-[11px] leading-5 text-[var(--nova-text-faint)]">{stats}</p>
          <p className="text-[11px] leading-5 text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.graphHint')}</p>
          <ul className="sr-only" role="list" aria-label={t('settingPanel.bookOverview.graphRelationList')}>
            {visibleEdges.map((edge, index) => {
              const source = graph.nodes.find((node) => node.id === edge.source)
              const target = graph.nodes.find((node) => node.id === edge.target)
              if (!source || !target) return null
              return (
                <li key={edge.id || `${edge.source}-${edge.target}-${index}`}>
                  {edge.confirmed
                    ? t('settingPanel.bookOverview.graphConfirmedRelation', { source: source.name, target: target.name, label: edge.label })
                    : t('settingPanel.bookOverview.graphDerivedRelation', { source: source.name, target: target.name })}
                  {edge.note ? ` — ${edge.note}` : ''}
                </li>
              )
            })}
          </ul>
          <Button className={actionButtonClassName} variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw data-icon="inline-start" />
            {t('settingPanel.bookOverview.graphResetView')}
          </Button>
        </div>
      </aside>
  )
}
