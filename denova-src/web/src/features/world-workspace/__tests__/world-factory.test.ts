import { describe, expect, it } from 'vitest'
import { characterFromBinding, factionFromBinding, locationFromBinding } from '../world-factory'
import type { WorldAssetBinding } from '../types'

describe('world-factory', () => {
  it('creates an independent character instance from a character binding', () => {
    const binding: WorldAssetBinding = {
      bindingId: 'binding-1',
      masterItemId: 'master-1',
      recordKind: 'character_template',
      semanticType: 'character',
      nameSnapshot: '林夜',
      tagsSnapshot: [],
      boundAt: '2026-09-08T00:00:00Z',
    }
    const character = characterFromBinding(binding)
    expect(character).toMatchObject({ bindingId: 'binding-1', displayName: '林夜' })
    expect(character.id).toBeTruthy()
  })

  it('从 location 绑定生成地点实例：名称取快照、标签拷贝、不共享数组', () => {
    const binding: WorldAssetBinding = {
      bindingId: 'bloc', masterItemId: 'master-loc', recordKind: 'lorebook_template',
      semanticType: 'location', nameSnapshot: '灰港', tagsSnapshot: ['港口', '北境'], scope: 'entity', boundAt: '',
    }
    const loc = locationFromBinding(binding)
    expect(loc).toMatchObject({ bindingId: 'bloc', name: '灰港', tags: ['港口', '北境'] })
    expect(loc.id).toBeTruthy()
    loc.tags?.push('x')
    expect(binding.tagsSnapshot).toEqual(['港口', '北境'])
  })

  it('从 faction 绑定生成势力实例', () => {
    const binding: WorldAssetBinding = {
      bindingId: 'bfac', masterItemId: 'master-fac', recordKind: 'lorebook_template',
      semanticType: 'faction', nameSnapshot: '守夜人', tagsSnapshot: [], scope: 'entity', boundAt: '',
    }
    const fac = factionFromBinding(binding)
    expect(fac).toMatchObject({ bindingId: 'bfac', name: '守夜人' })
    expect(fac.id).toBeTruthy()
  })
})
