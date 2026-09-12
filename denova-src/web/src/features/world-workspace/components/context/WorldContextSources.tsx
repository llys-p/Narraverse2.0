import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { World } from '../../types'
import {
  sourceKindSection,
  type ContextPreviewSource,
  type WorldConsoleSectionId,
} from '../../world-context'

/**
 * Phase 3.1B2：sourceTable 来源定位。
 *
 * - 只把已知 source kind 映射到“现有控制台分区”，点击仅切换分区（onJumpSection），
 *   不读取 Master 详情、不发任何健康/网络请求；
 * - 未知 kind 安全降级为不可跳转的中性条目，绝不通过 default 冒充已知状态；
 * - 主文案使用实体/资料名称，内部 ID 不作为主文案。
 */
interface WorldContextSourcesProps {
  sourceTable: Record<string, ContextPreviewSource>
  world: World
  onJumpSection: (section: WorldConsoleSectionId) => void
}

export function WorldContextSources({ sourceTable, world, onJumpSection }: WorldContextSourcesProps) {
  const { t } = useTranslation()
  const entries = Object.entries(sourceTable)

  const sourceLabel = (kind: string) => t(`worldWorkspace.context.source.${sourceKindSection(kind) ? kind : 'unknown'}`)

  const resolveName = (src: ContextPreviewSource): string => {
    if (src.entityId) {
      const c = world.characters.find((x) => x.id === src.entityId)
      if (c) return c.displayName || sourceLabel(src.kind)
      const l = world.locations.find((x) => x.id === src.entityId)
      if (l) return l.name || sourceLabel(src.kind)
      const f = world.factions.find((x) => x.id === src.entityId)
      if (f) return f.name || sourceLabel(src.kind)
    }
    if (src.bindingId) {
      const b = world.bindings.find((x) => x.bindingId === src.bindingId)
      if (b) return b.nameSnapshot || sourceLabel(src.kind)
    }
    if (src.fieldPath) return src.fieldPath
    return sourceLabel(src.kind)
  }

  if (entries.length === 0) return null

  return (
    <section data-testid="context-sources" className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
      <h5 className="mb-1.5 text-xs font-medium">{t('worldWorkspace.context.sourcesTitle')}</h5>
      <ul className="space-y-1">
        {entries.map(([key, src]) => {
          const section = sourceKindSection(src.kind)
          const name = resolveName(src)
          const kindLabel = sourceLabel(src.kind)
          let action: ReactNode
          if (section) {
            action = (
              <button
                type="button"
                className="text-[var(--nova-accent)] underline-offset-2 hover:underline"
                aria-label={t('worldWorkspace.context.sourceJump', { label: kindLabel })}
                onClick={() => onJumpSection(section)}
              >
                {kindLabel}
              </button>
            )
          } else {
            // 未知 kind：中性、不可跳转，不假装知道它属于哪个分区。
            action = <span className="text-[var(--nova-text-muted)]">{kindLabel}</span>
          }
          return (
            <li key={key} data-source-kind={src.kind} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">{name}</span>
              {action}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
