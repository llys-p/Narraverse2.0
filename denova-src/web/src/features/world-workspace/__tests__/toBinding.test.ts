import { describe, expect, it } from 'vitest'
import { toBinding } from '../components/BindingPicker'
import type { MasterAssetSummary } from '@/lib/api-client'

function asset(partial: Partial<MasterAssetSummary> = {}): MasterAssetSummary {
  return {
    master_item_id: 'master/1',
    name: '卡蕾妮',
    tags: ['主角'],
    nested_entry_count: 0,
    record_kind: 'character_template',
    semantic_type: 'character',
    source_id: 'src',
    source_name: 'source',
    source_revision: 'sha256:src',
    master_revision: 'sha256:abc',
    availability: 'usable',
    usage_count: 0,
    pipeline: { availability: 'usable', nodes: [], issues: [] },
    ...partial,
  } as MasterAssetSummary
}

describe('toBinding 记录绑定基线版本', () => {
  it('把总库 master_revision 写入 binding.masterRevision，并保留薄摘要', () => {
    const b = toBinding(asset())
    expect(b.masterRevision).toBe('sha256:abc')
    expect(b.masterItemId).toBe('master/1')
    expect(b.nameSnapshot).toBe('卡蕾妮')
    expect(b.tagsSnapshot).toEqual(['主角'])
    expect(b.recordKind).toBe('character_template')
    expect(b.semanticType).toBe('character')
    expect(b.bindingId).toBeTruthy()
    expect(b.boundAt).toBeTruthy()
  })

  it('master_revision 缺省时回退空串（语义=尚未检查），tags 非数组时回退空数组', () => {
    const b = toBinding(asset({ master_revision: '', tags: undefined }))
    expect(b.masterRevision).toBe('')
    expect(b.tagsSnapshot).toEqual([])
  })

  it('未知 semantic_type 归一为 other，lorebook 记录类型正确映射', () => {
    expect(toBinding(asset({ semantic_type: 'weird' })).semanticType).toBe('other')
    expect(toBinding(asset({ record_kind: 'lorebook_template' })).recordKind).toBe('lorebook_template')
  })
})
