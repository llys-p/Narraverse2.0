import { describe, expect, it } from 'vitest'
import type { MasterAssetSummary } from '@/lib/api-client'
import { masterToReferenceInput } from './library-source'

describe('Master source to library reference', () => {
  it('stores a versioned pointer without copying source body or changing Master', () => {
    const master = {
      master_item_id: 'master-1', name: '林冲', semantic_type: 'character',
      master_revision: 'sha256:abc', tags: ['豹子头'], description: '原件简介',
      source_id: 's1', source_name: '水浒', source_revision: 'sha256:source',
    } as MasterAssetSummary
    const result = masterToReferenceInput(master)
    expect(result).toMatchObject({
      name: '林冲', type: 'character', origin: 'reference', loadMode: 'auto',
      source: { kind: 'master', id: 'master-1', revision: 'sha256:abc', label: '林冲' },
    })
    expect(result).not.toHaveProperty('content')
    expect(master).not.toHaveProperty('origin')
  })

  it('falls back to other for an unsupported semantic type', () => {
    const input = { master_item_id: 'x', name: '未知', semantic_type: 'unexpected', master_revision: '' } as MasterAssetSummary
    expect(masterToReferenceInput(input).type).toBe('other')
  })
})
