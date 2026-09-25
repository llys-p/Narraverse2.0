import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkLibrary } from '@/lib/api-client'
import { LibraryContextPreview } from './LibraryContextPreview'
import {
  LibraryContextLaunchProvider,
  useLibraryContextLaunch,
  type WritingLibraryContextLaunch,
} from '@/features/library-context-runtime/LibraryContextLaunchProvider'
import {
  GameLibraryContextLaunchProvider,
  useGameLibraryContextLaunch,
  type GameLibraryContextLaunch,
} from '@/features/library-context-runtime/GameLibraryContextLaunchProvider'
import {
  IframeLibraryContextLaunchProvider,
  useIframeLibraryContextLaunch,
  type IframeLibraryContextLaunch,
} from '@/features/library-context-runtime/IframeLibraryContextLaunchProvider'
import { previewWorkLibrary } from '../library-context-api'

const { hostStateMock } = vi.hoisted(() => ({
  hostStateMock: { state: 'ready' as 'checking' | 'ready' | 'unavailable' },
}))

const { getInteractiveStoriesMock, getInteractiveBranchesMock, selectInteractiveStoryMock, switchInteractiveBranchMock } = vi.hoisted(() => ({
  getInteractiveStoriesMock: vi.fn(),
  getInteractiveBranchesMock: vi.fn(),
  selectInteractiveStoryMock: vi.fn(),
  switchInteractiveBranchMock: vi.fn(),
}))

vi.mock('../library-context-api', () => ({ previewWorkLibrary: vi.fn() }))
vi.mock('@/features/world-context-runtime/WorldContextHostProvider', () => ({
  useWorldContextHost: () => ({ state: hostStateMock.state, migration: null }),
}))
vi.mock('@/features/interactive/api', () => ({
  getInteractiveStories: getInteractiveStoriesMock,
  getInteractiveBranches: getInteractiveBranchesMock,
  selectInteractiveStory: selectInteractiveStoryMock,
  switchInteractiveBranch: switchInteractiveBranchMock,
}))
const library: WorkLibrary = { id: 'abcdefghijklmnop', name: '测试库', purpose: 'any', schemaVersion: 1,
  items: [
    { id: 'a', name: '按需项', type: 'character', enabled: true, loadMode: 'auto', origin: 'original', importance: 'major', createdAt: '', updatedAt: '' },
    { id: 'm', name: '手动项', type: 'rule', enabled: true, loadMode: 'manual', origin: 'original', importance: 'minor', createdAt: '', updatedAt: '' },
    { id: 'off', name: '禁用项', type: 'rule', enabled: false, loadMode: 'manual', origin: 'original', importance: 'minor', createdAt: '', updatedAt: '' },
  ], relations: [], createdAt: '', updatedAt: '' }
const result = { libraryId: library.id, revision: 'one', name: '测试库', summary: '', tone: '', startingPoint: '',
  catalog: { items: [], offset: 0, total: 0 }, loaded: [], relations: [], issues: [],
  budget: { bytes: 300, maxBytes: 262144, estimatedTokens: 100, maxEstimatedTokens: 16000 } }

/** B2b：组件无条件消费 launch Provider，测试统一在 Provider 内渲染。 */
function renderPreview(props: Partial<Parameters<typeof LibraryContextPreview>[0]>) {
  return render(
    <LibraryContextLaunchProvider>
      <LibraryContextPreview library={library} revision="one" dirty={false} {...props} />
    </LibraryContextLaunchProvider>,
  )
}

describe('library load preview', () => {
  beforeEach(() => vi.resetAllMocks())
  it('requests only after a click and excludes disabled entries', async () => {
    vi.mocked(previewWorkLibrary).mockResolvedValue(result)
    renderPreview({})
    expect(previewWorkLibrary).not.toHaveBeenCalled()
    expect(screen.queryByText(/禁用项/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生成加载预览' }))
    await waitFor(() => expect(previewWorkLibrary).toHaveBeenCalledOnce())
    expect(previewWorkLibrary).toHaveBeenCalledWith(library.id, {
      expectedRevision: 'one', manualItemIds: [], autoItemIds: [], catalogOffset: 0, catalogLimit: 50,
    })
    expect(screen.getByText(/尚未发送模型/)).toBeInTheDocument()
  })
  it('never generates from an unsaved draft', () => {
    renderPreview({ dirty: true })
    expect(screen.getByRole('button', { name: '生成加载预览' })).toBeDisabled()
    expect(previewWorkLibrary).not.toHaveBeenCalled()
  })
  it('discards a late response after revision changes and keeps prior results stale', async () => {
    let resolve!: (value: typeof result) => void
    vi.mocked(previewWorkLibrary).mockReturnValue(new Promise((done) => { resolve = done }))
    const view = renderPreview({})
    fireEvent.click(screen.getByRole('button', { name: '生成加载预览' }))
    view.rerender(
      <LibraryContextLaunchProvider>
        <LibraryContextPreview library={library} revision="two" dirty={false} />
      </LibraryContextLaunchProvider>,
    )
    await act(async () => resolve(result))
    expect(screen.queryByText(/100.*16000/)).toBeNull()
    expect(screen.getByRole('button', { name: '生成加载预览' })).not.toBeDisabled()
  })
  it('shows failures without claiming content was loaded', async () => {
    vi.mocked(previewWorkLibrary).mockRejectedValue({ code: 'revision_conflict' })
    renderPreview({})
    fireEvent.click(screen.getByRole('button', { name: '生成加载预览' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('资料库已变化'))
  })
})

describe('library launch to writing (B2b)', () => {
  beforeEach(() => vi.resetAllMocks())
  it('disables the launch button for unsaved drafts and when no book is open', () => {
    renderPreview({ dirty: true, hasWritingBook: true })
    expect(screen.getByRole('button', { name: '带入写作' })).toBeDisabled()

    renderPreview({ hasWritingBook: false })
    const button = screen.getAllByRole('button', { name: '带入写作' }).at(-1)!
    expect(button).toBeDisabled()
    expect(screen.getByText(/先打开一本书，再带入写作/)).toBeInTheDocument()
  })
  it('launches with the saved revision and filtered manual selection, then enters writing', async () => {
    const user = userEvent.setup()
    const onLaunchWriting = vi.fn()
    const captured: WritingLibraryContextLaunch[] = []
    function LaunchCapture() {
      // 直接读取 Provider 中的待消费交接（peek）：take 的时序语义由 hook 测试覆盖，
      // 这里只断言交接负载不含 autoItemIds/服务端派生身份字段。
      const { pendingLibrary } = useLibraryContextLaunch()
      useEffect(() => {
        if (pendingLibrary) captured.push(pendingLibrary)
      }, [pendingLibrary])
      return null
    }
    render(
      <LibraryContextLaunchProvider>
        <LaunchCapture />
        <LibraryContextPreview library={library} revision="one" dirty={false} hasWritingBook onLaunchWriting={onLaunchWriting} />
      </LibraryContextLaunchProvider>,
    )
    await user.selectOptions(screen.getByLabelText('明确选择的手动资料'), 'm')
    await user.click(screen.getByRole('button', { name: '带入写作' }))

    expect(captured).toHaveLength(1)
    // 只交接已保存库的 Ref 与摘要；不含 autoItemIds、不含任何服务端派生身份字段。
    expect(captured[0]).toEqual({
      libraryId: 'abcdefghijklmnop',
      expectedRevision: 'one',
      manualItemIds: ['m'],
      libraryName: '测试库',
      revisionLabel: 'one',
      selectedCount: 1,
    })
    expect(Object.keys(captured[0])).toEqual(['libraryId', 'expectedRevision', 'manualItemIds', 'libraryName', 'revisionLabel', 'selectedCount'])
    expect(onLaunchWriting).toHaveBeenCalledOnce()
  })
})

describe('library launch to game (B3b)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getInteractiveStoriesMock.mockResolvedValue({ stories: [{ id: 'story-1', title: '水泊故事' }] })
    getInteractiveBranchesMock.mockResolvedValue([{ id: 'main', head: '', created_at: '', current: true }])
    selectInteractiveStoryMock.mockResolvedValue(undefined)
    switchInteractiveBranchMock.mockResolvedValue(undefined)
  })

  function renderGamePreview(props: Partial<Parameters<typeof LibraryContextPreview>[0]> = {}) {
    const captured: GameLibraryContextLaunch[] = []
    function PendingCapture() {
      const { pendingGameLibrary } = useGameLibraryContextLaunch()
      useEffect(() => {
        if (pendingGameLibrary) captured.push(pendingGameLibrary)
      }, [pendingGameLibrary])
      return null
    }
    const view = render(
      <LibraryContextLaunchProvider>
        <GameLibraryContextLaunchProvider>
          <PendingCapture />
          <LibraryContextPreview library={library} revision="one" dirty={false} {...props} />
        </GameLibraryContextLaunchProvider>
      </LibraryContextLaunchProvider>,
    )
    return { captured, view }
  }

  it('disables the launch button for unsaved drafts', () => {
    renderGamePreview({ dirty: true })
    expect(screen.getByRole('button', { name: '带入游戏' })).toBeDisabled()
  })

  it('opens the target dialog, writes nothing on cancel, and keeps the game side untouched', async () => {
    const user = userEvent.setup()
    const { captured } = renderGamePreview({})
    await user.click(screen.getByRole('button', { name: '带入游戏' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(captured).toHaveLength(0)
    expect(selectInteractiveStoryMock).not.toHaveBeenCalled()
  })

  it('hands off the saved library ref with explicit story/branch after confirm and enters game mode', async () => {
    const user = userEvent.setup()
    const onLaunchGame = vi.fn()
    const { captured } = renderGamePreview({ onLaunchGame })
    await user.click(screen.getByRole('button', { name: '带入游戏' }))
    await user.selectOptions(await screen.findByLabelText('目标故事'), 'story-1')
    const branchSelect = await screen.findByLabelText('目标分支')
    await waitFor(() => expect(branchSelect).not.toBeDisabled())
    await user.selectOptions(branchSelect, 'main')
    // 对话框确认按钮与预览「带入游戏」按钮同名，取对话框内（文档顺序最后）的那个。
    await user.click(screen.getAllByRole('button', { name: '带入游戏' }).at(-1)!)

    await waitFor(() => expect(captured).toHaveLength(1))
    // 负载与带入写作同源：已保存库 Ref 三字段 + 摘要；确认时补目标绑定。
    expect(captured[0]).toEqual({
      libraryId: 'abcdefghijklmnop',
      expectedRevision: 'one',
      manualItemIds: [],
      libraryName: '测试库',
      revisionLabel: 'one',
      selectedCount: 0,
      storyId: 'story-1',
      branchId: 'main',
      launchedAt: expect.any(Number),
    })
    expect(Object.keys(captured[0])).toEqual(['libraryId', 'expectedRevision', 'manualItemIds', 'libraryName', 'revisionLabel', 'selectedCount', 'storyId', 'branchId', 'launchedAt'])
    expect(onLaunchGame).toHaveBeenCalledOnce()
    expect(selectInteractiveStoryMock).toHaveBeenCalledWith('story-1')
  })
})

describe('library launch to Narraverse (B4a)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    hostStateMock.state = 'ready'
  })

  function renderNarraversePreview(props: Partial<Parameters<typeof LibraryContextPreview>[0]> = {}) {
    const captured: IframeLibraryContextLaunch[] = []
    function PendingCapture() {
      const { pending } = useIframeLibraryContextLaunch()
      useEffect(() => {
        if (pending.narraverse) captured.push(pending.narraverse)
      }, [pending])
      return null
    }
    const view = render(
      <LibraryContextLaunchProvider>
        <IframeLibraryContextLaunchProvider>
          <PendingCapture />
          <LibraryContextPreview library={library} revision="one" dirty={false} {...props} />
        </IframeLibraryContextLaunchProvider>
      </LibraryContextLaunchProvider>,
    )
    return { captured, view }
  }

  it('disables the Narraverse launch button for unsaved drafts', () => {
    renderNarraversePreview({ dirty: true })
    expect(screen.getByRole('button', { name: '带入叙界' })).toBeDisabled()
  })

  it('hands off only the saved library ref and enters Narraverse when the host session is ready', async () => {
    const user = userEvent.setup()
    const onLaunchNarraverse = vi.fn()
    const { captured } = renderNarraversePreview({ onLaunchNarraverse })
    await user.click(screen.getByRole('button', { name: '带入叙界' }))
    await waitFor(() => expect(captured).toHaveLength(1))
    expect(captured[0]).toEqual({
      libraryId: 'abcdefghijklmnop',
      expectedRevision: 'one',
      manualItemIds: [],
      libraryName: '测试库',
      revisionLabel: 'one',
      selectedCount: 0,
      launchedAt: expect.any(Number),
    })
    expect(Object.keys(captured[0])).toEqual(['libraryId', 'expectedRevision', 'manualItemIds', 'libraryName', 'revisionLabel', 'selectedCount', 'launchedAt'])
    expect(onLaunchNarraverse).toHaveBeenCalledOnce()
  })

  it('refuses to launch when the secure host session is unavailable', async () => {
    hostStateMock.state = 'unavailable'
    const user = userEvent.setup()
    const onLaunchNarraverse = vi.fn()
    const { captured } = renderNarraversePreview({ onLaunchNarraverse })
    await user.click(screen.getByRole('button', { name: '带入叙界' }))
    expect(captured).toHaveLength(0)
    expect(onLaunchNarraverse).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/宿主会话不可用/)
  })
})
