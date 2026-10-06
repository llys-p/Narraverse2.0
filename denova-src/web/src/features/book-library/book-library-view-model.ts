import type { LoreItem } from '@/lib/api'

export type CharacterTier = NonNullable<LoreItem['character_tier']>
export type PeopleGroup = CharacterTier | 'all'
export type EntryLayout = 'list' | 'cards'

export type BookLibraryView =
  | 'home'
  | 'all'
  | 'character'
  | 'location'
  | 'faction'
  | 'world-rule'
  | 'item-other'
  | 'graph'
  | 'overview'
  | 'tools'
  | 'detail'

/** 人物分组分页的固定页容量，与已认可的桌面原型一致。 */
export const PEOPLE_PAGE_SIZE = 12

export interface BookLibraryCategory {
  id: Extract<BookLibraryView, 'character' | 'location' | 'faction' | 'world-rule' | 'item-other'>
  labelKey: string
  types: LoreItem['type'][]
}

/**
 * 分类导航只映射维护树已有的 Lore 类型，不新增枚举。
 * 物品与其它合并是因为后端没有 creature 类型，不能伪造映射。
 */
export const BOOK_LIBRARY_CATEGORIES: BookLibraryCategory[] = [
  { id: 'character', labelKey: 'lore.type.character', types: ['character'] },
  { id: 'location', labelKey: 'lore.type.location', types: ['location'] },
  { id: 'faction', labelKey: 'lore.type.faction', types: ['faction'] },
  { id: 'world-rule', labelKey: 'bookLibrary.category.worldRule', types: ['world', 'rule'] },
  { id: 'item-other', labelKey: 'bookLibrary.category.itemOther', types: ['item', 'other'] },
]

export const BOOK_LIBRARY_VIEWS: BookLibraryView[] = [
  'home',
  'all',
  ...BOOK_LIBRARY_CATEGORIES.map((category) => category.id),
  'graph',
  'overview',
]

export const PEOPLE_GROUPS: PeopleGroup[] = ['major', 'minor', 'unclassified', 'all']

/** 层级只控制展示分组；缺失或非法值一律视为未分类，不从 importance 推断。 */
export function resolveCharacterTier(item: Pick<LoreItem, 'character_tier'>): CharacterTier {
  return item.character_tier === 'major' || item.character_tier === 'minor' ? item.character_tier : 'unclassified'
}

export function normalizeSearchQuery(query: string) {
  return query.trim().toLocaleLowerCase()
}

/** 搜索命中名称、摘要、标签与正文——全部是条目已有字段，不引入推断事实。 */
export function entryMatchesQuery(item: LoreItem, needle = normalizeSearchQuery('')) {
  if (!needle) return true
  const haystack = [
    item.name,
    item.brief_description || '',
    item.content || '',
    (item.tags || []).join('\n'),
  ].join('\n').toLocaleLowerCase()
  return haystack.includes(needle)
}

export function entriesOfType(items: LoreItem[], types: LoreItem['type'][]) {
  if (!types.length) return items
  const allowed = new Set(types)
  return items.filter((item) => allowed.has(item.type))
}

export function filterEntries(items: LoreItem[], query: string, types: LoreItem['type'][] = []) {
  const needle = normalizeSearchQuery(query)
  return entriesOfType(items, types).filter((item) => entryMatchesQuery(item, needle))
}

export function groupCharactersByTier(items: LoreItem[]) {
  const groups: Record<CharacterTier, LoreItem[]> = { major: [], minor: [], unclassified: [] }
  for (const item of items) {
    if (item.type !== 'character') continue
    groups[resolveCharacterTier(item)].push(item)
  }
  return groups
}

/** 分组与搜索先作用于全量人物，再交给分页，避免翻页时漏项或重复。 */
export function selectPeople(items: LoreItem[], group: PeopleGroup, query: string) {
  const needle = normalizeSearchQuery(query)
  return items.filter((item) => {
    if (item.type !== 'character') return false
    if (group !== 'all' && resolveCharacterTier(item) !== group) return false
    return entryMatchesQuery(item, needle)
  })
}

export interface PaginatedSlice<T> {
  rows: T[]
  page: number
  pageCount: number
  total: number
  from: number
  to: number
}

export function paginate<T>(list: T[], requestedPage: number, pageSize = PEOPLE_PAGE_SIZE): PaginatedSlice<T> {
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize))
  const page = Math.min(Math.max(0, Math.trunc(requestedPage) || 0), pageCount - 1)
  const start = page * pageSize
  const rows = list.slice(start, start + pageSize)
  return {
    rows,
    page,
    pageCount,
    total: list.length,
    from: list.length ? start + 1 : 0,
    to: start + rows.length,
  }
}

/**
 * 最近更新排序：只读真实 updated_at，缺失者排在后面。
 * 时间戳是 ISO-8601，按字典序直接比较即可，用 localeCompare 会让标点参与本地化排序。
 */
export function sortByRecentlyEdited(items: LoreItem[]): LoreItem[] {
  return [...items].sort((a, b) => {
    const left = a.updated_at || ''
    const right = b.updated_at || ''
    if (left === right) return 0
    if (!left) return 1
    if (!right) return -1
    return left < right ? 1 : -1
  })
}

/** 置顶集合沿用总览面板的既有语义：pin_order 升序，同值按名称。 */
export function pinnedEntries(items: LoreItem[]): LoreItem[] {
  return items
    .filter((item) => item.pinned)
    .sort((a, b) => ((a.pin_order ?? 0) - (b.pin_order ?? 0)) || a.name.localeCompare(b.name))
}

/** 全部资料只统计真实条目；总览是独立文件，不作为条目计数。 */
export function countEntries(items: LoreItem[]) {
  return items.length
}

export interface ExplicitRelationEntry {
  key: string
  target: LoreItem
  label: string
  note?: string
}

/**
 * 关系详情只列已确认的显式关系（item.relations），目标必须能在同一本书里解析；
 * 悬空目标与正文提及都不呈现为关系。
 */
export function explicitRelationsOf(item: LoreItem, items: LoreItem[]): ExplicitRelationEntry[] {
  const byId = new Map(items.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const result: ExplicitRelationEntry[] = []
  for (const relation of item.relations || []) {
    if (!relation?.target_id || relation.target_id === item.id) continue
    const target = byId.get(relation.target_id)
    const label = (relation.label || '').trim()
    if (!target || !label) continue
    const key = `${relation.target_id}\u0000${label}\u0000${relation.note || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ key, target, label, note: relation.note?.trim() || undefined })
  }
  return result
}

export function hasExplicitRelations(item: LoreItem, items: LoreItem[]) {
  return explicitRelationsOf(item, items).length > 0
}

export function isBlankField(value: string | undefined | null) {
  return !String(value ?? '').trim()
}

export function hasGalleryImages(item: Pick<LoreItem, 'image' | 'images'>) {
  return Boolean(item.image?.image_path) || (item.images?.length || 0) > 0
}

/** 条目所在分类，用于面包屑；未登记的类型回落「全部资料」。 */
export function categoryOfItem(item: LoreItem): BookLibraryCategory | null {
  return BOOK_LIBRARY_CATEGORIES.find((category) => category.types.includes(item.type)) || null
}
