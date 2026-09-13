/**
 * Phase 3.1A2：World Context Preview 的唯一 wire 类型来源。
 *
 * 冻结边界（见 docs/plans/WORLD_WORKSPACE_PHASE3_1_WORLD_CONSOLE_IMPLEMENTATION_PLAN.md §3/§5）：
 *   - 这里的类型只描述 `POST /api/worlds/:id/context-preview` 的请求/响应传输结构，
 *     逐字段对齐后端 handler_world_context_preview.go 的 camelCase DTO；
 *   - 不复制 World 实体模型（World/WorldCharacter 等仍只来自 ./types）；
 *   - 不出现 ModelView / ProjectionBody / sourceRef / runSalt / runContext / sidecar
 *     等运行态字段——后端不下发，前端也不展示；
 *   - selection/preview 只允许存在于组件内存中，禁止写入 localStorage/sessionStorage/IndexedDB
 *     或进入 Zustand 全局 store。
 */

import type { World } from './types'

/** 可信 consumer：当前阶段仅写作/游戏；narraverse/module4 由后端直接拒绝（403）。 */
export type WorldContextConsumer = 'writing' | 'game'

/** 选择器 wire 形态（严格 camelCase，白名单字段），请求与 canonicalSelection 共用同一形状。 */
export interface WorldContextSelection {
  includeTone: boolean
  ruleIndexes: number[]
  characterIds: string[]
  locationIds: string[]
  factionIds: string[]
  timelineEntryIds: string[]
  bindingIds: string[]
}

/** POST /api/worlds/:id/context-preview 请求体；故意不含 worldId（path :id 是唯一来源）。 */
export interface PreviewWorldContextRequest {
  consumer: WorldContextConsumer
  expectedWorldRevision: string
  selection: WorldContextSelection
}

export interface ContextPreviewIdentity {
  name: string
  tagline?: string
  genre?: string
  summary?: string
}

export interface ContextPreviewSetting {
  tone?: string
  rules: string[]
}

export interface ContextPreviewRelationship {
  targetCharacterId: string
  label: string
}

export interface ContextPreviewCharacter {
  id: string
  displayName: string
  role?: string
  worldNote?: string
  factionId?: string
  locationId?: string
  relationships: ContextPreviewRelationship[]
}

export interface ContextPreviewLocation {
  id: string
  name: string
  description?: string
  tags: string[]
}

export interface ContextPreviewFaction {
  id: string
  name: string
  description?: string
  influence?: number
  stability?: number
  headquartersLocationId?: string
}

export interface ContextPreviewTimelineEntry {
  id: string
  order: number
  eraLabel?: string
  title: string
  description?: string
  category: string
}

export interface ContextPreviewMaterial {
  bindingId: string
  masterItemId: string
  name: string
  tags: string[]
  semanticType: string
  scope: string
}

/** 闭包省略类型（冻结枚举）。 */
export type ContextPreviewOmissionKind =
  | 'character_faction'
  | 'character_location'
  | 'faction_headquarters'
  | 'relationship_edge'

/** 闭包省略原因（冻结枚举）。 */
export type ContextPreviewOmissionReason = 'target_not_selected' | 'target_cascaded_removed'

export interface ContextPreviewOmission {
  kind: ContextPreviewOmissionKind | string
  ownerEntityId: string
  missingEntityId: string
  reason: ContextPreviewOmissionReason | string
}

export interface ContextPreviewWarning {
  code: string
  refKind?: string
  refId?: string
}

export interface ContextPreviewStats {
  characterCount: number
  locationCount: number
  factionCount: number
  timelineCount: number
  materialCount: number
}

export interface ContextPreviewSource {
  kind: string
  entityId?: string
  bindingId?: string
  masterItemId?: string
  fieldPath?: string
}

/** 200 响应 `preview` 字段的完整形状（UI Projection，只读派生数据）。 */
export interface WorldContextUIView {
  schemaVersion: number
  worldId: string
  worldRevision: string
  consumer: WorldContextConsumer | string
  contextFingerprint: string
  canonicalSelection: WorldContextSelection
  identity: ContextPreviewIdentity
  setting?: ContextPreviewSetting
  characters: ContextPreviewCharacter[]
  locations: ContextPreviewLocation[]
  factions: ContextPreviewFaction[]
  timeline: ContextPreviewTimelineEntry[]
  materials: ContextPreviewMaterial[]
  omissions: ContextPreviewOmission[]
  warnings: ContextPreviewWarning[]
  stats: ContextPreviewStats
  /** 来源表 A2 仅随响应保真携带，不做跳转导航（来源可视化属 3.1B2）。 */
  sourceTable: Record<string, ContextPreviewSource>
  revisionLabel: string
  isDraftPreview: boolean
}

/** POST 响应信封。 */
export interface WorldContextPreviewEnvelope {
  preview: WorldContextUIView
}

/**
 * 预览请求状态命名隔离（计划 §4.5）：只允许 idle/loading/ready/stale/error，
 * 禁止 none/bound/active/degraded（那是 Phase 3.2 运行态词汇）。
 */
export type ContextPreviewState = 'idle' | 'loading' | 'ready' | 'stale' | 'error'

/**
 * 初始空选择器：identity 由服务端始终包含，其余（基调/规则/实体/时间线/world 资料）默认不选。
 * 这里只提供空工厂；上限预检、不可静默截断等纯函数属于 3.1B1，不在 A2 引入。
 */
export function emptyContextSelection(): WorldContextSelection {
  return {
    includeTone: false,
    ruleIndexes: [],
    characterIds: [],
    locationIds: [],
    factionIds: [],
    timelineEntryIds: [],
    bindingIds: [],
  }
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Reprojects a session-only Selection against the current World draft.
 * Deleted entities/materials/timeline entries and out-of-range rule indexes
 * disappear from the selection instead of becoming invisible invalid IDs.
 */
export function pruneContextSelection(selection: WorldContextSelection, world: World): WorldContextSelection {
  const rulesLength = world.worldSetting?.rules.length ?? 0
  const characterIds = new Set(world.characters.map((item) => item.id))
  const locationIds = new Set(world.locations.map((item) => item.id))
  const factionIds = new Set(world.factions.map((item) => item.id))
  const timelineEntryIds = new Set(world.timeline.map((item) => item.id))
  const bindingIds = new Set(world.bindings.map((item) => item.bindingId))
  const next = {
    ruleIndexes: selection.ruleIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < rulesLength),
    characterIds: selection.characterIds.filter((id) => characterIds.has(id)),
    locationIds: selection.locationIds.filter((id) => locationIds.has(id)),
    factionIds: selection.factionIds.filter((id) => factionIds.has(id)),
    timelineEntryIds: selection.timelineEntryIds.filter((id) => timelineEntryIds.has(id)),
    bindingIds: selection.bindingIds.filter((id) => bindingIds.has(id)),
  }
  if (
    sameArray(next.ruleIndexes, selection.ruleIndexes)
    && sameArray(next.characterIds, selection.characterIds)
    && sameArray(next.locationIds, selection.locationIds)
    && sameArray(next.factionIds, selection.factionIds)
    && sameArray(next.timelineEntryIds, selection.timelineEntryIds)
    && sameArray(next.bindingIds, selection.bindingIds)
  ) return selection
  return { ...selection, ...next }
}

/** Keeps position-based rule selections attached to the same remaining rules after one deletion. */
export function remapSelectionAfterRuleRemoval(
  selection: WorldContextSelection,
  removedIndex: number,
): WorldContextSelection {
  if (!selection.ruleIndexes.some((index) => index >= removedIndex)) return selection
  return {
    ...selection,
    ruleIndexes: selection.ruleIndexes.flatMap((index) => {
      if (index === removedIndex) return []
      return [index > removedIndex ? index - 1 : index]
    }),
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Phase 3.1B1：与后端 worldcontext.DecodeSelection 冻结契约一致的前端纯函数（不复制后端领域类型）。 */
/* --------------------------------------------------------------------------------------------- */

/**
 * 各类选择数量上限，必须与后端 internal/worldcontext/selection.go 的常量逐一对齐：
 * ruleIndexes 50、character/location/faction/binding 各 20、timeline 30。
 * 后端是最终裁决；这里只做发请求前的同源预检。
 */
export const SELECTION_LIMITS = {
  ruleIndexes: 50,
  characterIds: 20,
  locationIds: 20,
  factionIds: 20,
  timelineEntryIds: 30,
  bindingIds: 20,
} as const

/** 后端 worldcontext.BuildSnapshot 的跨分区对象总量上限。 */
export const MAX_SELECTED_TOTAL = 60

/** 参与数量上限的字段（includeTone 是布尔开关，不设数量上限）。 */
export type SelectionLimitKey = keyof typeof SELECTION_LIMITS

export interface SelectionOverflow {
  key: SelectionLimitKey | 'total'
  count: number
  max: number
}

const SELECTION_LIST_KEYS: SelectionLimitKey[] = [
  'ruleIndexes', 'characterIds', 'locationIds', 'factionIds', 'timelineEntryIds', 'bindingIds',
]

/**
 * 数量预检：返回所有超限项。只报告、不修改入参——前端绝不静默截断选择，
 * 超限由 UI 明确提示并阻止发请求，服务端仍会独立拒绝。
 */
export function findSelectionOverflow(selection: WorldContextSelection): SelectionOverflow[] {
  const overflows: SelectionOverflow[] = []
  for (const key of SELECTION_LIST_KEYS) {
    const count = selection[key].length
    const max = SELECTION_LIMITS[key]
    if (count > max) overflows.push({ key, count, max })
  }
  const total = SELECTION_LIST_KEYS.reduce((sum, key) => sum + selection[key].length, 0)
  if (total > MAX_SELECTED_TOTAL) overflows.push({ key: 'total', count: total, max: MAX_SELECTED_TOTAL })
  return overflows
}

/** 选择是否全部处于冻结上限内（includeTone 为布尔，不参与数量检查）。 */
export function isSelectionWithinLimits(selection: WorldContextSelection): boolean {
  return findSelectionOverflow(selection).length === 0
}

/** 在字符串 id 列表中切换某项：已选则移除，未选则去重保序追加；纯函数，不做数量截断。 */
export function toggleSelectionId(list: readonly string[], id: string): string[] {
  if (list.includes(id)) return list.filter((item) => item !== id)
  return [...list, id]
}

/** 切换规则下标（规则以 World 内下标标识，绝不存规则正文）；纯函数。 */
export function toggleRuleIndex(list: readonly number[], index: number): number[] {
  if (list.includes(index)) return list.filter((item) => item !== index)
  return [...list, index].sort((a, b) => a - b)
}

/** 是否每一类都为空（identity 永远由服务端包含，不计入）。 */
export function isIdentityOnlySelection(selection: WorldContextSelection): boolean {
  return !selection.includeTone
    && selection.ruleIndexes.length === 0
    && selection.characterIds.length === 0
    && selection.locationIds.length === 0
    && selection.factionIds.length === 0
    && selection.timelineEntryIds.length === 0
    && selection.bindingIds.length === 0
}

/* --------------------------------------------------------------------------------------------- */
/* Phase 3.1B2：来源分区映射、省略/警告已知词表与指纹短标签（纯函数，未知值安全降级、绝不冒充已知）。 */
/* --------------------------------------------------------------------------------------------- */

/** World Console 现有分区 id（context 是新增的第八分区，来源不会跳到它自己）。 */
export type WorldConsoleSectionId =
  | 'overview' | 'setting' | 'characters' | 'locations' | 'factions' | 'materials' | 'history' | 'context'

const SOURCE_KIND_SECTION: Record<string, WorldConsoleSectionId> = {
  identity: 'overview',
  setting: 'setting',
  character: 'characters',
  location: 'locations',
  faction: 'factions',
  timeline: 'history',
  material: 'materials',
}

/**
 * sourceTable.kind → 现有控制台分区。只映射后端冻结的 7 种已知来源；
 * 未知 kind 返回 null（调用方渲染为不可跳转的中性条目，而不是通过 default 随便落到某个分区）。
 */
export function sourceKindSection(kind: string): WorldConsoleSectionId | null {
  return SOURCE_KIND_SECTION[kind] ?? null
}

export const KNOWN_SOURCE_KINDS: readonly string[] = Object.keys(SOURCE_KIND_SECTION)
export const KNOWN_OMISSION_KINDS = ['character_faction', 'character_location', 'faction_headquarters', 'relationship_edge'] as const
export const KNOWN_OMISSION_REASONS = ['target_not_selected', 'target_cascaded_removed'] as const
export const KNOWN_WARNING_CODES = ['legacy_timeline_category', 'binding_unchecked'] as const

export function isKnownOmissionKind(kind: string): boolean {
  return (KNOWN_OMISSION_KINDS as readonly string[]).includes(kind)
}
export function isKnownOmissionReason(reason: string): boolean {
  return (KNOWN_OMISSION_REASONS as readonly string[]).includes(reason)
}
export function isKnownWarningCode(code: string): boolean {
  return (KNOWN_WARNING_CODES as readonly string[]).includes(code)
}

/**
 * 只取指纹用于“辨认是否同一份预览”的短标签：去掉 `v1|` 算法前缀后截断到 max 个字符。
 * 仅展示用，不提供复制/写日志动作。
 */
export function shortFingerprint(fingerprint: string, max = 10): string {
  if (!fingerprint) return ''
  const body = fingerprint.includes('|') ? fingerprint.slice(fingerprint.indexOf('|') + 1) : fingerprint
  return body.length > max ? `${body.slice(0, max)}…` : body
}
