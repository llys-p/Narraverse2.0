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
    previewWorldContext: vi.fn(),
    getBooks: vi.fn(),
    getStories: vi.fn(),
    fetchMasterAsset: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
  }
})

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('../world-api', () => ({
  getWorld: mocks.getWorld,
  updateWorld: mocks.updateWorld,
  previewWorldContext: mocks.previewWorldContext,
}))
vi.mock('@/lib/api-client', () => ({
  APIError: mocks.MockAPIError,
  getBooks: mocks.getBooks,
  fetchMasterAsset: mocks.fetchMasterAsset,
}))
vi.mock('@/features/interactive/api', () => ({ getInteractiveStories: mocks.getStories }))
vi.mock('../components/ModeEntries', () => ({ ModeEntries: () => <div data-testid="mode-entries" /> }))
vi.mock('../components/BindingPicker', () => ({
  WORLD_MATERIAL_SEMANTIC_TYPES: ['world', 'rule', 'item', 'other'],
  BindingPicker: ({ open, semanticType, multi, allowedSemanticTypes }: { open: boolean; semanticType?: string; multi?: boolean; allowedSemanticTypes?: readonly string[] }) => (
    open ? <div data-testid="picker" data-semantic={semanticType ?? ''} data-multi={multi ? '1' : '0'} data-allowed={allowedSemanticTypes?.join(',') ?? ''} /> : null
  ),
}))
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
  const onOpenCharacter = vi.fn()
  const onBack = vi.fn()
  const view = render(
    <WorldConsolePage
      worldId="w1"
      onBack={onBack}
      onOpenCharacter={onOpenCharacter}
      onWorldChanged={vi.fn()}
      onSetMode={vi.fn()}
      onQuickSwitchBook={vi.fn(async () => true)}
    />,
  )
  return { view, onOpenCharacter, onBack }
}

/** C2b：一个被多角色/地点/势力共享的 entity binding，用于验证移除影响与解除引用。 */
function sharedBindingWorld(): World {
  return {
    id: 'w1', schemaVersion: 1, name: '控制台世界', status: 'active',
    bindings: [{
      bindingId: 'b1', masterItemId: 'm1', recordKind: 'character_template',
      semanticType: 'character', nameSnapshot: '共享角色原件', tagsSnapshot: [], masterRevision: 'sha256:o', boundAt: '',
    }],
    characters: [
      { id: 'c1', bindingId: 'b1', displayName: '角色甲' },
      { id: 'c2', bindingId: 'b1', displayName: '角色乙' },
    ],
    locations: [{ id: 'l1', bindingId: 'b1', name: '地点甲' }],
    factions: [{ id: 'f1', bindingId: 'b1', name: '势力甲' }],
    timeline: [], createdAt: '', updatedAt: '',
  }
}

function worldScopeBindingWorld(): World {
  return {
    id: 'w1', schemaVersion: 1, name: '控制台世界', status: 'active',
    bindings: [{
      bindingId: 'world-rule', masterItemId: 'master-rule', recordKind: 'lorebook_template',
      semanticType: 'rule', nameSnapshot: '世界规则集', tagsSnapshot: [], masterRevision: 'sha256:o',
      scope: 'world', boundAt: '',
    }],
    characters: [], locations: [], factions: [], timeline: [], createdAt: '', updatedAt: '',
  }
}

function renderConsoleWith(world: World) {
  mocks.getWorld.mockResolvedValue({ world, revision: 'sha256:r1' })
  mocks.getBooks.mockResolvedValue([])
  mocks.getStories.mockResolvedValue({ stories: [] })
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

describe('WorldConsolePage 保存前草稿校验（B1）', () => {
  it('存在空名称地点时保存被前端拦截：不发 updateWorld 并提示', async () => {
    const user = userEvent.setup()
    const broken = worldFixture()
    broken.locations = [{ id: 'lEmpty', name: '   ' }]
    mocks.getWorld.mockResolvedValue({ world: broken, revision: 'sha256:r1' })
    mocks.getBooks.mockResolvedValue([{ path: '/other-book.md', name: '另一本书' }])
    mocks.getStories.mockResolvedValue({ stories: [{ id: 'other-story', title: '另一故事' }] })
    render(<WorldConsolePage worldId="w1" onBack={vi.fn()} onOpenCharacter={vi.fn()} onWorldChanged={vi.fn()}
      onSetMode={vi.fn()} onQuickSwitchBook={vi.fn(async () => true)} />)
    const bookSelect = (await screen.findByText('主书（写作模式）')).closest('label')!.querySelector('select')!
    await waitFor(() => expect(within(bookSelect).getByText('另一本书')).toBeInTheDocument())
    await user.selectOptions(bookSelect, '/other-book.md') // 制造 dirty 以显示保存按钮
    await user.click(await screen.findByRole('button', { name: '保存' }))
    expect(mocks.updateWorld).not.toHaveBeenCalled()
    expect(mocks.toast.error).toHaveBeenCalledWith('存在未命名地点，请先填写地点名称再保存')
  })
})

describe('WorldConsolePage 地点/势力/世界资料绑定入口', () => {
  it('三个绑定入口分别打开 location / faction / 多选 world 选择器', async () => {
    const user = userEvent.setup()
    renderConsole()
    await screen.findByText('主书（写作模式）')

    await user.click(screen.getByRole('button', { name: '地点' }))
    await user.click(screen.getByRole('button', { name: '从总资料库绑定地点' }))
    let picker = await screen.findByTestId('picker')
    expect(picker.getAttribute('data-semantic')).toBe('location')
    expect(picker.getAttribute('data-multi')).toBe('0')

    await user.click(screen.getByRole('button', { name: '势力' }))
    await user.click(screen.getByRole('button', { name: '从总资料库绑定势力' }))
    picker = await screen.findByTestId('picker')
    expect(picker.getAttribute('data-semantic')).toBe('faction')

    await user.click(screen.getByRole('button', { name: '世界资料' }))
    await user.click(screen.getByRole('button', { name: '添加世界资料' }))
    picker = await screen.findByTestId('picker')
    expect(picker.getAttribute('data-multi')).toBe('1')
    expect(picker.getAttribute('data-allowed')).toBe('world,rule,item,other')
  })

  it('世界资料为空时显示空状态，且加载分区不发资产详情请求', async () => {
    const user = userEvent.setup()
    renderConsole()
    await user.click(await screen.findByRole('button', { name: '世界资料' }))
    expect(await screen.findByText(/还没有世界资料/)).toBeInTheDocument()
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
  })
})

function worldWithMaterial(): World {
  const w = worldFixture()
  w.bindings = [...w.bindings, {
    bindingId: 'bw', masterItemId: 'm-rule', recordKind: 'lorebook_template',
    semanticType: 'rule', nameSnapshot: '旧规则名', tagsSnapshot: ['旧标签'],
    masterRevision: 'sha256:old', scope: 'world', boundAt: '',
  }]
  return w
}

describe('WorldConsolePage 世界资料刷新（按需、不自动、保存才落库）', () => {
  it('刷新成功只更新本地三字段，保存时才 PUT，且不触碰角色', async () => {
    const user = userEvent.setup()
    mocks.getWorld.mockResolvedValue({ world: worldWithMaterial(), revision: 'sha256:r1' })
    mocks.getBooks.mockResolvedValue([])
    mocks.getStories.mockResolvedValue({ stories: [] })
    mocks.fetchMasterAsset.mockResolvedValue({
      summary: { name: '新规则名', tags: ['新标签'], master_revision: 'sha256:new' },
    })
    mocks.updateWorld.mockImplementation(async (_id: string, _rev: string, world: World) => ({ world, revision: 'sha256:r2' }))
    render(<WorldConsolePage worldId="w1" onBack={vi.fn()} onOpenCharacter={vi.fn()} onWorldChanged={vi.fn()}
      onSetMode={vi.fn()} onQuickSwitchBook={vi.fn(async () => true)} />)

    await user.click(await screen.findByRole('button', { name: '世界资料' }))
    expect(await screen.findByText('旧规则名')).toBeInTheDocument()
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled() // 进入分区不自动检查

    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(screen.getByText('新规则名')).toBeInTheDocument())
    expect(mocks.updateWorld).not.toHaveBeenCalled() // 刷新本身不落库

    await user.click(await screen.findByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateWorld).toHaveBeenCalledTimes(1))
    const saved: World = mocks.updateWorld.mock.calls[0][2]
    const mat = saved.bindings.find((b) => b.bindingId === 'bw')!
    expect(mat.nameSnapshot).toBe('新规则名')
    expect(mat.tagsSnapshot).toEqual(['新标签'])
    expect(mat.masterRevision).toBe('sha256:new')
    // 角色绑定与角色实例未被刷新触碰
    expect(saved.characters[0].displayName).toBe('角色一')
  })

  it.each([
    ['404', 404, '原件已不存在，已保留世界内资料'],
    ['5xx', 500, '暂时无法检查，未改动资料'],
  ])('刷新失败 %s：提示且绑定保持不变、不发 PUT', async (_label, status, msg) => {
    const user = userEvent.setup()
    mocks.getWorld.mockResolvedValue({ world: worldWithMaterial(), revision: 'sha256:r1' })
    mocks.getBooks.mockResolvedValue([])
    mocks.getStories.mockResolvedValue({ stories: [] })
    mocks.fetchMasterAsset.mockRejectedValue(new mocks.MockAPIError(status))
    render(<WorldConsolePage worldId="w1" onBack={vi.fn()} onOpenCharacter={vi.fn()} onWorldChanged={vi.fn()}
      onSetMode={vi.fn()} onQuickSwitchBook={vi.fn(async () => true)} />)
    await user.click(await screen.findByRole('button', { name: '世界资料' }))
    await screen.findByText('旧规则名')
    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(msg))
    expect(screen.getByText('旧规则名')).toBeInTheDocument()
    expect(mocks.updateWorld).not.toHaveBeenCalled()
  })

  it('移除世界资料需确认：取消保留，确认后从草稿删除（不删总库），保存才落库', async () => {
    const user = userEvent.setup()
    mocks.getWorld.mockResolvedValue({ world: worldWithMaterial(), revision: 'sha256:r1' })
    mocks.getBooks.mockResolvedValue([])
    mocks.getStories.mockResolvedValue({ stories: [] })
    mocks.updateWorld.mockImplementation(async (_id: string, _rev: string, world: World) => ({ world, revision: 'sha256:r2' }))
    render(<WorldConsolePage worldId="w1" onBack={vi.fn()} onOpenCharacter={vi.fn()} onWorldChanged={vi.fn()}
      onSetMode={vi.fn()} onQuickSwitchBook={vi.fn(async () => true)} />)
    await user.click(await screen.findByRole('button', { name: '世界资料' }))
    await screen.findByText('旧规则名')

    const cancel = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.getByText('旧规则名')).toBeInTheDocument()
    cancel.mockRestore()

    const ok = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: '移除' }))
    ok.mockRestore()
    await waitFor(() => expect(screen.queryByText('旧规则名')).toBeNull())
    await user.click(await screen.findByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateWorld).toHaveBeenCalledTimes(1))
    const saved: World = mocks.updateWorld.mock.calls[0][2]
    expect(saved.bindings.some((b) => b.bindingId === 'bw')).toBe(false)
  })
})

describe('WorldConsolePage 手动新建与未保存保护', () => {
  it('手动新建角色带可保存默认名，不产生空名称', async () => {
    const user = userEvent.setup()
    renderConsole()
    await user.click(await screen.findByRole('button', { name: '角色' }))
    await user.click(screen.getByRole('button', { name: '手动新建' }))
    // 新角色使用默认名“新角色”，后端不会因空 displayName 拒绝
    expect(await screen.findByText('新角色')).toBeInTheDocument()
  })

  it('有未保存修改时打开角色需确认：取消不跳转，确认才打开', async () => {
    const user = userEvent.setup()
    const { onOpenCharacter } = renderConsole()
    await user.click(await screen.findByRole('button', { name: '角色' }))
    await user.click(screen.getByRole('button', { name: '手动新建' }))
    const card = await screen.findByText('新角色')

    const cancel = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(card)
    expect(onOpenCharacter).not.toHaveBeenCalled()
    cancel.mockRestore()

    const ok = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(card)
    expect(onOpenCharacter).toHaveBeenCalledTimes(1)
    ok.mockRestore()
  })
})

function previewEnvelope() {
  return {
    preview: {
      schemaVersion: 1, worldId: 'w1', worldRevision: 'sha256:r1', consumer: 'writing',
      contextFingerprint: 'v1|abcd1234efgh',
      canonicalSelection: { includeTone: false, ruleIndexes: [], characterIds: ['c1'], locationIds: [], factionIds: [], timelineEntryIds: [], bindingIds: [] },
      identity: { name: '控制台世界' },
      setting: { rules: [] },
      characters: [{ id: 'c1', displayName: '角色一', relationships: [] }],
      locations: [], factions: [], timeline: [], materials: [],
      omissions: [], warnings: [],
      stats: { characterCount: 1, locationCount: 0, factionCount: 0, timelineCount: 0, materialCount: 0 },
      sourceTable: { identity: { kind: 'identity' }, 'character:c1': { kind: 'character', entityId: 'c1' } },
      revisionLabel: 'r1', isDraftPreview: false,
    },
  }
}

async function openContextTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '世界上下文' }))
}

describe('WorldConsolePage Context 分区（B3）', () => {
  it('打开控制台与切到 context 分区都不自动发 Preview 请求', async () => {
    const user = userEvent.setup()
    renderConsole()
    await screen.findByText('主书（写作模式）')
    expect(mocks.previewWorldContext).not.toHaveBeenCalled()
    await openContextTab(user)
    expect(screen.getByTestId('world-context-panel')).toBeInTheDocument()
    expect(mocks.previewWorldContext).not.toHaveBeenCalled()
  })

  it('勾选角色后点生成：恰好一次请求，body 使用已保存 revision 与当前 selection', async () => {
    const user = userEvent.setup()
    mocks.previewWorldContext.mockResolvedValue(previewEnvelope())
    renderConsole()
    await openContextTab(user)
    await user.click(screen.getByRole('checkbox', { name: '角色一' }))
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    expect(mocks.previewWorldContext).toHaveBeenCalledTimes(1)
    expect(mocks.previewWorldContext).toHaveBeenCalledWith('w1', expect.objectContaining({
      consumer: 'writing',
      expectedWorldRevision: 'sha256:r1',
      selection: expect.objectContaining({ characterIds: ['c1'] }),
    }))
    expect(await screen.findByTestId('context-preview-detail')).toBeInTheDocument()
  })

  it('草稿 dirty 时禁止生成：零 Preview 请求并提示先保存', async () => {
    const user = userEvent.setup()
    renderConsole()
    const bookSelect = (await screen.findByText('主书（写作模式）')).closest('label')!.querySelector('select')!
    await user.selectOptions(bookSelect, '/other-book.md') // 制造 dirty
    await openContextTab(user)
    expect(screen.getByTestId('context-blocked-dirty')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成预览' })).toBeDisabled()
    expect(mocks.previewWorldContext).not.toHaveBeenCalled()
  })

  it('保存成功后旧 Preview 标 stale', async () => {
    const user = userEvent.setup()
    mocks.previewWorldContext.mockResolvedValue(previewEnvelope())
    mocks.updateWorld.mockImplementation(async (_id: string, _rev: string, world: World) => ({ world, revision: 'sha256:r2' }))
    renderConsole()
    await openContextTab(user)
    await user.click(screen.getByRole('checkbox', { name: '角色一' }))
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    expect(await screen.findByTestId('context-preview-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('context-preview-stale-banner')).toBeNull()

    // 改主书制造 dirty 并保存（header 保存按钮始终可见）
    await user.click(screen.getByRole('button', { name: '概览' }))
    const bookSelect = screen.getByText('主书（写作模式）').closest('label')!.querySelector('select')!
    await user.selectOptions(bookSelect, '/other-book.md')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await openContextTab(user)
    expect(await screen.findByTestId('context-preview-stale-banner')).toBeInTheDocument()
  })

  it('分区切换后选择与预览保留；来源跳转只切分区、不发 PUT', async () => {
    const user = userEvent.setup()
    mocks.previewWorldContext.mockResolvedValue(previewEnvelope())
    renderConsole()
    await openContextTab(user)
    await user.click(screen.getByRole('checkbox', { name: '角色一' }))
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    await screen.findByTestId('context-preview-detail')
    // 切到别的分区再回来：勾选与结果仍在
    await user.click(screen.getByRole('button', { name: '角色' }))
    await openContextTab(user)
    expect(screen.getByRole('checkbox', { name: '角色一' })).toBeChecked()
    expect(screen.getByTestId('context-preview-detail')).toBeInTheDocument()
    // 来源跳转到角色分区：不产生 World PUT
    await user.click(screen.getByRole('button', { name: '跳转到角色' }))
    expect(mocks.updateWorld).not.toHaveBeenCalled()
  })

  it('预览完成后改变选择或目标模式：旧结果立即标 stale，不冒充当前选择', async () => {
    const user = userEvent.setup()
    mocks.previewWorldContext.mockResolvedValue(previewEnvelope())
    renderConsole()
    await openContextTab(user)
    await user.click(screen.getByRole('checkbox', { name: '角色一' }))
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    expect(await screen.findByTestId('context-preview-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('context-preview-stale-banner')).toBeNull()

    // 取消当前唯一可见角色也会改变待提交 selection。
    await user.click(screen.getByRole('checkbox', { name: '角色一' }))
    expect(screen.getByTestId('context-preview-stale-banner')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    expect(screen.getByTestId('context-preview-stale-banner')).toBeInTheDocument()
  })

  it('worldId 改变后清空上一个世界的 Context 会话', async () => {
    const user = userEvent.setup()
    mocks.previewWorldContext.mockResolvedValue(previewEnvelope())
    const { view } = renderConsole()
    await openContextTab(user)
    await user.click(screen.getByRole('checkbox', { name: '角色一' }))
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    expect(await screen.findByTestId('context-preview-detail')).toBeInTheDocument()

    // 切换到另一个世界
    mocks.getWorld.mockResolvedValue({ world: { ...worldFixture(), id: 'w2', name: '二号世界', characters: [] }, revision: 'sha256:q1' })
    view.rerender(<WorldConsolePage worldId="w2" onBack={vi.fn()} onOpenCharacter={vi.fn()} onWorldChanged={vi.fn()}
      onSetMode={vi.fn()} onQuickSwitchBook={vi.fn(async () => true)} />)
    await openContextTab(user)
    expect(screen.queryByTestId('context-preview-detail')).toBeNull()
    expect(screen.getByText('选择内容后生成上下文预览')).toBeInTheDocument()
  })

  it('Context 分区不访问浏览器持久化、不发 Master 详情请求', async () => {
    const user = userEvent.setup()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    renderConsole()
    await openContextTab(user)
    expect(setItem).not.toHaveBeenCalled()
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
  })
})

describe('WorldConsolePage 移除 Binding 闭环 C2b', () => {
  it('移除已选 world binding 后同步清理会话 Selection，保存后预览不提交失效 ID', async () => {
    const user = userEvent.setup()
    const world = worldScopeBindingWorld()
    renderConsoleWith(world)
    await user.click(await screen.findByRole('button', { name: '世界上下文' }))

    await user.click(screen.getByRole('checkbox', { name: '世界规则集' }))
    await user.click(screen.getByRole('button', { name: '移除：世界规则集' }))
    await user.click(screen.getByTestId('binding-removal-confirm'))

    const savedWorld = { ...world, bindings: [] }
    mocks.updateWorld.mockResolvedValue({ world: savedWorld, revision: 'sha256:r2' })
    await user.click(await screen.findByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateWorld).toHaveBeenCalledTimes(1))

    mocks.previewWorldContext.mockResolvedValue(previewEnvelope())
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    await waitFor(() => expect(mocks.previewWorldContext).toHaveBeenCalledTimes(1))
    expect(mocks.previewWorldContext.mock.calls[0][1].selection.bindingIds).toEqual([])
  })

  it('确认后移除绑定并解除全部实体引用；只改草稿置 dirty，保存前零 PUT', async () => {
    const user = userEvent.setup()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    // 影响预览是唯一确认界面：不得再叠加 window.confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderConsoleWith(sharedBindingWorld())
    await user.click(await screen.findByRole('button', { name: '世界上下文' }))

    await user.click(await screen.findByRole('button', { name: '移除：共享角色原件' }))
    const panel = screen.getByTestId('binding-removal-impact')
    expect(within(panel).getByTestId('binding-removal-detached-characters').textContent).toContain('角色乙')
    expect(within(panel).getByTestId('binding-removal-detached-locations').textContent).toContain('地点甲')
    expect(within(panel).getByTestId('binding-removal-detached-factions').textContent).toContain('势力甲')
    expect(panel).toHaveTextContent('总资料库原件不会被删除')

    await user.click(screen.getByTestId('binding-removal-confirm'))

    expect(mocks.updateWorld).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('保存后才调用现有 PUT；提交内容已解除全部引用且未删除任何实体', async () => {
    const user = userEvent.setup()
    renderConsoleWith(sharedBindingWorld())
    await user.click(await screen.findByRole('button', { name: '世界上下文' }))
    await user.click(await screen.findByRole('button', { name: '移除：共享角色原件' }))
    await user.click(screen.getByTestId('binding-removal-confirm'))

    mocks.updateWorld.mockResolvedValue({ world: sharedBindingWorld(), revision: 'sha256:r2' })
    await user.click(await screen.findByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateWorld).toHaveBeenCalledTimes(1))
    const submitted = mocks.updateWorld.mock.calls[0][2] as World
    expect(submitted.bindings).toHaveLength(0)
    expect(submitted.characters.every((c) => c.bindingId === undefined)).toBe(true)
    expect(submitted.locations.every((l) => l.bindingId === undefined)).toBe(true)
    expect(submitted.factions.every((f) => f.bindingId === undefined)).toBe(true)
    // 只解除绑定，绝不删除实体本身
    expect(submitted.characters).toHaveLength(2)
    expect(submitted.locations).toHaveLength(1)
    expect(submitted.factions).toHaveLength(1)
  })

  it('取消：零修改、零 PUT、dirty 不变，且不叠加二次确认', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderConsoleWith(sharedBindingWorld())
    await user.click(await screen.findByRole('button', { name: '世界上下文' }))

    await user.click(await screen.findByRole('button', { name: '移除：共享角色原件' }))
    await user.click(screen.getByTestId('binding-removal-cancel'))

    expect(mocks.updateWorld).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.queryByTestId('binding-removal-impact')).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    // 取消后绑定仍在列表中，未被改动
    expect(screen.getByTestId('binding-overview-b1')).toBeInTheDocument()
    confirmSpy.mockRestore()
  })
})
