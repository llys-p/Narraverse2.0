import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeLoreItemImage, uploadLoreItemImages } from './lore'

describe('Lore item image attachments', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uploads repeated files with the exact workspace and lets the browser set the multipart boundary', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: 'lore/one', images: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = new File(['first'], 'first.png', { type: 'image/png' })
    const second = new File(['second'], 'second.webp', { type: 'image/webp' })

    await uploadLoreItemImages('lore/one', 'D:/books/雪', [first, second])

    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/lore/items/lore%2Fone/images')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toBeUndefined()
    const body = init?.body as FormData
    expect(body.get('workspace')).toBe('D:/books/雪')
    expect((body.getAll('files') as File[]).map((file) => file.name)).toEqual(['first.png', 'second.webp'])
  })

  it('removes one attachment association with a JSON body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: 'lore-1', images: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await removeLoreItemImage('lore-1', 'D:/books/current', 'assets/lore/keep.png')

    const [, init] = fetchMock.mock.calls[0]
    expect(init?.method).toBe('DELETE')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({ workspace: 'D:/books/current', image_path: 'assets/lore/keep.png' })
  })
})
