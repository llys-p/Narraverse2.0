import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateLoreItem } from './lore'

describe('workspace-guarded lore pin updates', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends workspace and the current revision without changing the existing endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await updateLoreItem('lore/one', { name: '灯塔', pinned: true, pin_order: 3 }, 'r1', 'D:/books/雪')
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/lore/items/lore%2Fone')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ name: '灯塔', pinned: true, pin_order: 3, base_revision: 'r1', workspace: 'D:/books/雪' })
  })

  it('keeps the old request body when workspace and pin fields are omitted', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await updateLoreItem('one', { name: '原条目' })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ name: '原条目' })
  })
})
