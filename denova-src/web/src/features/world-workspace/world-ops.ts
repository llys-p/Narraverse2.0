import type { BindingScope, World, WorldAssetBinding, WorldEntityKind, WorldSemanticType } from './types'

// 删除实体时的引用完整性纯函数：保证删除后仍是后端可接受的草稿（不产生悬空引用），
// 并清理不再被任何世界实体引用的 orphan binding。全部为纯函数，不修改入参。

/**
 * “实体作用域”绑定：其生命周期挂在某个角色/地点/势力上，失去全部实体引用即可清理。
 * 其余语义（world/rule/item/other 等世界作用域绑定，如创世向导添加的世界背景/规则/物品）
 * 并不挂在实体上，绝不能因为没有 char/loc/faction 引用就被当成 orphan 删除。
 */
const ENTITY_SCOPED_SEMANTICS: ReadonlySet<WorldSemanticType> = new Set<WorldSemanticType>(['character', 'location', 'faction'])

/**
 * 绑定生命周期策略的唯一推导入口：显式 scope 优先；旧绑定缺省时按语义推导，
 * character/location/faction 挂实体=entity，其余（world/rule/item/other 等）=world。
 * 纯函数，不修改入参，供清理、分区展示与测试共用。
 */
export function bindingScopeOf(binding: WorldAssetBinding): BindingScope {
  if (binding.scope === 'entity' || binding.scope === 'world') return binding.scope
  return ENTITY_SCOPED_SEMANTICS.has(binding.semanticType) ? 'entity' : 'world'
}

/** 收集所有世界作用域（world scope）绑定，供“世界资料”分区展示。 */
export function worldScopedBindings(world: World): WorldAssetBinding[] {
  return world.bindings.filter((b) => bindingScopeOf(b) === 'world')
}

/** 收集当前仍被角色/地点/势力引用的 bindingId（绑定唯一真源在 World.bindings）。 */
export function referencedBindingIds(world: World): Set<string> {
  const ids = new Set<string>()
  for (const c of world.characters) if (c.bindingId) ids.add(c.bindingId)
  for (const l of world.locations) if (l.bindingId) ids.add(l.bindingId)
  for (const f of world.factions) if (f.bindingId) ids.add(f.bindingId)
  return ids
}

/**
 * 删除 orphan 绑定（以 scope 为准，缺省回退语义推导）：
 * - world 作用域绑定一律保留，即使没有实体引用；
 * - entity 作用域绑定只有在失去全部实体引用时才清理，仍被任一对象引用则保留。
 * 无变化时返回原对象。
 */
export function pruneOrphanBindings(world: World): World {
  const refs = referencedBindingIds(world)
  const bindings = world.bindings.filter((b) => (
    bindingScopeOf(b) === 'entity' ? refs.has(b.bindingId) : true
  ))
  if (bindings.length === world.bindings.length) return world
  return { ...world, bindings }
}

/**
 * 添加一个绑定：一个世界内同一 masterItemId 只允许一个绑定（共享同一 bindingId）。
 * 已绑定同一总库条目时原样返回，不产生重复绑定。纯函数。
 */
export function addWorldBinding(world: World, binding: WorldAssetBinding): World {
  if (world.bindings.some((b) => b.masterItemId === binding.masterItemId)) return world
  return { ...world, bindings: [...world.bindings, binding] }
}

/**
 * 显式移除一个绑定（世界资料“移除”）：删除该绑定，并解除角色/地点/势力对它的引用，
 * 避免留下悬空 bindingId。不删除任何实体本身，也不触碰总资料库。纯函数。
 */
export function removeWorldBinding(world: World, bindingId: string): World {
  if (!world.bindings.some((b) => b.bindingId === bindingId)) return world
  return {
    ...world,
    bindings: world.bindings.filter((b) => b.bindingId !== bindingId),
    characters: world.characters.map((c) => (c.bindingId === bindingId ? { ...c, bindingId: undefined } : c)),
    locations: world.locations.map((l) => (l.bindingId === bindingId ? { ...l, bindingId: undefined } : l)),
    factions: world.factions.map((f) => (f.bindingId === bindingId ? { ...f, bindingId: undefined } : f)),
  }
}

/** 保存前草稿校验发现的问题类别，对应控制台分区。 */
export type DraftIssueKind = 'character' | 'location' | 'faction' | 'timeline'
export interface DraftIssue {
  kind: DraftIssueKind
  /** 出问题的实体 id，便于定位（可选用于滚动/高亮）。 */
  id: string
}

/**
 * 保存前统一校验：后端要求角色 displayName、地点/势力 name、时间线 title 非空，
 * 这里在前端先拦住“添加了空实体却直接保存必然 400”的草稿，返回第一个问题。
 */
export function findDraftIssue(world: World): DraftIssue | null {
  for (const c of world.characters) {
    if (!c.displayName.trim()) return { kind: 'character', id: c.id }
  }
  for (const l of world.locations) {
    if (!l.name.trim()) return { kind: 'location', id: l.id }
  }
  for (const f of world.factions) {
    if (!f.name.trim()) return { kind: 'faction', id: f.id }
  }
  for (const e of world.timeline) {
    if (!e.title.trim()) return { kind: 'timeline', id: e.id }
  }
  return null
}

/**
 * 删除一个世界实体并解除其它实体对它的引用，最后清理 orphan binding：
 * - 角色：移除该角色，并从其它角色的 relationships 中摘除指向它的关系；
 * - 地点：移除该地点，清空角色 locationId、势力 headquartersLocationId；
 * - 势力：移除该势力，清空角色 factionId。
 * 不删除任何其它实体，也不触碰仍被引用的绑定。
 */
export function removeWorldEntity(world: World, kind: WorldEntityKind, id: string): World {
  let next: World
  if (kind === 'character') {
    next = {
      ...world,
      characters: world.characters
        .filter((c) => c.id !== id)
        .map((c) => (c.relationships?.length
          ? { ...c, relationships: c.relationships.filter((r) => r.targetCharacterId !== id) }
          : c)),
    }
  } else if (kind === 'location') {
    next = {
      ...world,
      locations: world.locations.filter((l) => l.id !== id),
      characters: world.characters.map((c) => (c.locationId === id ? { ...c, locationId: undefined } : c)),
      factions: world.factions.map((f) => (f.headquartersLocationId === id
        ? { ...f, headquartersLocationId: undefined }
        : f)),
    }
  } else {
    next = {
      ...world,
      factions: world.factions.filter((f) => f.id !== id),
      characters: world.characters.map((c) => (c.factionId === id ? { ...c, factionId: undefined } : c)),
    }
  }
  return pruneOrphanBindings(next)
}
