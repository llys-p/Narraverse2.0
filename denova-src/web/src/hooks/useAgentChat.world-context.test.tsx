import { act, renderHook } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeChatContext } from '@/lib/api'
import {
  WorldContextLaunchProvider,
  useWorldContextLaunch,
  type WritingWorldContextLaunch,
} from '@/features/world-context-runtime/WorldContextLaunchProvider'
import { WorldContextRunProvider } from '@/features/world-context-runtime/WorldContextRunProvider'
import { useAgentChat } from './useAgentChat'

const chatMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  resumeStream: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  options: null as Record<string, any> | null,
  status: 'ready' as 'ready' | 'submitted' | 'streaming',
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, any>) => {
    chatMock.options = options
    return {
      messages: [],
      setMessages: chatMock.setMessages,
      sendMessage: chatMock.sendMessage,
      resumeStream: chatMock.resumeStream,
      stop: chatMock.stop,
      status: chatMock.status,
    }
  },
}))

vi.mock('@/lib/api', () => ({
  abortChat: vi.fn(),
  analyzeChatContext: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  executeCommand: vi.fn(),
  getActiveChatTask: vi.fn().mockResolvedValue({ active: false }),
  getMessagesPage: vi.fn().mockResolvedValue({ messages: [], nextBefore: '0', hasMore: false, total: 0 }),
  getSessions: vi.fn().mockResolvedValue([]),
  renameSession: vi.fn(),
  switchSession: vi.fn(),
}))

vi.mock('@/features/settings/api', () => ({
  fetchSettings: vi.fn().mockResolvedValue({ effective: {} }),
}))

function makeSeed(): WritingWorldContextLaunch {
  return {
    worldId: 'world-1',
    expectedWorldRevision: 'rev-3',
    selection: {
      includeTone: true,
      ruleIndexes: [0],
      characterIds: ['char-1'],
      locationIds: [],
      factionIds: [],
      timelineEntryIds: [],
      bindingIds: ['bind-1'],
    },
    worldName: '测试世界',
    revisionLabel: 'rev·3',
    selectedCount: 3,
    launchedAt: 1,
  }
}

function makeWrapper(seedRef: { current: WritingWorldContextLaunch | null }) {
  function Seeder() {
    const launch = useWorldContextLaunch()
    useEffect(() => {
      if (seedRef.current) launch.launchWriting(seedRef.current)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <WorldContextLaunchProvider>
        <Seeder />
        <WorldContextRunProvider>{children}</WorldContextRunProvider>
      </WorldContextLaunchProvider>
    )
  }
}

function lastSendBody() {
  const call = chatMock.sendMessage.mock.calls.at(-1)
  return (call?.[1] as { body?: Record<string, unknown> })?.body
}

describe('useAgentChat world context (Phase 3.2-A6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatMock.status = 'ready'
    chatMock.sendMessage.mockResolvedValue(undefined)
  })

  it('direct first send carries world_context and no analysis_handle', async () => {
    const seedRef = { current: makeSeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    expect(result.current.hasBoundWorldContext).toBe(true)
    expect(result.current.worldContextState).toBe('bound')

    await act(async () => {
      expect(await result.current.send('继续写')).toBe(true)
    })

    const body = lastSendBody()
    expect(body?.world_context).toEqual({
      worldId: 'world-1',
      expectedWorldRevision: 'rev-3',
      selection: expect.objectContaining({ includeTone: true, characterIds: ['char-1'] }),
    })
    expect(body?.analysis_handle).toBeUndefined()
  })

  it('after analysis the first send carries only analysis_handle, then later sends fall back to Ref', async () => {
    vi.mocked(analyzeChatContext).mockResolvedValue({
      analysis: '背景分析',
      world_context: { state: 'bound', worldName: '测试世界', revisionLabel: 'rev·3', selectedCount: 3 },
      analysis_handle: 'a'.repeat(43),
    } as unknown as Awaited<ReturnType<typeof analyzeChatContext>>)
    const seedRef = { current: makeSeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    await act(async () => {
      await result.current.analyzeContext('分析一下')
    })
    expect(result.current.analysisHandleStatus).toBeNull()

    await act(async () => {
      expect(await result.current.send('按分析写')).toBe(true)
    })
    const first = lastSendBody()
    expect(first?.analysis_handle).toBe('a'.repeat(43))
    expect(first?.world_context).toBeUndefined()

    // handle 一次性消费；后续新 run 回到 Ref。
    await act(async () => {
      expect(await result.current.send('再续一段')).toBe(true)
    })
    const second = lastSendBody()
    expect(second?.analysis_handle).toBeUndefined()
    expect(second?.world_context).toEqual(expect.objectContaining({ worldId: 'world-1' }))
  })

  it('keeps the Ref when a request fails and retries with it', async () => {
    chatMock.sendMessage.mockRejectedValueOnce(new Error('offline'))
    const seedRef = { current: makeSeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    await act(async () => {
      expect(await result.current.send('写')).toBe(false)
    })
    expect(result.current.hasBoundWorldContext).toBe(true)

    await act(async () => {
      expect(await result.current.send('重试')).toBe(true)
    })
    expect(lastSendBody()?.world_context).toEqual(expect.objectContaining({ worldId: 'world-1' }))
  })

  it('consumes SSE world_context_state parts and ignores unknown states', () => {
    const seedRef = { current: makeSeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    act(() => {
      chatMock.options?.onData?.({
        type: 'data-world-context-state',
        data: { state: 'active', worldName: '测试世界', revisionLabel: 'rev·3', selectedCount: 3 },
      })
    })
    expect(result.current.worldContextState).toBe('active')

    act(() => {
      chatMock.options?.onData?.({
        type: 'data-world-context-state',
        data: { state: 'degraded', errorCode: 'world_not_found' },
      })
    })
    expect(result.current.worldContextState).toBe('degraded')
    expect(result.current.worldErrorCode).toBe('world_not_found')

    const before = result.current.worldContextState
    act(() => {
      chatMock.options?.onData?.({ type: 'data-world-context-state', data: { state: 'something-new' } })
    })
    expect(result.current.worldContextState).toBe(before)
  })

  it('clearWorldContext drops Ref/handle and later sends are bare', async () => {
    const seedRef = { current: makeSeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    act(() => result.current.clearWorldContext())
    expect(result.current.hasBoundWorldContext).toBe(false)
    expect(result.current.worldContextState).toBe('none')

    await act(async () => {
      expect(await result.current.send('裸发')).toBe(true)
    })
    const body = lastSendBody()
    expect(body?.world_context).toBeUndefined()
    expect(body?.analysis_handle).toBeUndefined()
  })

  it('bare writing (no launch) never sends world fields', async () => {
    const seedRef = { current: null }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    expect(result.current.worldContextState).toBe('none')
    await act(async () => {
      expect(await result.current.send('普通写作')).toBe(true)
    })
    const body = lastSendBody()
    expect(body?.world_context).toBeUndefined()
    expect(body?.analysis_handle).toBeUndefined()
  })
})
