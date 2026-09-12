import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError } from '@/lib/api-client'
import {
  archiveWorld,
  createWorld,
  getWorld,
  listWorlds,
  previewWorldContext,
  updateWorld,
} from '../world-api'
import type { World } from '../types'
import { emptyContextSelection } from '../world-context'

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

describe('context preview HTTP contract (3.1A2)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs the read-only context-preview shape to the world id path', async () => {
    const envelope = { preview: { worldId: 'w1', identity: { name: 'N' } } }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(envelope))
    globalThis.fetch = fetchMock as typeof fetch

    const body = {
      consumer: 'writing' as const,
      expectedWorldRevision: 'sha256:9',
      selection: { ...emptyContextSelection(), characterIds: ['c1'] },
    }
    await expect(previewWorldContext('w 1', body)).resolves.toEqual(envelope)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/worlds/w%201/context-preview')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    // 请求体绝不含 worldId；path 是唯一世界来源。
    expect(JSON.parse(init.body)).toEqual({
      consumer: 'writing',
      expectedWorldRevision: 'sha256:9',
      selection: expect.objectContaining({ characterIds: ['c1'], includeTone: false }),
    })
    expect(JSON.parse(init.body)).not.toHaveProperty('worldId')
  })

  it('surfaces a 403 untrusted consumer as APIError carrying the stable code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ code: 'consumer_not_trusted', error: '当前阶段不允许该模式请求世界上下文' }),
    })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      previewWorldContext('w1', { consumer: 'game', expectedWorldRevision: 'r', selection: emptyContextSelection() }),
    ).rejects.toMatchObject({ status: 403, code: 'consumer_not_trusted' } satisfies Partial<APIError>)
  })

  it('forwards the caller AbortSignal without creating its own request lifecycle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ preview: {} }))
    globalThis.fetch = fetchMock as typeof fetch
    const controller = new AbortController()
    const body = {
      consumer: 'writing' as const,
      expectedWorldRevision: 'sha256:9',
      selection: emptyContextSelection(),
    }

    await previewWorldContext('w1', body, controller.signal)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBe(controller.signal)
  })

  it('propagates cancellation without retrying', async () => {
    const aborted = new DOMException('Aborted', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(aborted)
    globalThis.fetch = fetchMock as typeof fetch
    const controller = new AbortController()
    controller.abort()
    await expect(previewWorldContext('w1', {
      consumer: 'writing', expectedWorldRevision: 'sha256:1', selection: emptyContextSelection(),
    }, controller.signal)).rejects.toBe(aborted)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [400, 'invalid_request'], [400, 'selection_invalid'],
    [404, 'world_not_found'], [409, 'revision_conflict'], [409, 'world_archived'],
    [413, 'budget_exceeded'], [500, 'projection_failed'], [503, 'world_unavailable'],
  ])('preserves HTTP %s and %s without retrying', async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code, error: 'Preview unavailable', field: 'selection', layer: 'snapshot_bytes',
    }, Number(status)))
    globalThis.fetch = fetchMock as typeof fetch
    await expect(previewWorldContext('w1', {
      consumer: 'writing', expectedWorldRevision: 'sha256:1', selection: emptyContextSelection(),
    })).rejects.toMatchObject({
      status, code, payload: { field: 'selection', layer: 'snapshot_bytes' },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

})
