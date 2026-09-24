import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LibraryGameLaunchDialog } from './LibraryGameLaunchDialog'
import {
  GameLibraryContextLaunchProvider,
  useGameLibraryContextLaunch,
  type GameLibraryContextLaunch,
} from '@/features/library-context-runtime/GameLibraryContextLaunchProvider'
import { useInteractiveStore } from '@/features/interactive/stores/interactive-store'

const { getInteractiveStoriesMock, getInteractiveBranchesMock, selectInteractiveStoryMock, switchInteractiveBranchMock } = vi.hoisted(() => ({
  getInteractiveStoriesMock: vi.fn(),
  getInteractiveBranchesMock: vi.fn(),
  selectInteractiveStoryMock: vi.fn(),
  switchInteractiveBranchMock: vi.fn(),
}))

vi.mock('@/features/interactive/api', () => ({
  getInteractiveStories: getInteractiveStoriesMock,
  getInteractiveBranches: getInteractiveBranchesMock,
  selectInteractiveStory: selectInteractiveStoryMock,
  switchInteractiveBranch: switchInteractiveBranchMock,
}))

beforeEach(() => {
  window.localStorage.clear()
  useInteractiveStore.setState({ currentStoryId: '', currentBranchId: '', branches: [], snapshot: null, storyStageRuns: {} })
  getInteractiveStoriesMock.mockReset()
  getInteractiveBranchesMock.mockReset()
  selectInteractiveStoryMock.mockReset()
  switchInteractiveBranchMock.mockReset()
  selectInteractiveStoryMock.mockResolvedValue(undefined)
  switchInteractiveBranchMock.mockResolvedValue(undefined)
})

function launchFixture(): Omit<GameLibraryContextLaunch, 'storyId' | 'branchId' | 'launchedAt'> {
  return {
    libraryId: 'library-abc',
    expectedRevision: 'rev-7',
    manualItemIds: ['m'],
    libraryName: '水泊设定库',
    revisionLabel: 'rev-7',
    selectedCount: 1,
  }
}

describe('LibraryGameLaunchDialog (B3b)', () => {
  it('closes without writing the handoff when cancelled', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const captured: GameLibraryContextLaunch[] = []
    getInteractiveStoriesMock.mockResolvedValue({ stories: [{ id: 'story-1', title: '水泊故事' }] })

    render(
      <GameLibraryContextLaunchProvider>
        <PendingCapture captured={captured} />
        <LibraryGameLaunchDialog launch={launchFixture()} onClose={onClose} />
      </GameLibraryContextLaunchProvider>,
    )

    await waitFor(() => expect(screen.getByLabelText('目标故事')).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(captured).toHaveLength(0)
    expect(selectInteractiveStoryMock).not.toHaveBeenCalled()
    expect(switchInteractiveBranchMock).not.toHaveBeenCalled()
  })

  it('writes the bound handoff only after the server-side story/branch switch succeeds, then enters game mode', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onLaunchGame = vi.fn()
    const captured: GameLibraryContextLaunch[] = []
    getInteractiveStoriesMock.mockResolvedValue({ stories: [{ id: 'story-1', title: '水泊故事' }] })
    getInteractiveBranchesMock.mockResolvedValue([
      { id: 'main', head: '', created_at: '', current: true },
      { id: 'branch-2', head: '', created_at: '', current: false },
    ])

    render(
      <GameLibraryContextLaunchProvider>
        <PendingCapture captured={captured} />
        <LibraryGameLaunchDialog launch={launchFixture()} onClose={onClose} onLaunchGame={onLaunchGame} />
      </GameLibraryContextLaunchProvider>,
    )

    await user.selectOptions(await screen.findByLabelText('目标故事'), 'story-1')
    const branchSelect = await screen.findByLabelText('目标分支')
    await waitFor(() => expect(branchSelect).not.toBeDisabled())
    await user.selectOptions(branchSelect, 'branch-2')
    await user.click(screen.getByRole('button', { name: '带入游戏' }))

    // 复用既有选择流程：服务端选中 → 服务端切分支 → 本地 store 同步。
    await waitFor(() => expect(onLaunchGame).toHaveBeenCalledOnce())
    expect(selectInteractiveStoryMock).toHaveBeenCalledWith('story-1')
    expect(switchInteractiveBranchMock).toHaveBeenCalledWith('story-1', 'branch-2')
    expect(useInteractiveStore.getState().currentStoryId).toBe('story-1')
    expect(useInteractiveStore.getState().currentBranchId).toBe('branch-2')
    expect(onClose).toHaveBeenCalledOnce()
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({
      libraryId: 'library-abc',
      expectedRevision: 'rev-7',
      manualItemIds: ['m'],
      libraryName: '水泊设定库',
      revisionLabel: 'rev-7',
      selectedCount: 1,
      storyId: 'story-1',
      branchId: 'branch-2',
      launchedAt: expect.any(Number),
    })
    // 交接负载键白名单：目标绑定在确认时显式写入。
    expect(Object.keys(captured[0])).toEqual(['libraryId', 'expectedRevision', 'manualItemIds', 'libraryName', 'revisionLabel', 'selectedCount', 'storyId', 'branchId', 'launchedAt'])
  })
})

describe('LibraryGameLaunchDialog failures and defaults (B3b)', () => {
  it('keeps the handoff unwritten and shows a visible error when the story switch fails', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onLaunchGame = vi.fn()
    const captured: GameLibraryContextLaunch[] = []
    getInteractiveStoriesMock.mockResolvedValue({ stories: [{ id: 'story-1', title: '水泊故事' }] })
    getInteractiveBranchesMock.mockResolvedValue([{ id: 'main', head: '', created_at: '', current: true }])
    selectInteractiveStoryMock.mockRejectedValue(new Error('boom'))

    render(
      <GameLibraryContextLaunchProvider>
        <PendingCapture captured={captured} />
        <LibraryGameLaunchDialog launch={launchFixture()} onClose={onClose} onLaunchGame={onLaunchGame} />
      </GameLibraryContextLaunchProvider>,
    )

    await user.selectOptions(await screen.findByLabelText('目标故事'), 'story-1')
    await user.click(await screen.findByRole('button', { name: '带入游戏' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('切换目标故事失败，未带入设定库背景。')
    expect(captured).toHaveLength(0)
    expect(onLaunchGame).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(useInteractiveStore.getState().currentStoryId).toBe('')
  })

  it('shows the empty-story hint and keeps the confirm disabled when no interactive story exists', async () => {
    getInteractiveStoriesMock.mockResolvedValue({ stories: [] })
    const onClose = vi.fn()

    render(
      <GameLibraryContextLaunchProvider>
        <LibraryGameLaunchDialog launch={launchFixture()} onClose={onClose} />
      </GameLibraryContextLaunchProvider>,
    )

    expect(await screen.findByText('还没有可用的互动故事，请先在游戏中创建。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '带入游戏' })).toBeDisabled()
    expect(getInteractiveBranchesMock).not.toHaveBeenCalled()
  })

  it('injects the main branch and defaults to it when the server branch list omits it', async () => {
    const user = userEvent.setup()
    getInteractiveStoriesMock.mockResolvedValue({ stories: [{ id: 'story-1', title: '水泊故事' }] })
    getInteractiveBranchesMock.mockResolvedValue([{ id: 'branch-2', head: '', created_at: '', current: false }])

    render(
      <GameLibraryContextLaunchProvider>
        <LibraryGameLaunchDialog launch={launchFixture()} onClose={vi.fn()} />
      </GameLibraryContextLaunchProvider>,
    )

    await user.selectOptions(await screen.findByLabelText('目标故事'), 'story-1')
    const branchSelect = await screen.findByLabelText('目标分支') as HTMLSelectElement
    await waitFor(() => expect(branchSelect).not.toBeDisabled())
    expect((branchSelect.querySelector('option[value="main"]') as HTMLOptionElement | null) ?? null).not.toBeNull()
    expect(branchSelect.value).toBe('main')
  })
})

function PendingCapture({ captured }: { captured: GameLibraryContextLaunch[] }) {
  const { pendingGameLibrary } = useGameLibraryContextLaunch()
  useEffect(() => {
    if (pendingGameLibrary) captured.push(pendingGameLibrary)
  }, [pendingGameLibrary, captured])
  return null
}
