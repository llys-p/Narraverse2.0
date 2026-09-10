// World Workspace 前端类型，字段名与后端 internal/world 的 JSON 契约严格对齐。
// revision 是内容哈希信封值，不放在 World 内（见 {world,revision} 信封）。

export type BindingRecordKind = 'character_template' | 'lorebook_template'

/**
 * 绑定生命周期策略（Phase 2B.1）：
 * - entity：挂在角色/地点/势力上，失去最后实体引用即清理；
 * - world：属于整个世界，零实体引用也保留，只能在“世界资料”显式移除。
 * 旧绑定没有该字段，运行时按 semanticType 推导，不回写直到下次成功保存。
 */
export type BindingScope = 'entity' | 'world'

// 复用既有 lore 语义分类词表（internal/book/lore.go）。
export type WorldSemanticType =
  | 'character' | 'world' | 'location' | 'faction' | 'rule' | 'item' | 'other'

export type CharacterRole = 'protagonist' | 'major' | 'minor' | 'npc'
export type WorldStatus = 'active' | 'archived'
export type TimelineCategory = 'canon' | 'planned'
/** 可被删除并做级联解引用的世界实体类型。 */
export type WorldEntityKind = 'character' | 'location' | 'faction'

export interface WorldSetting {
  rules: string[]
  tone?: string
}

/** 对总资料库资产的只读引用；只在 World.bindings 中存一份。 */
export interface WorldAssetBinding {
  bindingId: string
  masterItemId: string
  recordKind: BindingRecordKind
  semanticType: WorldSemanticType
  nameSnapshot: string
  tagsSnapshot: string[]
  /** 绑定时总资料库条目的内容哈希；旧世界可能缺省，语义为“尚未检查”。 */
  masterRevision?: string
  /** 生命周期策略；旧绑定缺省时由 bindingScopeOf 按 semanticType 推导。 */
  scope?: BindingScope
  boundAt: string
}

/**
 * 绑定健康状态（运行时推导，不持久化）。
 * 四个结果态 latest/stale/missing/unavailable 对应用户需求；
 * unchecked 是旧数据遗留基线，checking 是瞬时加载态。该类型只在此处定义一次。
 */
export type BindingHealthState =
  | 'unchecked' // 遗留：binding.masterRevision 为空，尚无基线
  | 'checking' // 瞬时：检查请求进行中
  | 'latest' // 结果：已是最新
  | 'stale' // 结果：原件有更新
  | 'missing' // 结果：原件已不存在（HTTP 404）
  | 'unavailable' // 结果：暂时无法检查（网络/5xx/当前哈希缺失）

export interface WorldRelationship {
  targetCharacterId: string
  label: string
}

/** 世界内角色实例；世界内状态绝不回写总资料库。 */
export interface WorldCharacter {
  id: string
  bindingId?: string
  displayName: string
  role?: CharacterRole
  factionId?: string
  locationId?: string
  worldNote?: string
  relationships?: WorldRelationship[]
  growthNote?: string
  customFields?: Record<string, string>
}

export interface WorldLocation {
  id: string
  bindingId?: string
  name: string
  description?: string
  tags?: string[]
}

export interface WorldFaction {
  id: string
  bindingId?: string
  name: string
  description?: string
  influence?: number | null
  stability?: number | null
  headquartersLocationId?: string
}

export interface WorldTimelineEntry {
  id: string
  order: number
  eraLabel?: string
  title: string
  description?: string
  category?: TimelineCategory
}

export interface World {
  id: string
  schemaVersion: number
  name: string
  tagline?: string
  genre?: string
  summary?: string
  coverColor?: string
  status: WorldStatus
  worldSetting?: WorldSetting
  bindings: WorldAssetBinding[]
  characters: WorldCharacter[]
  locations: WorldLocation[]
  factions: WorldFaction[]
  timeline: WorldTimelineEntry[]
  primaryBookPath?: string
  primaryInteractiveStoryId?: string
  createdAt: string
  updatedAt: string
}

export interface WorldSummary {
  id: string
  name: string
  tagline?: string
  genre?: string
  coverColor?: string
  status: WorldStatus
  characterCount: number
  locationCount: number
  factionCount: number
  timelineCount: number
  createdAt: string
  updatedAt: string
}

export interface WorldLoadWarning {
  file: string
  id?: string
  reason: string
}

/** 创建入参：一次携带创世向导全部选择；不含 id/时间/status（服务端生成）。 */
export interface WorldCreateInput {
  name: string
  tagline?: string
  genre?: string
  summary?: string
  coverColor?: string
  worldSetting?: WorldSetting
  bindings?: WorldAssetBinding[]
  characters?: WorldCharacter[]
  locations?: WorldLocation[]
  factions?: WorldFaction[]
  timeline?: WorldTimelineEntry[]
  primaryBookPath?: string
  primaryInteractiveStoryId?: string
}

export interface WorldEnvelope {
  world: World
  revision: string
}

export interface WorldListEnvelope {
  worlds: WorldSummary[]
  warnings: WorldLoadWarning[]
}

/** feature 内部视图状态机（不引入路由库）。 */
export type WorldView =
  | { name: 'list' }
  | { name: 'create' }
  | { name: 'console'; id: string }
  | { name: 'character'; id: string; characterId: string }

// ---------------------------------------------------------------------------
// Phase 2B.2：创建向导 AI 结构提案（会话草稿，不持久化）
// ---------------------------------------------------------------------------

export type ProposalConfidence = 'low' | 'medium' | 'high'

/** 服务端盖章的来源引用；模型只能引用短 id。 */
export interface ProposalSourceRef {
  id: string
  kind: 'master_field' | 'user_snippet'
  masterItemId?: string
  masterRevision?: string
  fieldPath?: string
  snippetId?: string
  label: string
}

export interface ProposedBase {
  proposalItemId: string
  sourceRefIds: string[]
  confidence: ProposalConfidence
  reason?: string
}

/** 绑定候选（服务端确定性投影，模型禁止生成）。 */
export interface ProposedBindingCandidate {
  bindingCandidateId: string
  recordKind: BindingRecordKind
  semanticType: WorldSemanticType
  masterItemId: string
  nameSnapshot: string
  tagsSnapshot: string[]
  masterRevision: string
  scope: BindingScope
}

export interface ProposedRule extends ProposedBase {
  text: string
}

export interface ProposedWorldSetting extends ProposedBase {
  tone?: string
  rules: ProposedRule[]
}

export interface ProposedCharacter extends ProposedBase {
  displayName: string
  role?: CharacterRole
  worldNote?: string
}

export interface ProposedLocation extends ProposedBase {
  name: string
  description?: string
  tags?: string[]
}

export interface ProposedFaction extends ProposedBase {
  name: string
  description?: string
}

/** 服务端增强后的最终提案。2B.2 第一版无 timeline 字段。 */
export interface StructureProposal {
  schemaVersion: number
  sourceRefs: ProposalSourceRef[]
  bindingCandidates: ProposedBindingCandidate[]
  setting?: ProposedWorldSetting
  characters: ProposedCharacter[]
  locations: ProposedLocation[]
  factions: ProposedFaction[]
  generatedAt: string
}

/** 分析请求：只含资产 id + 期望 revision + 字段路径 + 用户片段。 */
export interface WorldStructureAnalysisSource {
  masterItemId: string
  expectedMasterRevision: string
  fieldPaths: string[]
}

export interface WorldStructureAnalysisSnippet {
  snippetId: string
  label?: string
  text: string
}

export interface WorldStructureAnalysisRequest {
  sources: WorldStructureAnalysisSource[]
  snippets: WorldStructureAnalysisSnippet[]
}

export interface ProposalEnvelope {
  proposal: StructureProposal
}

// 用户确认产物（会话内存）：edits 只承载世界可编辑字段，不含证据字段。
export type ProposalItemDecision = 'adopt' | 'discard'

export interface WorldEditableCharacter {
  displayName?: string
  role?: CharacterRole
  worldNote?: string
}

export interface WorldEditableLocation {
  name?: string
  description?: string
  tags?: string[]
}

export interface WorldEditableFaction {
  name?: string
  description?: string
}

export interface WorldEditableRule {
  text?: string
}

export type WorldEditableItem =
  | WorldEditableCharacter
  | WorldEditableLocation
  | WorldEditableFaction
  | WorldEditableRule

export interface ProposalChoices {
  /** key = proposalItemId；未列出的项默认 discard。 */
  decisions: Record<string, ProposalItemDecision>
  /** 引用 bindingCandidates[].bindingCandidateId。 */
  adoptedBindingCandidateIds: string[]
  /** key = proposalItemId；仅世界可编辑字段。 */
  edits: Record<string, WorldEditableItem>
  /** 仅可编辑世界设定字段（tone）；rules 作为独立提案项采纳/编辑。 */
  settingOverride?: { tone?: string }
}
