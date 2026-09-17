import type {
  WorkLibrary,
  WorkLibraryItem,
  WorkLibraryRelation,
  WorkLibrarySummary,
  WorkLibraryTimelineEntry,
} from '@/lib/api-client'

// 设定库的纯派生逻辑：列表排序、筛选、统计，以及在本地把服务端返回的
// 单条目/单关系增删改合并回库对象。全部是纯函数，便于单测且不依赖 React。

const TYPE_ORDER: Record<string, number> = {
  world: 0,
  rule: 1,
  character: 2,
  faction: 3,
  location: 4,
  event: 5,
  ability: 6,
  item: 7,
  other: 8,
}

const IMPORTANCE_ORDER: Record<string, number> = { major: 0, important: 1, minor: 2 }

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN')
}

/**
 * 条目排序：类型 → 重要度 → 名称 → ID。
 * 最后用 ID 收尾是刻意的：同名条目必须得到稳定顺序，否则每次渲染都会跳动。
 */
export function sortItems(items: WorkLibraryItem[]): WorkLibraryItem[] {
  return [...items].sort((a, b) => {
    const typeDelta = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99)
    if (typeDelta !== 0) return typeDelta
    const importanceDelta = (IMPORTANCE_ORDER[a.importance] ?? 99) - (IMPORTANCE_ORDER[b.importance] ?? 99)
    if (importanceDelta !== 0) return importanceDelta
    const nameDelta = compareNames(a.name, b.name)
    if (nameDelta !== 0) return nameDelta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export interface ItemFilter {
  query?: string
  type?: string
  loadMode?: string
}

/** 条目筛选：名称/简介/标签/关键词命中，外加类型与档位过滤。 */
export function filterItems(items: WorkLibraryItem[], filter: ItemFilter): WorkLibraryItem[] {
  const query = (filter.query ?? '').trim().toLowerCase()
  return items.filter((item) => {
    if (filter.type && item.type !== filter.type) return false
    if (filter.loadMode && item.loadMode !== filter.loadMode) return false
    if (!query) return true
    const haystack = [
      item.name,
      item.briefDescription ?? '',
      item.content ?? '',
      ...(item.tags ?? []),
      ...(item.keywords ?? []),
    ]
      .join('\n')
      .toLowerCase()
    return haystack.includes(query)
  })
}

/** 常驻规则条目：背景总览用它做“核心规则”导航（只引用，不复制正文）。 */
export function residentRuleItems(library: WorkLibrary | null): WorkLibraryItem[] {
  if (!library) return []
  return sortItems(library.items.filter((item) => item.type === 'rule' && item.loadMode === 'resident' && item.enabled))
}

/** 库统计：与后端摘要口径一致，供列表之外的即时展示使用。 */
export function libraryStats(library: WorkLibrary | null): {
  items: number
  events: number
  relations: number
  references: number
  resident: number
  disabled: number
} {
  if (!library) return { items: 0, events: 0, relations: 0, references: 0, resident: 0, disabled: 0 }
  return {
    items: library.items.length,
    events: library.items.filter((item) => item.type === 'event').length,
    relations: library.relations.length,
    references: library.items.filter((item) => item.origin === 'reference').length,
    resident: library.items.filter((item) => item.loadMode === 'resident').length,
    disabled: library.items.filter((item) => !item.enabled).length,
  }
}

/** 条目 ID → 名称（ID 在库内唯一，名称可能重复，因此引用展示优先带 ID）。 */
export function itemNameLookup(items: WorkLibraryItem[]): Map<string, WorkLibraryItem> {
  const map = new Map<string, WorkLibraryItem>()
  for (const item of items) map.set(item.id, item)
  return map
}

/** 名称 + 类型（同名条目靠类型与 ID 区分展示）。 */
export function itemDisplayName(item: WorkLibraryItem | undefined, fallbackId: string): string {
  if (!item) return fallbackId
  return item.name || fallbackId
}

// ---- 本地合并：服务端返回单个条目/关系后，把它们并回当前库对象 ----

export function upsertItem(library: WorkLibrary, item: WorkLibraryItem): WorkLibrary {
  const index = library.items.findIndex((existing) => existing.id === item.id)
  const items = index >= 0
    ? library.items.map((existing) => (existing.id === item.id ? item : existing))
    : [...library.items, item]
  return { ...library, items }
}

/**
 * 删除条目后的本地合并：同时移除服务端已经级联清理掉的关系，
 * 并把被更新过的事件条目写回，避免前端显示已不存在的引用（悬空引用）。
 */
export function removeItemLocal(
  library: WorkLibrary,
  itemId: string,
  removedRelationIds: string[],
  updatedEventIds: string[],
): WorkLibrary {
  const removed = new Set(removedRelationIds)
  const touchedEvents = new Set(updatedEventIds)
  return {
    ...library,
    items: library.items
      .filter((item) => item.id !== itemId)
      .map((item) => {
        if (!touchedEvents.has(item.id) || !item.event) return item
        return {
          ...item,
          event: {
            ...item.event,
            locationItemId: item.event.locationItemId === itemId ? '' : item.event.locationItemId,
            participantItemIds: (item.event.participantItemIds ?? []).filter((id) => id !== itemId),
          },
        }
      }),
    relations: library.relations.filter((relation) => !removed.has(relation.id)),
  }
}

export function upsertRelation(library: WorkLibrary, relation: WorkLibraryRelation): WorkLibrary {
  const index = library.relations.findIndex((existing) => existing.id === relation.id)
  const relations = index >= 0
    ? library.relations.map((existing) => (existing.id === relation.id ? relation : existing))
    : [...library.relations, relation]
  return { ...library, relations }
}

export function removeRelationLocal(library: WorkLibrary, relationId: string): WorkLibrary {
  return { ...library, relations: library.relations.filter((relation) => relation.id !== relationId) }
}

/** 某条目参与的关系（用于条目详情展示，两端都算）。 */
export function relationsForItem(library: WorkLibrary | null, itemId: string): WorkLibraryRelation[] {
  if (!library) return []
  return library.relations.filter((relation) => relation.fromItemId === itemId || relation.toItemId === itemId)
}

/** 某条目被引用的事件（参与者或地点）。 */
export function eventsForItem(timeline: WorkLibraryTimelineEntry[], itemId: string): WorkLibraryTimelineEntry[] {
  return timeline.filter((entry) => entry.itemId !== itemId && (entry.locationId === itemId || (entry.participants ?? []).includes(itemId)))
}

/** 摘要行的展示口径：条目数/事件数/关系数/只读引用数。 */
export function summarizeForCard(summary: WorkLibrarySummary): Array<{ key: string; count: number }> {
  return [
    { key: 'workLibrary.list.itemCount', count: summary.itemCount },
    { key: 'workLibrary.list.eventCount', count: summary.eventCount },
    { key: 'workLibrary.list.relationCount', count: summary.relationCount },
    { key: 'workLibrary.list.referenceCount', count: summary.referenceCount },
  ]
}
