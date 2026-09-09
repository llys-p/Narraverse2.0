import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorldConsolePage } from '../pages/WorldConsolePage'
import type { World } from '../types'

const mocks = vi.hoisted(() => {
  class MockAPIError extends Error {
    status: number
    constructor(status: number) {
      super(`http ${status}`)
      this.status = status
    }
  }
  return {
    MockAPIError,
    getWorld: vi.fn(),
    updateWorld: vi.fn(),
    getBooks: vi.fn(),
    getStories: vi.fn(),
    fetchMasterAsset: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
  }
})

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('../world-api', () => ({ getWorld: mocks.getWorld, updateWorld: mocks.updateWorld }))
vi.mock('@/lib/api-client', () => ({
  APIError: mocks.MockAPIError,
  getBooks: mocks.getBooks,
  fetchMasterAsset: mocks.fetchMasterAsset,
}))
vi.mock('@/features/interactive/api', () => ({ getInteractiveStories: mocks.getStories }))
vi.mock('../components/ModeEntries', () => ({ ModeEntries: () => <div data-testid="mode-entries" /> }))
vi.mock('../components/BindingPicker', () => ({ BindingPicker: () => null }))
vi.mock('../components/sections/LocationSection', () => ({ LocationSection: () => <div /> }))
vi.mock('../components/sections/FactionSection', () => ({ FactionSection: () => <div /> }))
vi.mock('../components/sections/TimelineSection', () => ({ TimelineSection: () => <div /> }))
vi.mock('@/components/common/EmptyState', () => ({
  EmptyState: ({ title, action }: { title: string; action?: { label: string; onClick: () => void } }) => (
    <div><span>{title}</span>{action && <button onClick={action.onClick}>{action.label}</button>}</div>
  ),
}))
vi.mock('@/components/layout/feature-page-shell', () => ({
  FeaturePageShell: ({ title, actions, children }: {
    title?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode
  }) => (
    <div>
      <div data-testid="shell-header">{title}{actions}</div>
      <div>{children}</div>
    </div>
  ),
}))

function worldFixture(): World {
  return {
    id: 'w1', schemaVersion: 1, name: '控制台世界', status: 'active',
    bindings: [{
      bindingId: 'b1', masterItemId: 'm1', recordKind: 'character_template',
      semanticType: 'character', nameSnapshot: '角色一', tagsSnapshot: [], masterRevision: 'sha256:o', boundAt: '',
    }],
    characters: [{ id: 'c1', bindingId: 'b1', displayName: '角色一' }],
    locations: [], factions: [], timeline: [],
    primaryBookPath: '/lost-book.md',
    primaryInteractiveStoryId: 'lost-story',
    createdAt: '', updatedAt: '',
  }
}

function renderConsole() {
  mocks.getWorld.mockResolvedValue({ world: worldFixture(), revision: 'sha256:r1' })
  mocks.getBooks.mockResolvedValue([{ path: '/other-book.md', name: '另一本书' }])
  mocks.getStories.mockResolvedValue({ stories: [{ id: 'other-story', title: '另一故事' }] })
  return render(
    <WorldConsolePage
      worldId="w1"
      onBack={vi.fn()}
      onOpenCharacter={vi.fn()}
      onWorldChanged={vi.fn()}
      onSetMode={vi.fn()}
      onQuickSwitchBook={vi.fn(async () => true)}
    />,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('WorldConsolePage 入口有效性', () => {
  it('失效主书/故事在 select 内保留 disabled 的原值选项', async () => {
    renderConsole()
    // 概览默认页：等待可选项加载
    const bookSelect = (await screen.findByText('主书（写作模式）')).closest('label')!.querySelector('select')!
    await waitFor(() => expect(within(bookSelect).getByText('已失效：/lost-book.md')).toBeInTheDocument())
    const lostBook = bookSelect.querySelector('option[value="/lost-book.md"]') as HTMLOptionElement
    expect(lostBook.disabled).toBe(true)
    expect(bookSelect.value).toBe('/lost-book.md') // 仍选中失效原值，不像未选择

    const storySelect = screen.getByText('主游戏故事（游戏模式）').closest('label')!.querySelector('select')!
    const lostStory = storySelect.querySelector('option[value="lost-story"]') as HTMLOptionElement
    expect(lostStory.disabled).toBe(true)
    expect(storySelect.value).toBe('lost-story')
    expect(within(storySelect).getByText('已失效：lost-story')).toBeInTheDocument()
  })

  it('主动重选为有效目标后替换旧值（可进入）', async () => {
    const user = userEvent.setup()
    renderConsole()
    const bookSelect = (await screen.findByText('主书（写作模式）')).closest('label')!.querySelector('select')!
    await waitFor(() => expect(within(bookSelect).getByText('另一本书')).toBeInTheDocument())
    await user.selectOptions(bookSelect, '/other-book.md')
    expect(bookSelect.value).toBe('/other-book.md')
    expect(within(bookSelect).queryByText('已失效：/lost-book.md')).toBeNull()
  })
})

describe('WorldConsolePage 角色列表不做健康请求', () => {
  it('渲染角色列表不发任何资产详情请求，books/stories 各只拉一次', async () => {
    const user = userEvent.setup()
    renderConsole()
    await user.click(await screen.findByRole('button', { name: '角色' }))
    expect(await screen.findByText('角色一')).toBeInTheDocument()
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
    expect(mocks.getBooks).toHaveBeenCalledTimes(1)
    expect(mocks.getStories).toHaveBeenCalledTimes(1)
  })
})

describe('WorldConsolePage 冲突重新加载', () => {
  it('409 后取消不重载、确认后重新 getWorld', async () => {
    const user = userEvent.setup()
    renderConsole()
    const bookSelect = (await screen.findByText('主书（写作模式）')).closest('label')!.querySelector('select')!
    await waitFor(() => expect(within(bookSelect).getByText('另一本书')).toBeInTheDocument())
    // 改选择使 draft 变 dirty，出现保存按钮
    await user.selectOptions(bookSelect, '/other-book.md')
    const saveBtn = await screen.findByRole('button', { name: '保存' })
    mocks.updateWorld.mockRejectedValueOnce(new mocks.MockAPIError(409))
    await user.click(saveBtn)
    await screen.findByRole('button', { name: '重新加载' })

    const cancel = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(mocks.getWorld).toHaveBeenCalledTimes(1)
    cancel.mockRestore()

    const ok = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(mocks.getWorld).toHaveBeenCalledTimes(2))
    ok.mockRestore()
  })
})
