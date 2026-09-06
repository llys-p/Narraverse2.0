import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TranslationQueueControl, visibleTranslationJobs } from './TranslationQueueControl'
import {
  applyMasterTranslation,
  deleteTranslationJob,
  getLoreItems,
  getTranslationJob,
  getTranslationQueue,
  resolveTranslationJob,
  setTranslationQueuePaused,
  updateLoreItem,
  type LoreItem,
  type TranslationJob,
  type TranslationQueueStatus,
} from '@/lib/api'
import { useWorkspaceStore } from '@/stores/workspace-store'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    applyMasterTranslation: vi.fn(),
    getLoreItems: vi.fn(), getTranslationJob: vi.fn(), getTranslationQueue: vi.fn(),
    resolveTranslationJob: vi.fn(), setTranslationQueuePaused: vi.fn(), updateLoreItem: vi.fn(),
    cancelTranslationJob: vi.fn(), retryTranslationJob: vi.fn(), deleteTranslationJob: vi.fn(),
  }
})

const item: LoreItem = {
  id: 'alice', enabled: true, type: 'character', type_source: 'manual', name: 'Alice',
  importance: 'major', load_mode: 'auto', tags: [], keywords: [], brief_description: 'Hero', content: 'Body',
  created_at: 'c1', updated_at: 'r1',
}

function queue(jobs: TranslationJob[] = [], pause_reasons: Array<'manual' | 'game'> = []): TranslationQueueStatus {
  const counts = jobs.reduce<TranslationQueueStatus['counts']>((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1
    return result
  }, {})
  return { ok: true, schema_version: 1, active_id: '', pause_reasons, paused: pause_reasons.length > 0, counts, jobs }
}

describe('TranslationQueueControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceStore.getState().setMode('ide')
    vi.mocked(getTranslationQueue).mockResolvedValue(queue())
    vi.mocked(setTranslationQueuePaused).mockImplementation(async (paused, reason) => queue([], paused ? [reason] : []))
  })

  it('pauses for game mode and removes only the game pause when leaving', async () => {
    const { rerender } = render(<TranslationQueueControl workspace="C:/story" mode="interactive" />)
    await waitFor(() => expect(setTranslationQueuePaused).toHaveBeenCalledWith(true, 'game'))
    rerender(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    await waitFor(() => expect(setTranslationQueuePaused).toHaveBeenCalledWith(false, 'game'))
  })

  it('auto-applies completed metadata only when the source still matches', async () => {
    const summary = {
      id: 'translation-0123456789abcdef01234567', workspace: 'C:/story', item_id: item.id, item_name: item.name,
      field: 'name', mode: 'name_zh', apply_policy: 'auto_apply_metadata', source_sha256: 'hash', source_text: 'Alice',
      base_revision: 'r1', status: 'completed', translation: '爱丽丝', model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob
    let resolved = false
    vi.mocked(getTranslationQueue).mockImplementation(async () => queue(resolved ? [] : [summary]))
    vi.mocked(getTranslationJob).mockResolvedValue({ ...summary, ok: true })
    vi.mocked(getLoreItems).mockResolvedValue([item])
    vi.mocked(updateLoreItem).mockResolvedValue({ ...item, name: '爱丽丝', updated_at: 'r2' })
    vi.mocked(resolveTranslationJob).mockImplementation(async () => { resolved = true; return { ...summary, ok: true, status: 'applied' } })

    const view = render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    await waitFor(() => expect(updateLoreItem).toHaveBeenCalledWith(item.id, expect.objectContaining({ name: '爱丽丝' }), item.updated_at))
    await waitFor(() => expect(resolveTranslationJob).toHaveBeenCalledWith(summary.id, 'applied'))
    view.unmount()
  })

  it('writes completed Master jobs back to Master without touching current lore', async () => {
    const summary = {
      id: 'translation-3123456789abcdef01234567', workspace: 'C:/story', item_id: 'master-1', master_item_id: 'master-1', item_name: 'Harbor',
      field: 'lore_entry.content', mode: 'faithful_zh', apply_policy: 'master_auto', source_sha256: 'source-hash', source_text: 'English body',
      source_id: 'source-1', source_revision: 'sha256:source', import_id: 'import-1', base_revision: 'sha256:source',
      status: 'completed', translation: '中文正文', model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob
    let resolved = false
    vi.mocked(getTranslationQueue).mockImplementation(async () => queue(resolved ? [] : [summary]))
    vi.mocked(getTranslationJob).mockResolvedValue({ ...summary, ok: true })
    vi.mocked(applyMasterTranslation).mockResolvedValue({
      translation: { translation_version_id: 'translation-version-1', activated: true, ready: true },
      import: {
        kind: 'lorebook', name: 'Harbor', entry_count: 1, created_ids: ['lore-1'], updated_ids: [], conflict_ids: [], conflicts: [], skipped_ids: [], failed: [], item_ids: ['lore-1'],
        archive_path: '.narraverse/source/originals/source-1/hash/harbor.json', manifest_path: '.narraverse/master-library-manifest.json', truncated: false,
        management_mode: 'master_managed', status: 'instantiated', import_id: 'import-1', master_workspace: 'C:/master', master_source_id: 'source-1', master_item_ids: ['master-1'], translation_targets: [],
      },
    })
    vi.mocked(resolveTranslationJob).mockImplementation(async () => { resolved = true; return { ...summary, ok: true, status: 'applied' } })

    const view = render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    await waitFor(() => expect(applyMasterTranslation).toHaveBeenCalledWith(expect.objectContaining({
      import_id: 'import-1', master_item_id: 'master-1', field_path: 'lore_entry.content', translation: '中文正文', confirmed: false,
    })))
    expect(getLoreItems).not.toHaveBeenCalled()
    expect(updateLoreItem).not.toHaveBeenCalled()
    await waitFor(() => expect(resolveTranslationJob).toHaveBeenCalledWith(summary.id, 'applied'))
    view.unmount()
  })

  it('never auto-applies content waiting for review', async () => {
    const contentJob = {
      id: 'translation-1123456789abcdef01234567', workspace: 'C:/story', item_id: item.id, item_name: item.name,
      field: 'content', mode: 'faithful_zh', apply_policy: 'review_content', source_sha256: 'hash',
      base_revision: 'r1', status: 'pending_review', model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob
    vi.mocked(getTranslationQueue).mockResolvedValue(queue([contentJob]))
    const view = render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    await waitFor(() => expect(getTranslationQueue).toHaveBeenCalled())
    expect(updateLoreItem).not.toHaveBeenCalled()
    view.unmount()
  })

  it('auto-applies batch content marked for automatic writeback', async () => {
    const contentJob = {
      id: 'translation-2123456789abcdef01234567', workspace: 'C:/story', item_id: item.id, item_name: item.name,
      field: 'content', mode: 'faithful_zh', apply_policy: 'auto_apply_metadata', source_sha256: 'hash', source_text: 'Body',
      base_revision: 'r1', status: 'completed', translation: '正文', model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob
    let resolved = false
    vi.mocked(getTranslationQueue).mockImplementation(async () => queue(resolved ? [] : [contentJob]))
    vi.mocked(getTranslationJob).mockResolvedValue({ ...contentJob, ok: true })
    vi.mocked(getLoreItems).mockResolvedValue([item])
    vi.mocked(updateLoreItem).mockResolvedValue({ ...item, content: '正文', updated_at: 'r2' })
    vi.mocked(resolveTranslationJob).mockImplementation(async () => { resolved = true; return { ...contentJob, ok: true, status: 'applied' } })

    const view = render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    await waitFor(() => expect(updateLoreItem).toHaveBeenCalledWith(item.id, expect.objectContaining({ content: '正文' }), item.updated_at))
    view.unmount()
  })

  it('adopts all existing review jobs with one action', async () => {
    const jobs = ['alice', 'bob'].map((id, index) => ({
      id: `translation-${index}${'1'.repeat(23)}`, workspace: 'C:/story', item_id: id, item_name: id,
      field: 'content', mode: 'faithful_zh', apply_policy: 'review_content', source_sha256: 'hash', source_text: `Body ${id}`,
      base_revision: 'r1', status: 'pending_review', translation: `正文 ${id}`, model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob))
    vi.mocked(getTranslationQueue).mockResolvedValue(queue(jobs))
    vi.mocked(setTranslationQueuePaused).mockResolvedValue(queue(jobs))
    vi.mocked(getTranslationJob).mockImplementation(async (id) => ({ ...jobs.find((job) => job.id === id)!, ok: true }))
    vi.mocked(getLoreItems).mockResolvedValue([
      { ...item, id: 'alice', content: 'Body alice' },
      { ...item, id: 'bob', content: 'Body bob' },
    ])
    vi.mocked(updateLoreItem).mockImplementation(async (id, input) => ({ ...item, ...input, id, updated_at: 'r2' }))
    vi.mocked(resolveTranslationJob).mockImplementation(async (id) => ({ ...jobs.find((job) => job.id === id)!, ok: true, status: 'applied' }))

    render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    fireEvent.click(await screen.findByRole('button', { name: /待确认|review/i }))
    fireEvent.click(await screen.findByTestId('translation-adopt-all'))
    await waitFor(() => expect(resolveTranslationJob).toHaveBeenCalledTimes(2))
  })

  it('renders at most 100 actionable jobs and hides applied history', () => {
    const jobs = Array.from({ length: 120 }, (_, index) => ({
      id: `translation-${String(index).padStart(24, '0')}`, status: 'pending_review',
    } as TranslationJob)).concat([{ id: 'translation-applied-history', status: 'applied' } as TranslationJob])
    const visible = visibleTranslationJobs(jobs)
    expect(visible).toHaveLength(100)
    expect(visible.some((job) => job.status === 'applied')).toBe(false)
    expect(visible[0].id).toBe(jobs[119].id)
  })

  it('clears failed and cancelled jobs in series without aborting on one error', async () => {
    const failed = ['failed-a', 'failed-b', 'failed-c'].map((id, index) => ({
      id: `translation-failed-${index}${'1'.repeat(22 - index)}`, workspace: 'C:/story', item_id: id, item_name: id,
      field: 'content', mode: 'faithful_zh', apply_policy: 'review_content', source_sha256: 'hash', source_text: 'Body',
      base_revision: 'r1', status: index === 1 ? 'cancelled' : 'failed', translation: '', model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob))
    let calls = 0
    vi.mocked(getTranslationQueue).mockImplementation(async () => queue(calls === 0 ? failed : []))
    vi.mocked(setTranslationQueuePaused).mockImplementation(async () => queue(failed))
    vi.mocked(deleteTranslationJob).mockImplementation(async (id) => {
      calls += 1
      if (id.startsWith('translation-failed-1')) throw new Error('bridge down')
      return { id, ok: true, status: 'deleted' } as never
    })

    render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    fireEvent.click(await screen.findByRole('button', { name: /翻译空闲/ }))
    fireEvent.click(await screen.findByTestId('translation-clear-failed'))
    await waitFor(() => expect(deleteTranslationJob).toHaveBeenCalledTimes(3))
    // 第二项删除失败不应中断后续清理。
    expect(vi.mocked(deleteTranslationJob)).toHaveBeenNthCalledWith(2, expect.stringContaining('translation-failed-1'))
  })

  it('routes Master translation jobs to the library instead of inline adopt/edit', async () => {
    const masterJob = {
      id: 'translation-master-review-000000000000', workspace: 'C:/story', item_id: 'master-2', master_item_id: 'master-2', item_name: 'Temple',
      field: 'lore_entry.content', mode: 'faithful_zh', apply_policy: 'master_review', source_sha256: 'source-hash', source_text: 'English',
      source_id: 'source-2', source_revision: 'sha256:source', import_id: 'import-2', base_revision: 'sha256:source',
      status: 'pending_review', translation: '中文正文', model: 'hy-mt', attempts: 1, error: '', created_at: 'c', updated_at: 'u',
    } satisfies TranslationJob
    vi.mocked(getTranslationQueue).mockResolvedValue(queue([masterJob]))
    vi.mocked(setTranslationQueuePaused).mockResolvedValue(queue([masterJob]))
    render(<TranslationQueueControl workspace="C:/story" mode="ide" />)
    fireEvent.click(await screen.findByRole('button', { name: /待确认/ }))
    const openLibrary = await screen.findByRole('button', { name: '前往总资料库处理' })
    // Master 任务不得暴露逐条采用/编辑入口。
    expect(screen.queryByRole('button', { name: '采用译文' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑冲突译文' })).toBeNull()
    expect(screen.queryByTestId('translation-adopt-all')).toBeNull()
    fireEvent.click(openLibrary)
    expect(useWorkspaceStore.getState().mode).toBe('library')
  })
})
