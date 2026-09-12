// Phase 3.1C1：Binding 纯派生契约。
//
// 这里的一切都从“已持久化的 World + 单个 bindingId”即时派生：
//   - 不新增 ownerId / references[] 等持久化反向索引（引用关系由实体 bindingId 即时扫描）；
//   - 不修改 World、不产生新 World；
//   - 不读取 Master Library、不发网络请求、不访问任何持久化；
//   - 不把任何状态写回 World。
// 一个 entity binding 可以同时被多个角色/地点/势力引用，因此结果是“全部引用位置”，
// 永远不是单一 owner。world scope 绑定即使零实体引用也仍是世界级资料，不是 orphan。
import { bindingScopeOf } from './world-ops'
import type { BindingScope, World, WorldAssetBinding, WorldEntityKind } from './types'

/** 一处实体引用：哪个世界实体（角色/地点/势力）正在引用该绑定。多对多，不设单一 owner。 */
export interface BindingUsageRef {
  entityKind: WorldEntityKind
  entityId: string
  /** 纯派生的展示名（角色 displayName / 地点或势力 name），可能为空字符串，不回写。 */
  entityName: string
}

/** 某绑定当前被引用的全部位置。 */
export interface BindingUsages {
  bindingId: string
  /** World.bindings 中是否存在该绑定。 */
  exists: boolean
  /** 实际生效 scope（复用 bindingScopeOf，旧绑定按 semanticType 推导）；不存在时为 null。 */
  scope: BindingScope | null
  /** 全部引用，按 character → location → faction、组内按 World 数组原顺序稳定排列。 */
  characters: readonly BindingUsageRef[]
  locations: readonly BindingUsageRef[]
  factions: readonly BindingUsageRef[]
}

/** “只看持久化摘要字段”的存储状态：它不是联网健康状态。 */
export type BindingStoredStatus =
  | 'unchecked' // masterRevision 缺失或空白：尚无基线，尚未检查
  | 'baseline' // masterRevision 非空：已记录基线；不代表 latest，也不发起任何联网判断

/** 空引用组复用同一冻结引用，保证“无引用”路径返回稳定引用、调用方无法误改。 */
const EMPTY_REFS: readonly BindingUsageRef[] = Object.freeze([])

function findBinding(world: World, bindingId: string): WorldAssetBinding | undefined {
  return world.bindings.find((b) => b.bindingId === bindingId)
}

/**
 * 扫描并返回该绑定当前被哪些 World Entity 引用（角色/地点/势力）。
 * 返回全部引用，顺序稳定；纯读取，不修改入参。
 */
export function bindingUsages(world: World, bindingId: string): BindingUsages {
  const binding = findBinding(world, bindingId)
  const characters = world.characters
    .filter((c) => c.bindingId === bindingId)
    .map((c): BindingUsageRef => ({ entityKind: 'character', entityId: c.id, entityName: c.displayName }))
  const locations = world.locations
    .filter((l) => l.bindingId === bindingId)
    .map((l): BindingUsageRef => ({ entityKind: 'location', entityId: l.id, entityName: l.name }))
  const factions = world.factions
    .filter((f) => f.bindingId === bindingId)
    .map((f): BindingUsageRef => ({ entityKind: 'faction', entityId: f.id, entityName: f.name }))

  return {
    bindingId,
    exists: binding !== undefined,
    scope: binding ? bindingScopeOf(binding) : null,
    characters: characters.length ? characters : EMPTY_REFS,
    locations: locations.length ? locations : EMPTY_REFS,
    factions: factions.length ? factions : EMPTY_REFS,
  }
}

/** 移除某绑定的影响评估（只计算，不执行任何修改）。 */
export interface BindingRemovalImpact {
  bindingId: string
  /** 绑定是否存在；不存在时其余字段为空/零值。 */
  exists: boolean
  /** 实际生效 scope；不存在时为 null。 */
  scope: BindingScope | null
  /** 绑定本体只读引用（不复制、不修改）；不存在时为 null。 */
  binding: Readonly<WorldAssetBinding> | null
  /** 全部当前引用位置。 */
  usages: BindingUsages
  /** 移除后将被解除 bindingId 的实体 id（分组、稳定顺序）。 */
  detachedCharacterIds: string[]
  detachedLocationIds: string[]
  detachedFactionIds: string[]
  /** 是否有任意实体将被解除引用。 */
  hasEntityImpact: boolean
  /**
   * 是否为 orphan 清理候选：仅 entity scope 且零实体引用时为 true。
   * world scope 即使零引用也仍是世界级资料，绝不是 orphan。
   */
  isOrphanCandidate: boolean
}

/**
 * 只计算“移除该 binding”的影响，绝不调用 removeWorldBinding、绝不产生新 World、绝不修改实体。
 * 解除引用仅体现在返回的 detached* id 列表中，供 UI 在用户确认后复用既有移除流程。
 */
export function bindingRemovalImpact(world: World, bindingId: string): BindingRemovalImpact {
  const binding = findBinding(world, bindingId) ?? null
  const usages = bindingUsages(world, bindingId)
  const detachedCharacterIds = usages.characters.map((r) => r.entityId)
  const detachedLocationIds = usages.locations.map((r) => r.entityId)
  const detachedFactionIds = usages.factions.map((r) => r.entityId)
  const refCount = detachedCharacterIds.length + detachedLocationIds.length + detachedFactionIds.length

  return {
    bindingId,
    exists: binding !== null,
    scope: usages.scope,
    binding,
    usages,
    detachedCharacterIds,
    detachedLocationIds,
    detachedFactionIds,
    hasEntityImpact: refCount > 0,
    // world scope 与实体存活无关，永远不是 orphan；只有 entity scope 且失去全部引用才是候选。
    isOrphanCandidate: usages.scope === 'entity' && refCount === 0,
  }
}

/**
 * 只依据已持久化摘要字段判断存储状态：
 * masterRevision 缺失或为空白 → unchecked；非空 → baseline。
 * 刻意不输出 checking/latest/stale/missing/unavailable 等联网结果，也不调用 fetchMasterAsset。
 * baseline 只表示“记录过基线”，绝不自动等同于 latest。
 */
export function bindingStoredStatus(binding: WorldAssetBinding): BindingStoredStatus {
  const revision = binding.masterRevision
  return typeof revision === 'string' && revision.trim().length > 0 ? 'baseline' : 'unchecked'
}
