import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { World } from '../../types'
import { WorldContextSources } from './WorldContextSources'
import {
  isKnownOmissionKind,
  isKnownOmissionReason,
  isKnownWarningCode,
  shortFingerprint,
  type ContextPreviewState,
  type ContextPreviewOmission,
  type ContextPreviewWarning,
  type WorldConsoleSectionId,
  type WorldContextUIView,
} from '../../world-context'

/**
 * Phase 3.1B2：ready/stale 的只读分段详情（组合/布局职责）。
 *
 * - 分段展示 Identity/Setting/Characters/Locations/Factions/Timeline/Materials，
 *   以及 canonicalSelection、stats、短 fingerprint、可读 omissions/warnings、来源定位；
 * - 不复制 WorldContextPreviewResult 的状态处理（idle/loading/error 由 Panel 交给它）；
 * - 绝不渲染 ModelView/prompt/sourceRef/runSalt/runContextId/scopeKey，内部 ID 不作为主文案；
 * - 不发任何 Master 详情或模型请求。
 */
interface WorldContextPreviewProps {
  view: WorldContextUIView
  state: Extract<ContextPreviewState, 'ready' | 'stale'>
  world: World
  onJumpSection: (section: WorldConsoleSectionId) => void
}

export function WorldContextPreview({ view, state, world, onJumpSection }: WorldContextPreviewProps) {
  const { t } = useTranslation()

  const resolveEntityName = (id?: string): string => {
    const unknown = t('worldWorkspace.context.source.unknown')
    if (!id) return unknown
    const c = world.characters.find((x) => x.id === id)
    if (c) return c.displayName || unknown
    const l = world.locations.find((x) => x.id === id)
    if (l) return l.name || unknown
    const f = world.factions.find((x) => x.id === id)
    if (f) return f.name || unknown
    // 闭包省略项可能指向未随本次预览返回的实体；内部 ID 不能降级为主文案。
    return unknown
  }

  const canonical = view.canonicalSelection
  const chips: string[] = []
  if (canonical.includeTone) chips.push(t('worldWorkspace.console.tone'))
  if (canonical.ruleIndexes.length) chips.push(`${t('worldWorkspace.console.rules')} ×${canonical.ruleIndexes.length}`)
  if (canonical.characterIds.length) chips.push(`${t('worldWorkspace.characters')} ×${canonical.characterIds.length}`)
  if (canonical.locationIds.length) chips.push(`${t('worldWorkspace.locations')} ×${canonical.locationIds.length}`)
  if (canonical.factionIds.length) chips.push(`${t('worldWorkspace.factions')} ×${canonical.factionIds.length}`)
  if (canonical.timelineEntryIds.length) chips.push(`${t('worldWorkspace.timeline')} ×${canonical.timelineEntryIds.length}`)
  if (canonical.bindingIds.length) chips.push(`${t('worldWorkspace.console.materials')} ×${canonical.bindingIds.length}`)

  const stats = view.stats

  return (
    <div data-testid="context-preview-detail" className="space-y-3 text-sm">
      {state === 'stale' ? (
        <p data-testid="context-preview-stale-banner" className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          {t('worldWorkspace.contextPreview.stale')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-[var(--radius-md)] bg-[var(--nova-surface-2)] px-2 py-0.5 font-mono" data-testid="context-fingerprint">
          {t('worldWorkspace.context.fingerprint')}: {shortFingerprint(view.contextFingerprint)}
        </span>
        <span className="text-[var(--nova-text-muted)]" data-testid="context-stats">
          {t('worldWorkspace.context.statsTitle')}: {stats.characterCount}/{stats.locationCount}/{stats.factionCount}/{stats.timelineCount}/{stats.materialCount}
        </span>
      </div>

      <section className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
        <h5 className="mb-1 text-xs font-medium">{t('worldWorkspace.context.canonicalTitle')}</h5>
        {chips.length === 0 ? (
          <p className="text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.selectedEmpty')}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <span key={chip} className="rounded-[var(--radius-md)] bg-[var(--nova-surface-2)] px-2 py-0.5 text-[11px]">{chip}</span>
            ))}
          </div>
        )}
      </section>

      <Segment title={t('worldWorkspace.contextPreview.identityTitle')}>
        <div className="text-sm font-medium">{view.identity.name}</div>
        {view.identity.tagline ? <div className="text-xs text-[var(--nova-text-muted)]">{view.identity.tagline}</div> : null}
        {view.identity.genre ? <Field text={view.identity.genre} muted /> : null}
        {view.identity.summary ? <Field text={view.identity.summary} /> : null}
      </Segment>

      <Segment
        title={t('worldWorkspace.console.setting')}
        empty={!view.setting || ((!view.setting.tone) && view.setting.rules.length === 0)}
        emptyLabel={t('worldWorkspace.context.segmentEmpty', { label: t('worldWorkspace.console.setting') })}
      >
        {view.setting?.tone ? <Field text={view.setting.tone} muted /> : null}
        {view.setting && view.setting.rules.length ? <BulletList items={view.setting.rules} /> : null}
      </Segment>

      <Segment title={t('worldWorkspace.characters')} empty={view.characters.length === 0} emptyLabel={t('worldWorkspace.context.segmentEmpty', { label: t('worldWorkspace.characters') })}>
        {view.characters.map((c) => (
          <div key={c.id} className="rounded border border-[var(--nova-border)] p-2 text-xs">
            <div className="font-medium">{c.displayName}</div>
            {c.role ? <div className="text-[var(--nova-text-muted)]">{c.role}</div> : null}
            {c.worldNote ? <p>{c.worldNote}</p> : null}
            {c.relationships.length ? (
              <ul className="mt-1 list-disc pl-4 text-[var(--nova-text-muted)]">
                {c.relationships.map((r, i) => (
                  <li key={`${r.targetCharacterId}-${i}`}>
                    {r.label ? `${r.label}: ` : ''}{resolveEntityName(r.targetCharacterId)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </Segment>

      <Segment title={t('worldWorkspace.locations')} empty={view.locations.length === 0} emptyLabel={t('worldWorkspace.context.segmentEmpty', { label: t('worldWorkspace.locations') })}>
        {view.locations.map((l) => (
          <div key={l.id} className="text-xs">
            <span className="font-medium">{l.name}</span>
            {l.description ? <p className="text-[var(--nova-text-muted)]">{l.description}</p> : null}
            {l.tags.length ? <p className="text-[10px] text-[var(--nova-text-muted)]">[{l.tags.join(', ')}]</p> : null}
          </div>
        ))}
      </Segment>

      <Segment title={t('worldWorkspace.factions')} empty={view.factions.length === 0} emptyLabel={t('worldWorkspace.context.segmentEmpty', { label: t('worldWorkspace.factions') })}>
        {view.factions.map((f) => (
          <div key={f.id} className="text-xs">
            <span className="font-medium">{f.name}</span>
            {f.description ? <p className="text-[var(--nova-text-muted)]">{f.description}</p> : null}
          </div>
        ))}
      </Segment>

      <Segment title={t('worldWorkspace.timeline')} empty={view.timeline.length === 0} emptyLabel={t('worldWorkspace.context.segmentEmpty', { label: t('worldWorkspace.timeline') })}>
        <ol className="list-decimal pl-4 text-xs">
          {[...view.timeline].sort((a, b) => a.order - b.order).map((e) => (
            <li key={e.id}>
              {e.eraLabel ? <span className="text-[var(--nova-text-muted)]">{e.eraLabel} · </span> : null}
              <span className="font-medium">{e.title}</span>
              <span className="ml-1 rounded bg-[var(--nova-surface-2)] px-1 text-[10px]">{e.category}</span>
              {e.description ? <span className="text-[var(--nova-text-muted)]"> — {e.description}</span> : null}
            </li>
          ))}
        </ol>
      </Segment>

      <Segment title={t('worldWorkspace.console.materials')} empty={view.materials.length === 0} emptyLabel={t('worldWorkspace.context.segmentEmpty', { label: t('worldWorkspace.console.materials') })}>
        {view.materials.map((m) => (
          <div key={m.bindingId} className="text-xs">
            <span className="font-medium">{m.name}</span>
            {m.tags.length ? <span className="ml-1 text-[var(--nova-text-muted)]">[{m.tags.join(', ')}]</span> : null}
          </div>
        ))}
      </Segment>

      <OmissionList omissions={view.omissions} resolveName={resolveEntityName} />
      <WarningList warnings={view.warnings} />
      <WorldContextSources sourceTable={view.sourceTable} world={world} onJumpSection={onJumpSection} />
    </div>
  )
}

function Segment({ title, empty = false, emptyLabel, children }: {
  title: string
  empty?: boolean
  emptyLabel?: string
  children?: ReactNode
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
      <h5 className="mb-1.5 text-xs font-medium">{title}</h5>
      {empty ? <p className="text-[11px] text-[var(--nova-text-muted)]">{emptyLabel}</p> : <div className="space-y-1">{children}</div>}
    </section>
  )
}

function Field({ text, muted = false }: { text: string; muted?: boolean }) {
  return <p className={muted ? 'text-xs text-[var(--nova-text-muted)]' : 'text-xs leading-relaxed'}>{text}</p>
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-4 text-xs">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  )
}

function OmissionList({ omissions, resolveName }: {
  omissions: ContextPreviewOmission[]
  resolveName: (id?: string) => string
}) {
  const { t } = useTranslation()
  return (
    <section data-testid="context-omissions" className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
      <h5 className="mb-1.5 text-xs font-medium">{t('worldWorkspace.contextPreview.omissionsTitle')}</h5>
      {omissions.length === 0 ? (
        <p className="text-[11px] text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.omissionsEmpty')}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {omissions.map((o, i) => {
            const owner = resolveName(o.ownerEntityId)
            const missing = resolveName(o.missingEntityId)
            const relationKey = isKnownOmissionKind(o.kind) ? o.kind : 'unknown'
            const reasonKey = isKnownOmissionReason(o.reason) ? o.reason : 'target_not_selected'
            return (
              <li key={i} data-omission-kind={o.kind}>
                {t(`worldWorkspace.context.omission.${relationKey}`, { owner, missing })}
                <span className="ml-1 text-[var(--nova-text-muted)]">
                  （{t(`worldWorkspace.context.omission.reason.${reasonKey}`)}）
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function WarningList({ warnings }: { warnings: ContextPreviewWarning[] }) {
  const { t } = useTranslation()
  return (
    <section data-testid="context-warnings" className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2.5">
      <h5 className="mb-1.5 text-xs font-medium">{t('worldWorkspace.contextPreview.warningsTitle')}</h5>
      {warnings.length === 0 ? (
        <p className="text-[11px] text-[var(--nova-text-muted)]">{t('worldWorkspace.contextPreview.warningsEmpty')}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {warnings.map((w, i) => {
            // 未知 code 安全降级为中性提示，绝不通过 default 冒充已知状态。
            const text = isKnownWarningCode(w.code)
              ? t(`worldWorkspace.context.warning.${w.code}`)
              : t('worldWorkspace.context.warning.unknown', { code: w.code })
            return <li key={i} data-warning-code={w.code}>{text}</li>
          })}
        </ul>
      )}
    </section>
  )
}
