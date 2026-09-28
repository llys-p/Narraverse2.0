import { act, renderHook } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LibraryContextLaunchProvider,
  useLibraryContextLaunch,
  type WritingLibraryContextLaunch,
} from '@/features/library-context-runtime/LibraryContextLaunchProvider'
import { LibraryContextRunProvider } from '@/features/library-context-runtime/LibraryContextRunProvider'
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

function makeLibrarySeed(): WritingLibraryContextLaunch {
  return {
    libraryId: 'lib-1',
    expectedRevision: 'rev-9',
    manualItemIds: ['item-a', 'item-b'],
    libraryName: '测试设定库',
    revisionLabel: 'rev·9',
    selectedCount: 2,
  }
}

function makeWorldSeed(): WritingWorldContextLaunch {
  return {
    worldId: 'world-1',
    expectedWorldRevision: 'rev-3',
    selection: { includeTone: true, ruleIndexes: [0], characterIds: ['char-1'], locationIds: [], factionIds: [], timelineEntryIds: [], bindingIds: ['bind-1'] },
    worldName: '测试世界',
    revisionLabel: 'rev·3',
    selectedCount: 3,
    launchedAt: 1,
  }
}

function makeWrapper(
  libSeedRef: { current: WritingLibraryContextLaunch | null },
  worldSeedRef: { current: WritingWorldContextLaunch | null } = { current: null },
) {
  function LibrarySeeder() {
    const launch = useLibraryContextLaunch()
    useEffect(() => {
      if (libSeedRef.current) launch.launchWritingLibrary(libSeedRef.current)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  }
  function WorldSeeder() {
    const launch = useWorldContextLaunch()
    useEffect(() => {
      if (worldSeedRef.current) launch.launchWriting(worldSeedRef.current)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <WorldContextLaunchProvider>
        <WorldSeeder />
        <WorldContextRunProvider>
          <LibraryContextLaunchProvider>
            <LibrarySeeder />
            <LibraryContextRunProvider>{children}</LibraryContextRunProvider>
          </LibraryContextLaunchProvider>
        </WorldContextRunProvider>
      </WorldContextLaunchProvider>
    )
  }
}

function lastSendBody() {
  const call = chatMock.sendMessage.mock.calls.at(-1)
  return (call?.[1] as { body?: Record<string, unknown> })?.body
}

describe('useAgentChat library context (B2b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatMock.status = 'ready'
    chatMock.sendMessage.mockResolvedValue(undefined)
  })

  it('consumes a library launch created after the chat hook has mounted', async () => {
    const seedRef = { current: null }
    const { result } = renderHook(() => ({
      chat: useAgentChat(),
      launch: useLibraryContextLaunch(),
    }), { wrapper: makeWrapper(seedRef) })

    expect(result.current.chat.hasBoundLibraryContext).toBe(false)

    act(() => result.current.launch.launchWritingLibrary(makeLibrarySeed()))

    expect(result.current.chat.hasBoundLibraryContext).toBe(true)
    expect(result.current.chat.libraryContextState).toBe('bound')
    expect(result.current.chat.libraryContextSummary).toEqual(expect.objectContaining({
      libraryName: '测试设定库',
      revisionLabel: 'rev·9',
      selectedCount: 2,
    }))

    await act(async () => {
      expect(await result.current.chat.send('挂载后带入库背景')).toBe(true)
    })

    const body = lastSendBody()
    expect(body?.background_source).toBe('library')
    expect(body?.library_context).toEqual({
      libraryId: 'lib-1',
      expectedRevision: 'rev-9',
      manualItemIds: ['item-a', 'item-b'],
    })
  })

  it('library mode sends no free-form identity fields, world carrier, analysis handle, or lore references', async () => {
    const seedRef = { current: makeLibrarySeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    act(() => result.current.addLoreReference('lore-old'))

    await act(async () => {
      expect(await result.current.send('写第一章')).toBe(true)
    })

    const body = lastSendBody()
    // 真实页面不发送自由 consumer/运行身份（B2a 冻结契约：服务端派生，越权键 400）。
    expect(body?.consumer).toBeUndefined()
    expect(body?.scopeKey).toBeUndefined()
    expect(body?.runContextId).toBeUndefined()
    expect(body?.library_context).toEqual(expect.objectContaining({
      libraryId: 'lib-1',
      expectedRevision: 'rev-9',
      manualItemIds: ['item-a', 'item-b'],
    }))
    expect(Object.keys(body?.library_context as Record<string, unknown>)).toEqual(['libraryId', 'expectedRevision', 'manualItemIds'])
    // 库模式与旧资料引用、世界载体、分析 handle 互斥（携带即 400）。
    expect(body?.lore_references).toEqual([])
    expect(body?.world_context).toBeUndefined()
    expect(body?.analysis_handle).toBeUndefined()
  })

  it('consumes SSE library_context_state parts and ignores unknown states', () => {
    const seedRef = { current: makeLibrarySeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    act(() => {
      chatMock.options?.onData?.({
        type: 'data-library-context-state',
        data: { state: 'active', libraryName: '测试设定库', revisionLabel: 'rev·9', selectedCount: 2 },
      })
    })
    expect(result.current.libraryContextState).toBe('active')

    act(() => {
      chatMock.options?.onData?.({ type: 'data-library-context-state', data: { state: 'none' } })
    })
    expect(result.current.libraryContextState).toBe('none')

    const before = result.current.libraryContextState
    act(() => {
      chatMock.options?.onData?.({ type: 'data-library-context-state', data: { state: 'something-new' } })
    })
    expect(result.current.libraryContextState).toBe(before)
  })

  it('clearLibraryContext restores the bare state and later sends are bare', async () => {
    const seedRef = { current: makeLibrarySeed() }
    const { result } = renderHook(() => useAgentChat(), { wrapper: makeWrapper(seedRef) })

    act(() => result.current.clearLibraryContext())
    expect(result.current.hasBoundLibraryContext).toBe(false)
    expect(result.current.libraryContextState).toBe('none')

    await act(async () => {
      expect(await result.current.send('裸发')).toBe(true)
    })
    const body = lastSendBody()
    expect(body?.background_source).toBeUndefined()
    expect(body?.library_context).toBeUndefined()
  })

  it('taking a library launch clears the world ref (mutual exclusion)', async () => {
    const libSeedRef = { current: null }
    const worldSeedRef = { current: makeWorldSeed() }
    const { result } = renderHook(() => ({
      chat: useAgentChat(),
      launch: useLibraryContextLaunch(),
    }), { wrapper: makeWrapper(libSeedRef, worldSeedRef) })

    expect(result.current.chat.hasBoundWorldContext).toBe(true)

    act(() => result.current.launch.launchWritingLibrary(makeLibrarySeed()))

    expect(result.current.chat.hasBoundWorldContext).toBe(false)
    expect(result.current.chat.hasBoundLibraryContext).toBe(true)

    await act(async () => {
      expect(await result.current.chat.send('用库背景写')).toBe(true)
    })
    const body = lastSendBody()
    expect(body?.background_source).toBe('library')
    expect(body?.library_context).toEqual(expect.objectContaining({ libraryId: 'lib-1' }))
    expect(body?.world_context).toBeUndefined()
  })

  it('taking a world launch clears the library ref (mutual exclusion, reverse order)', async () => {
    const libSeedRef = { current: makeLibrarySeed() }
    const worldSeedRef = { current: null }
    const { result } = renderHook(() => ({
      chat: useAgentChat(),
      launch: useLibraryContextLaunch(),
      worldLaunch: useWorldContextLaunch(),
    }), { wrapper: makeWrapper(libSeedRef, worldSeedRef) })

    expect(result.current.chat.hasBoundLibraryContext).toBe(true)

    act(() => result.current.worldLaunch.launchWriting(makeWorldSeed()))

    expect(result.current.chat.hasBoundLibraryContext).toBe(false)
    expect(result.current.chat.hasBoundWorldContext).toBe(true)

    await act(async () => {
      expect(await result.current.chat.send('用世界背景写')).toBe(true)
    })
    const body = lastSendBody()
    expect(body?.background_source).toBeUndefined()
    expect(body?.library_context).toBeUndefined()
    expect(body?.world_context).toEqual(expect.objectContaining({ worldId: 'world-1' }))
  })
})
