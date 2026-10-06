import { describe, expect, it } from 'vitest'
import type { LoreItem } from '@/lib/api'
import {
  BOOK_LIBRARY_CATEGORIES,
  explicitRelationsOf,
  filterEntries,
  groupCharactersByTier,
  paginate,
  pinnedEntries,
  resolveCharacterTier,
  selectPeople,
  sortByRecentlyEdited,
} from './book-library-view-model'

function item(overrides: Partial<LoreItem> = {}): LoreItem {
  return {
    id: 'a',
    enabled: true,
    type: 'character',
    type_source: 'manual',
    name: '甲',
    importance: 'important',
    load_mode: 'auto',
    tags: [],
    keywords: [],
    brief_description: '',
    content: '',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  } as LoreItem
}

describe('book library view model', () => {
  it('只认 major/minor，其余一律未分类，绝不从 importance 推断层级', () => {
    expect(resolveCharacterTier(item({ character_tier: 'major' }))).toBe('major')
    expect(resolveCharacterTier(item({ character_tier: 'minor', importance: 'major' }))).toBe('minor')
    expect(resolveCharacterTier(item({ importance: 'major' }))).toBe('unclassified')
    expect(resolveCharacterTier(item({ character_tier: 'legendary' as LoreItem['character_tier'] }))).toBe('unclassified')
  })

  it('分组只收人物，其它类型不混入', () => {
    const groups = groupCharactersByTier([
      item({ id: 'm1', character_tier: 'major' }),
      item({ id: 'n1', character_tier: 'minor' }),
      item({ id: 'u1' }),
      item({ id: 'p1', type: 'location' }),
    ])
    expect(groups.major.map((entry) => entry.id)).toEqual(['m1'])
    expect(groups.minor.map((entry) => entry.id)).toEqual(['n1'])
    expect(groups.unclassified.map((entry) => entry.id)).toEqual(['u1'])
  })

  it('25 位次要人物分 3 页，跨页不重不漏；搜索先作用于全量再分页', () => {
    const minors = Array.from({ length: 25 }, (_, index) => item({
      id: `n${index}`,
      name: `次要${index}`,
      character_tier: 'minor',
    }))
    const all = selectPeople(minors, 'minor', '')
    expect(all).toHaveLength(25)

    const pages = [0, 1, 2].map((page) => paginate(all, page))
    expect(pages.map((slice) => slice.rows.length)).toEqual([12, 12, 1])
    expect(pages.every((slice) => slice.pageCount === 3)).toBe(true)
    expect(pages[2].from).toBe(25)
    expect(pages[2].to).toBe(25)

    const seen = pages.flatMap((slice) => slice.rows.map((row) => row.id))
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('页码越界回落到最后一页，空集合仍报告一页', () => {
    const rows = [item({ id: 'x1' }), item({ id: 'x2' })]
    expect(paginate(rows, 99).page).toBe(0)
    expect(paginate(rows, -3).page).toBe(0)
    const empty = paginate([], 4)
    expect(empty.pageCount).toBe(1)
    expect(empty.total).toBe(0)
    expect(empty.from).toBe(0)
  })

  it('搜索命中名称/摘要/标签/正文，未命中时返回空而不是猜事实', () => {
    const rows = [
      item({ id: 'a', name: '林照', brief_description: '守灯人' }),
      item({ id: 'b', name: '沈砚', tags: ['调查员'] }),
      item({ id: 'c', name: '雾港', type: 'location', content: '第七灯塔的档案室' }),
    ]
    expect(filterEntries(rows, '守灯', []).map((entry) => entry.id)).toEqual(['a'])
    expect(filterEntries(rows, '调查员', []).map((entry) => entry.id)).toEqual(['b'])
    expect(filterEntries(rows, '档案室', []).map((entry) => entry.id)).toEqual(['c'])
    expect(filterEntries(rows, '不存在', [])).toEqual([])
  })

  it('分类导航只映射真实 Lore 类型，不新增 person/place/creature 枚举', () => {
    const covered = BOOK_LIBRARY_CATEGORIES.flatMap((category) => category.types)
    const allTypes: LoreItem['type'][] = ['character', 'world', 'location', 'faction', 'rule', 'item', 'other']
    expect([...covered].sort()).toEqual([...allTypes].sort())
  })

  it('最近更新排序只用真实 updated_at，置顶沿用 pin_order 升序', () => {
    const rows = [
      item({ id: 'old', updated_at: '2026-01-01T00:00:00Z' }),
      item({ id: 'new', updated_at: '2026-10-05T00:00:00Z' }),
      item({ id: 'mid', updated_at: '2026-06-01T00:00:00Z' }),
    ]
    expect(sortByRecentlyEdited(rows).map((entry) => entry.id)).toEqual(['new', 'mid', 'old'])

    const pins = pinnedEntries([
      item({ id: 'second', pinned: true, pin_order: 1 }),
      item({ id: 'first', pinned: true, pin_order: 0 }),
      item({ id: 'notPinned' }),
    ])
    expect(pins.map((entry) => entry.id)).toEqual(['first', 'second'])
  })

  it('人物分组先按层级再按搜索词过滤，切换分组不会漏掉未分类', () => {
    const rows = [
      item({ id: 'm1', name: '林照', character_tier: 'major' }),
      item({ id: 'n1', name: '沈砚', character_tier: 'minor' }),
      item({ id: 'u1', name: '陶铃' }),
      item({ id: 'p1', name: '雾港', type: 'location' }),
    ]
    expect(selectPeople(rows, 'all', '').map((entry) => entry.id)).toEqual(['m1', 'n1', 'u1'])
    expect(selectPeople(rows, 'unclassified', '').map((entry) => entry.id)).toEqual(['u1'])
    expect(selectPeople(rows, 'all', '砚').map((entry) => entry.id)).toEqual(['n1'])
  })

  it('显式关系只保留同书可解析且有标签的目标，悬空与自环都不算关系', () => {
    const rows = [
      item({ id: 'a', name: '甲', relations: [
        { target_id: 'b', label: '信任' },
        { target_id: 'b', label: '' },
        { target_id: 'missing', label: '旧关联' },
        { target_id: 'a', label: '自环' },
        { target_id: 'c', label: '  同属  ', note: '  ' },
      ] }),
      item({ id: 'b', name: '乙' }),
      item({ id: 'c', name: '丙' }),
    ]
    const relations = explicitRelationsOf(rows[0], rows)
    expect(relations.map((relation) => [relation.target.id, relation.label, relation.note])).toEqual([
      ['b', '信任', undefined],
      ['c', '同属', undefined],
    ])
    expect(explicitRelationsOf(rows[1], rows)).toEqual([])
  })
})
