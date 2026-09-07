import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMasterAssetPipeline, listMasterAssets, removeMasterAsset, stopMasterAsset } from './master-library'

describe('Master library query client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('builds read-only asset filters without touching the material importer', async () => {
    const response = { assets: [], total: 0 }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(response) })
    globalThis.fetch = fetchMock as typeof fetch

    await expect(listMasterAssets({ query: 'Aiko', recordKind: 'character_template', availability: 'usable', limit: 20, offset: 10 })).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/library/assets?q=Aiko&record_kind=character_template&availability=usable&limit=20&offset=10', expect.anything())
  })

  it('reads one asset pipeline projection by Master item id', async () => {
    const response = { availability: 'staging', nodes: [], issues: [], translation: { total_fields: 0, active_fields: 0, pending_fields: 0, review_fields: 0, failed_fields: 0, content_version_kind: {} }, usage_count: 0 }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(response) })
    globalThis.fetch = fetchMock as typeof fetch

    await expect(fetchMasterAssetPipeline('master/item-1')).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/library/assets/master%2Fitem-1/pipeline', expect.anything())
  })

  it('controls and removes a Master asset through asset-level endpoints', async () => {
    const response = { master_item_id: 'master-1', stopped_fields: 1, cancelled_tasks: 1, deleted_tasks: 0, pending_tasks: 0, queue_available: true }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(response) })
    globalThis.fetch = fetchMock as typeof fetch

    await expect(stopMasterAsset('master-1')).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/library/assets/master-1/stop', expect.objectContaining({ method: 'POST' }))

    const removal = { master_item_id: 'master-1', archived_at: '2026-09-07T00:00:00Z', preserved_instance_count: 1, queue: response }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(removal) })
    await expect(removeMasterAsset('master-1')).resolves.toEqual(removal)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/library/assets/master-1', expect.objectContaining({ method: 'DELETE' }))
  })
})
