import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateLoreFields, LoreTranslationError } from './local-translation'
import type { LoreTranslationRequest } from './local-translation'

describe('translateLoreFields', () => {
  const baseRequest: LoreTranslationRequest = {
    target_language: 'zh-CN',
    context: { item_id: '1', item_name: 'Test', item_type: 'character' },
    fields: { content: 'Hello world' },
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns translated fields on success', async () => {
    const mockResponse = {
      ok: true,
      model: 'hy-mt1.5:1.8b-q4_k_m',
      fields: { content: '你好世界' },
      translated_fields: ['content'],
      skipped_fields: [],
    }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }) as any

    const result = await translateLoreFields(baseRequest)
    expect(result.ok).toBe(true)
    expect(result.fields.content).toBe('你好世界')
    expect(result.translated_fields).toEqual(['content'])
  })

  it('parses backend error code and message on failure', async () => {
    const errorBody = { ok: false, code: 'model_missing', error: '尚未安装 HY-MT 本地翻译模型' }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve(errorBody),
    }) as any

    await expect(translateLoreFields(baseRequest)).rejects.toThrow(LoreTranslationError)
    await expect(translateLoreFields(baseRequest)).rejects.toMatchObject({
      code: 'model_missing',
      message: '尚未安装 HY-MT 本地翻译模型',
    })
  })

  it('throws bridge_offline when fetch fails (not abort)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any

    await expect(translateLoreFields(baseRequest)).rejects.toThrow(LoreTranslationError)
    await expect(translateLoreFields(baseRequest)).rejects.toMatchObject({ code: 'bridge_offline' })
  })

  it('supports AbortSignal cancellation', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as any

    const promise = translateLoreFields(baseRequest, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(DOMException)
  })

  it('sends correct request body and headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, model: 'test', fields: {}, translated_fields: [], skipped_fields: [] }),
    })
    globalThis.fetch = fetchMock as any

    await translateLoreFields(baseRequest)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8097/api/denova/translator/translate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseRequest),
      }),
    )
  })
})
