import { describe, expect, it } from 'vitest'
import { batchTranslationJobs } from './LoreBatchTranslationDialog'
import type { LoreItem } from '@/lib/api'

const item: LoreItem = {
  id: 'alice', enabled: true, type: 'character', type_source: 'manual', name: 'Alice',
  importance: 'major', load_mode: 'auto', tags: [], keywords: [],
  brief_description: 'A brave hero.', content: 'Long English content.',
  created_at: 'c1', updated_at: 'r1',
}

describe('batchTranslationJobs', () => {
  it('queues localized names and descriptions by default', () => {
    const jobs = batchTranslationJobs([item], 'metadata')
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ field: 'name', mode: 'name_zh', apply_policy: 'auto_apply_metadata' })
    expect(jobs[1]).toMatchObject({ field: 'brief_description', mode: 'faithful_zh', apply_policy: 'auto_apply_metadata' })
  })

  it('auto-applies batch content and skips fields without Latin text', () => {
    const jobs = batchTranslationJobs([{ ...item, name: '爱丽丝', brief_description: '勇敢的英雄。' }], 'all')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ field: 'content', apply_policy: 'auto_apply_metadata' })
  })
})
