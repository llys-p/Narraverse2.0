import { describe, expect, it } from 'vitest'
import { characterFromBinding } from '../world-factory'
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
})
