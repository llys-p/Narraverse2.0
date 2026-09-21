import { describe, expect, it } from 'vitest'
import type { WorkLibrary, WorkLibraryItem } from '@/lib/api-client'
import { filterItems, removeItemLocal, residentRuleItems, sortItems } from './library-draft'

function item(id: string, name: string, type = 'character'): WorkLibraryItem {
  return {
    id, name, type, enabled: true, importance: 'important', loadMode: 'auto',
    origin: 'original', createdAt: '2026-09-17', updatedAt: '2026-09-17',
  }
}

function library(items: WorkLibraryItem[]): WorkLibrary {
  return {
    id: 'abcdefghijklmnop', schemaVersion: 1, name: '水浒', purpose: 'any',
    items, relations: [], createdAt: '2026-09-17', updatedAt: '2026-09-17',
  }
}

describe('library draft projections', () => {
  it('sorts same-name items by stable IDs without mutating the source', () => {
    const original = [item('b', '林冲'), item('a', '林冲')]
    expect(sortItems(original).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(original.map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('filters source metadata and selects only enabled resident rules', () => {
    const rule = { ...item('r', '梁山军规', 'rule'), loadMode: 'resident' as const }
    const disabled = { ...item('s', '旧规则', 'rule'), loadMode: 'resident' as const, enabled: false }
    const source = library([rule, disabled, { ...item('c', '林冲'), tags: ['豹子头'] }])
    expect(residentRuleItems(source).map((entry) => entry.id)).toEqual(['r'])
    expect(filterItems(source.items, { query: '豹子头' }).map((entry) => entry.id)).toEqual(['c'])
  })

  it('removes cascaded relations and event references without dangling local references', () => {
    const event = { ...item('e', '聚义', 'event'), event: {
      order: 1, era: '宋', category: 'historical', participantItemIds: ['c', 'x'], locationItemId: 'c',
    } }
    const source = library([item('c', '林冲'), item('x', '宋江'), event])
    source.relations = [{
      id: 'rel', fromItemId: 'c', toItemId: 'x', kind: 'ally', createdAt: '', updatedAt: '',
    }]
    const result = removeItemLocal(source, 'c', ['rel'], ['e'])
    expect(result.items.map((entry) => entry.id)).toEqual(['x', 'e'])
    expect(result.relations).toEqual([])
    expect(result.items[1].event).toMatchObject({ participantItemIds: ['x'], locationItemId: '' })
    expect(source.items).toHaveLength(3)
    expect(source.relations).toHaveLength(1)
  })
})
