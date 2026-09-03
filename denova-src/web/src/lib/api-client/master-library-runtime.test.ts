import { describe, expect, it } from 'vitest'
import type { MasterAssetDetail } from './master-library'
import { buildMasterTranslationRuntime } from './master-library-runtime'

const detail = {
  summary: { master_item_id: 'master-1' },
  item: {
    fields: {
      scenario: { needs_translation: true, active_kind: 'hy_mt_active', active_translation_version_id: 'version-1' },
      mes_example: { needs_translation: true },
      system_prompt: { needs_translation: true },
    },
  },
  translations: [{ version: { translation_version_id: 'version-1', field_path: 'scenario' }, content_version_kind: 'hy_mt_active' }],
} as unknown as MasterAssetDetail

describe('master library translation runtime aggregation', () => {
  it('joins queue jobs to Master fields without persisting runtime state', () => {
    const runtime = buildMasterTranslationRuntime(detail, {
      paused: false,
      jobs: [
        { master_item_id: 'master-1', field: 'mes_example', status: 'failed', error: 'worker timeout', id: 'job-1', updated_at: '2026-08-29T01:00:00Z', base_revision: 'item-r1', source_sha256: 'sha', model: 'hy-mt' } as never,
        { master_item_id: 'master-1', field: 'system_prompt', status: 'pending_review', error: '', id: 'job-2', updated_at: '2026-08-29T01:01:00Z', base_revision: 'item-r1', source_sha256: 'sha', model: 'hy-mt', apply_policy: 'master_review' } as never,
        { master_item_id: 'other', field: 'scenario', status: 'running', error: '', id: 'job-other', updated_at: '2026-08-29T01:02:00Z' } as never,
      ],
    })

    expect(runtime.total_fields).toBe(3)
    expect(runtime.active_fields).toBe(1)
    expect(runtime.failed_fields).toBe(1)
    expect(runtime.review_fields).toBe(1)
    expect(runtime.fields.find((field) => field.field_path === 'mes_example')).toMatchObject({
      task_status: 'failed',
      failure_reason: 'worker timeout',
      input_revision: 'item-r1',
    })
    expect(runtime.fields.find((field) => field.field_path === 'system_prompt')).toMatchObject({
      task_status: 'completed',
      review_required: true,
    })
  })
})
