import { describe, expect, it } from 'vitest'
import { characterDisplayName, getBinding, worldStats } from '../selectors'
import type { World } from '../types'

function fixtureWorld(): World {
  return {
    id: 'abcdef0123456789',
    schemaVersion: 1,
    name: 'W',
    status: 'active',
    bindings: [
      { bindingId: 'b1', masterItemId: 'master/1', recordKind: 'character_template', semanticType: 'character', nameSnapshot: '卡蕾妮', tagsSnapshot: [], boundAt: '' },
    ],
    characters: [{ id: 'c1', bindingId: 'b1', displayName: '' }, { id: 'c2', displayName: '自定义' }],
    locations: [{ id: 'l1', name: '灰港' }],
    factions: [{ id: 'f1', name: '守夜人' }],
    timeline: [{ id: 't1', order: 1, title: '开端' }],
    createdAt: '',
    updatedAt: '',
  }
}

describe('world selectors', () => {
  it('resolves the single binding source by bindingId', () => {
    const w = fixtureWorld()
    expect(getBinding(w, 'b1')?.masterItemId).toBe('master/1')
    expect(getBinding(w, 'missing')).toBeUndefined()
    expect(getBinding(w, undefined)).toBeUndefined()
  })

  it('computes stats from array lengths (never persisted)', () => {
    expect(worldStats(fixtureWorld())).toEqual({
      characterCount: 2, locationCount: 1, factionCount: 1, timelineCount: 1, bindingCount: 1,
    })
  })

  it('falls back to binding snapshot name only when displayName empty', () => {
    const w = fixtureWorld()
    expect(characterDisplayName(w, w.characters[0])).toBe('卡蕾妮')
    expect(characterDisplayName(w, w.characters[1])).toBe('自定义')
  })
})
