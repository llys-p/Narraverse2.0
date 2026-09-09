import type { World, WorldAssetBinding, WorldCharacter, WorldSummary } from './types'

/** 由 bindingId 解析唯一绑定真源；找不到返回 undefined（不伪造）。 */
export function getBinding(world: World, bindingId?: string): WorldAssetBinding | undefined {
  if (!bindingId) return undefined
  return world.bindings.find((b) => b.bindingId === bindingId)
}

/** 世界计数由数组长度即时计算，不持久化。 */
export function worldStats(world: World) {
  return {
    characterCount: world.characters.length,
    locationCount: world.locations.length,
    factionCount: world.factions.length,
    timelineCount: world.timeline.length,
    bindingCount: world.bindings.length,
  }
}

/** 角色显示名：优先世界内 displayName，其次绑定快照名。 */
export function characterDisplayName(world: World, character: WorldCharacter): string {
  if (character.displayName.trim()) return character.displayName
  return getBinding(world, character.bindingId)?.nameSnapshot ?? ''
}

export function summaryStats(s: WorldSummary) {
  return {
    characterCount: s.characterCount,
    locationCount: s.locationCount,
    factionCount: s.factionCount,
    timelineCount: s.timelineCount,
  }
}

/** 简单 ISO 时间展示（YYYY-MM-DD HH:mm），兼容 RFC3339Nano。 */
export function formatStamp(stamp?: string): string {
  if (!stamp) return '—'
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return stamp
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
