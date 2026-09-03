import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMasterAssetPipeline, listMasterAssets } from './master-library'

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
})
