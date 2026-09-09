import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError } from '@/lib/api-client'
import { archiveWorld, createWorld, getWorld, listWorlds, updateWorld } from '../world-api'
import type { World } from '../types'

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

afterEach(() => vi.restoreAllMocks())

describe('world-api HTTP contract', () => {
  it('lists worlds with optional status filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worlds: [], warnings: [] }))
    globalThis.fetch = fetchMock as typeof fetch
    await listWorlds('archived')
    expect(fetchMock).toHaveBeenCalledWith('/api/worlds?status=archived', expect.anything())
  })

  it('creates a world in one POST carrying the full initial payload', async () => {
    const env = { world: { id: 'x' }, revision: 'sha256:1' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(env, 201))
    globalThis.fetch = fetchMock as typeof fetch
    const input = { name: '新世界', bindings: [], characters: [] }
    await expect(createWorld(input)).resolves.toEqual(env)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/worlds')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ name: '新世界' })
  })

  it('puts the whole world with expected_revision for CAS', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ world: {}, revision: 'sha256:2' }))
    globalThis.fetch = fetchMock as typeof fetch
    const world = { id: 'abcdef0123456789' } as World
    await updateWorld(world.id, 'sha256:1', world)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/worlds/abcdef0123456789')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ expected_revision: 'sha256:1', world })
  })

  it('archives/restores with expected_revision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ world: {}, revision: 'sha256:3' }))
    globalThis.fetch = fetchMock as typeof fetch
    await archiveWorld('abcdef0123456789', 'sha256:2', true)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ archived: true, expected_revision: 'sha256:2' })
  })

  it('surfaces a 409 revision conflict as APIError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 409, text: async () => JSON.stringify({ error: 'file revision conflict' }),
    })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(getWorld('abcdef0123456789')).rejects.toMatchObject({ status: 409 } satisfies Partial<APIError>)
  })
})
