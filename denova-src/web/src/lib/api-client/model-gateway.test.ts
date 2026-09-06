import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchModelStatus, testModel } from './model-gateway'

const { requestJSON } = vi.hoisted(() => ({ requestJSON: vi.fn() }))

vi.mock('./client', () => ({
  jsonHeaders: { 'Content-Type': 'application/json' },
  requestJSON,
}))

describe('model gateway client', () => {
  beforeEach(() => requestJSON.mockReset())

  it('refreshes the effective status for a specific module', async () => {
    requestJSON.mockResolvedValue({ module: 'module4', configured: false })

    await expect(fetchModelStatus('module4')).resolves.toEqual({ module: 'module4', configured: false })
    expect(requestJSON).toHaveBeenCalledWith('/api/model/status?module=module4')
  })

  it('runs a module-scoped connection test through the shared endpoint', async () => {
    requestJSON.mockResolvedValue({ ok: true, module: 'narraverse', message: 'ok' })

    await expect(testModel('narraverse')).resolves.toMatchObject({ ok: true })
    expect(requestJSON).toHaveBeenCalledWith('/api/model/test?module=narraverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: 'narraverse' }),
    })
  })
})
