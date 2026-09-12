import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError } from '@/lib/api-client'
import { useWorldContextPreview } from '../use-world-context-preview'
import { emptyContextSelection, type WorldContextUIView } from '../world-context'

vi.mock('../world-api', () => ({
  previewWorldContext: vi.fn(),
}))

import { previewWorldContext } from '../world-api'

const mockedPreview = vi.mocked(previewWorldContext)

function makeView(overrides: Partial<WorldContextUIView> = {}): WorldContextUIView {
  return {
    schemaVersion: 1,
    worldId: 'w1',
    worldRevision: 'sha256:1',
    consumer: 'writing',
    contextFingerprint: 'v1|x',
    canonicalSelection: emptyContextSelection(),
    identity: { name: '测试世界' },
    setting: undefined,
    characters: [],
    locations: [],
    factions: [],
    timeline: [],
    materials: [],
    omissions: [],
    warnings: [],
    stats: { characterCount: 0, locationCount: 0, factionCount: 0, timelineCount: 0, materialCount: 0 },
    sourceTable: {},
    revisionLabel: 'r1',
    isDraftPreview: false,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const input = () => ({
  consumer: 'writing' as const,
  expectedWorldRevision: 'sha256:1',
  selection: { ...emptyContextSelection(), characterIds: ['c1'] },
})

beforeEach(() => {
  mockedPreview.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('useWorldContextPreview 会话内状态', () => {
  it('初始为 idle、无 preview、空选择，且不触碰任何浏览器存储', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useWorldContextPreview())
    expect(result.current.state).toBe('idle')
    expect(result.current.preview).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.selection).toEqual(emptyContextSelection())
    expect(setItem).not.toHaveBeenCalled()
    expect(mockedPreview).not.toHaveBeenCalled()
  })

  it('请求成功：loading → ready，保存 selection 与 preview，并按 id+body 调用 client', async () => {
    mockedPreview.mockResolvedValue({ preview: makeView() })
    const { result } = renderHook(() => useWorldContextPreview())

    await act(async () => {
      await result.current.requestPreview('w1', input())
    })

    expect(mockedPreview).toHaveBeenCalledWith('w1', {
      consumer: 'writing',
      expectedWorldRevision: 'sha256:1',
      selection: expect.objectContaining({ characterIds: ['c1'] }),
    })
    expect(result.current.state).toBe('ready')
    expect(result.current.preview?.identity.name).toBe('测试世界')
    expect(result.current.selection.characterIds).toEqual(['c1'])
    expect(result.current.error).toBeNull()
  })

  it('请求失败：loading → error，保留错误对象', async () => {
    mockedPreview.mockRejectedValue(new APIError('boom', { status: 409, code: 'revision_conflict' }))
    const { result } = renderHook(() => useWorldContextPreview())

    await act(async () => {
      await result.current.requestPreview('w1', input())
    })

    expect(result.current.state).toBe('error')
    expect(result.current.preview).toBeNull()
    expect(result.current.error).toMatchObject({ status: 409, code: 'revision_conflict' })
  })

  it('旧请求晚返回时被请求序号丢弃，不覆盖新请求结果', async () => {
    const first = deferred<{ preview: WorldContextUIView }>()
    const second = deferred<{ preview: WorldContextUIView }>()
    mockedPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useWorldContextPreview())

    act(() => {
      void result.current.requestPreview('w1', { ...input(), expectedWorldRevision: 'r-old' })
    })
    act(() => {
      void result.current.requestPreview('w1', { ...input(), expectedWorldRevision: 'r-new' })
    })
    expect(result.current.state).toBe('loading')

    // 第二个请求先返回。
    await act(async () => second.resolve({ preview: makeView({ worldRevision: 'r-new' }) }))
    expect(result.current.preview?.worldRevision).toBe('r-new')

    // 第一个（更旧的）请求再返回，必须被丢弃。
    await act(async () => first.resolve({ preview: makeView({ worldRevision: 'r-old' }) }))
    expect(result.current.preview?.worldRevision).toBe('r-new')
    expect(result.current.state).toBe('ready')
  })

  it('markStale 保留旧预览，reset 回到 idle', async () => {
    mockedPreview.mockResolvedValue({ preview: makeView() })
    const { result } = renderHook(() => useWorldContextPreview())
    await act(async () => result.current.requestPreview('w1', input()))
    expect(result.current.state).toBe('ready')

    act(() => result.current.markStale())
    expect(result.current.state).toBe('stale')
    // stale 仍保留旧 preview。
    expect(result.current.preview).not.toBeNull()

    act(() => result.current.reset())
    expect(result.current.state).toBe('idle')
    expect(result.current.preview).toBeNull()
  })

  it('组件卸载后在途请求返回不写入状态、不抛错', async () => {
    const gate = deferred<{ preview: WorldContextUIView }>()
    mockedPreview.mockReturnValue(gate.promise)
    const { result, unmount } = renderHook(() => useWorldContextPreview())
    act(() => void result.current.requestPreview('w1', input()))
    unmount()
    await expect(act(async () => gate.resolve({ preview: makeView() }))).resolves.toBeUndefined()
  })

  it.each([false, true])('loading 时世界改变必须使请求失效（已有预览=%s）', async (hasPreview) => {
    const { result } = renderHook(() => useWorldContextPreview())
    if (hasPreview) {
      mockedPreview.mockResolvedValueOnce({ preview: makeView() })
      await act(async () => result.current.requestPreview('w1', input()))
    }
    const gate = deferred<{ preview: WorldContextUIView }>()
    mockedPreview.mockReturnValueOnce(gate.promise)
    act(() => void result.current.requestPreview('w1', input()))
    act(() => result.current.markStale())
    expect(result.current.state).toBe(hasPreview ? 'stale' : 'idle')
    await act(async () => gate.resolve({ preview: makeView({ worldRevision: 'late' }) }))
    expect(result.current.state).toBe(hasPreview ? 'stale' : 'idle')
    expect(result.current.preview?.worldRevision).toBe(hasPreview ? 'sha256:1' : undefined)
  })

  it.each(['resolve', 'reject'] as const)('reset 取消后迟到 %s 不恢复旧状态', async (outcome) => {
    const gate = deferred<{ preview: WorldContextUIView }>()
    mockedPreview.mockReturnValueOnce(gate.promise)
    const { result } = renderHook(() => useWorldContextPreview())
    act(() => void result.current.requestPreview('w1', input()))
    act(() => result.current.reset())
    await act(async () => {
      if (outcome === 'resolve') gate.resolve({ preview: makeView() })
      else gate.reject(new Error('late failure'))
    })
    expect(result.current.state).toBe('idle')
    expect(result.current.preview).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('旧请求失败不覆盖较新成功结果', async () => {
    const first = deferred<{ preview: WorldContextUIView }>()
    mockedPreview.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ preview: makeView() })
    const { result } = renderHook(() => useWorldContextPreview())
    act(() => void result.current.requestPreview('w1', input()))
    await act(async () => result.current.requestPreview('w1', input()))
    await act(async () => first.reject(new Error('late failure')))
    expect(result.current.state).toBe('ready')
    expect(result.current.error).toBeNull()
  })
})
