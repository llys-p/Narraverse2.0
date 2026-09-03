import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNarraverseMaterial, importMaterial, listNarraverseMaterials } from './material-library'

describe('Narraverse material library bridge', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists stable source references from the loopback bridge', async () => {
    const material = { source_id: 'abcdef0123456789abcdef01', name: 'world.json', relative_path: '世界观设定/world.json', kind: 'lorebook' as const, bytes: 12, sha256: 'hash' }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, materials: [material] }) })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(listNarraverseMaterials()).resolves.toEqual([material])
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8097/api/denova/materials')
  })

  it('turns a full binary response into the same file bytes', async () => {
    const bytes = new TextEncoder().encode('{"entries":[]}')
    const material = { source_id: 'abcdef0123456789abcdef01', name: 'world.json', relative_path: '世界观设定/world.json', kind: 'lorebook' as const, bytes: bytes.length, sha256: 'hash' }
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer }) as typeof fetch
    const file = await fetchNarraverseMaterial(material)
    expect(file.name).toBe('world.json')
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(bytes))
  })

  it('defaults imports to Master management and normalizes field targets', async () => {
    const response = {
      kind: 'lorebook', name: 'Harbor', entry_count: 1, created_ids: [], updated_ids: [], conflict_ids: [], skipped_ids: [], failed: [], item_ids: [],
      management_mode: 'master_managed', status: 'pending_translation', import_id: 'import-1', master_workspace: 'C:/master', master_source_id: 'source-1', master_item_ids: ['master-1'],
      translation_targets: [{ import_id: 'import-1', source_id: 'source-1', source_revision: 'sha256:source', master_item_id: 'master-1', item_name: 'Harbor', field_path: 'lore_entry.content', source_text: 'English', source_sha256: 'hash', mode: 'faithful_zh', apply_policy: 'master_auto', required: true, status: 'queued' }],
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(response) })
    globalThis.fetch = fetchMock as typeof fetch

    const result = await importMaterial(new File(['{}'], 'harbor.json'))
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.body as FormData).get('management_mode')).toBe('master_managed')
    expect(result.status).toBe('pending_translation')
    expect(result.translation_targets).toEqual(response.translation_targets)
  })
})
