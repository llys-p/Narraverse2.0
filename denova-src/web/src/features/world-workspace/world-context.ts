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
