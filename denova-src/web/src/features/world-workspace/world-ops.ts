import type { World, WorldEntityKind } from './types'

// 删除实体时的引用完整性纯函数：保证删除后仍是后端可接受的草稿（不产生悬空引用），
// 并清理不再被任何世界实体引用的 orphan binding。全部为纯函数，不修改入参。

/** 收集当前仍被角色/地点/势力引用的 bindingId（绑定唯一真源在 World.bindings）。 */
export function referencedBindingIds(world: World): Set<string> {
  const ids = new Set<string>()
  for (const c of world.characters) if (c.bindingId) ids.add(c.bindingId)
  for (const l of world.locations) if (l.bindingId) ids.add(l.bindingId)
  for (const f of world.factions) if (f.bindingId) ids.add(f.bindingId)
  return ids
}

/** 删除不再被任何世界实体引用的绑定；只要仍被一个对象引用就保留。无变化时返回原对象。 */
export function pruneOrphanBindings(world: World): World {
  const refs = referencedBindingIds(world)
  const bindings = world.bindings.filter((b) => refs.has(b.bindingId))
  if (bindings.length === world.bindings.length) return world
  return { ...world, bindings }
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
