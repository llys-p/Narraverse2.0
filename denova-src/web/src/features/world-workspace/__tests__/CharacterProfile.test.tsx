import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CharacterProfile } from '../components/CharacterProfile'
import type { MasterAssetDetail } from '@/lib/api-client'
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
    fetchMasterAsset: vi.fn(),
    getWorld: vi.fn(),
    updateWorld: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
  }
})

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('../world-api', () => ({
  getWorld: mocks.getWorld,
  updateWorld: mocks.updateWorld,
}))
vi.mock('@/lib/api-client', () => ({
  APIError: mocks.MockAPIError,
  fetchMasterAsset: mocks.fetchMasterAsset,
}))
// 外壳仅做透传，避免无关布局依赖，聚焦 CharacterProfile 自身行为。
vi.mock('@/components/layout/feature-page-shell', () => ({
  FeaturePageShell: ({ title, actions, leadingContent, children }: {
    title?: React.ReactNode; actions?: React.ReactNode; leadingContent?: React.ReactNode; children?: React.ReactNode
  }) => (
    <div>
      <div data-testid="shell-header">{leadingContent}{title}{actions}</div>
      <div>{children}</div>
    </div>
  ),
}))

function detail(over: Partial<MasterAssetDetail['summary']> = {}): MasterAssetDetail {
  return {
    summary: {
      master_item_id: 'm1',
      name: '原件新名',
      tags: ['新标签'],
      nested_entry_count: 0,
      record_kind: 'character_template',
      semantic_type: 'character',
      source_id: 's',
      source_name: 's',
      source_revision: 'sha256:src',
      master_revision: 'sha256:new',
      availability: 'usable',
      usage_count: 0,
      pipeline: { availability: 'usable', nodes: [], issues: [] },
      ...over,
    } as MasterAssetDetail['summary'],
    item: { description: '原件正文' },
    source: {},
    source_revision: {},
    translations: [],
    usages: [],
  }
}

function worldFixture(): World {
  return {
    id: 'w1',
    schemaVersion: 1,
    name: '世界',
    status: 'active',
    bindings: [{
      bindingId: 'b1', masterItemId: 'm1', recordKind: 'character_template',
      semanticType: 'character', nameSnapshot: '旧名', tagsSnapshot: ['旧标签'],
      masterRevision: 'sha256:old', boundAt: '',
    }],
    characters: [{
      id: 'c1', bindingId: 'b1', displayName: '世界内角色名', role: 'protagonist',
      worldNote: '世界内备注不变',
    }],
    locations: [], factions: [], timeline: [], createdAt: '', updatedAt: '',
  }
}

function renderProfile(characterId = 'c1', world = worldFixture(), onBack = vi.fn()) {
  mocks.getWorld.mockResolvedValue({ world, revision: 'sha256:rev1' })
  const view = render(<CharacterProfile worldId="w1" characterId={characterId} onBack={onBack} />)
  return { view, onBack }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateWorld.mockImplementation((_id: string, _rev: string, w: World) =>
    Promise.resolve({ world: w, revision: 'sha256:rev2' }))
})

describe('CharacterProfile 打开即检查（只读）', () => {
  it('检查只读取原件，不修改 world、不发 PUT', async () => {
    mocks.fetchMasterAsset.mockResolvedValue(detail())
    renderProfile()
    await screen.findByText('原件正文')
    expect(mocks.fetchMasterAsset).toHaveBeenCalledTimes(1)
    expect(mocks.fetchMasterAsset).toHaveBeenCalledWith('m1')
    // 未点保存，绝不发 PUT
    expect(mocks.updateWorld).not.toHaveBeenCalled()
    // 世界内名称仍是本地值，未被原件名覆盖
    expect((screen.getByDisplayValue('世界内角色名') as HTMLInputElement).value).toBe('世界内角色名')
  })
})

describe('CharacterProfile 显式刷新', () => {
  it('刷新成功：只更新绑定三字段，角色世界内数据不变，保存时才 PUT', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset.mockResolvedValue(detail())
    renderProfile()
    await screen.findByText('原件正文')
    mocks.fetchMasterAsset.mockClear()

    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('已更新本地资料摘要，保存后才会生效'))
    // 刷新本身不发 PUT
    expect(mocks.updateWorld).not.toHaveBeenCalled()
    // 世界内 displayName/worldNote 仍在，未被刷新覆盖
    expect(screen.getByDisplayValue('世界内角色名')).toBeInTheDocument()
    expect(screen.getByDisplayValue('世界内备注不变')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateWorld).toHaveBeenCalledTimes(1))
    const [, , sent] = mocks.updateWorld.mock.calls[0]
    expect(sent.bindings[0]).toMatchObject({
      nameSnapshot: '原件新名', tagsSnapshot: ['新标签'], masterRevision: 'sha256:new',
    })
    expect(sent.characters[0]).toMatchObject({
      displayName: '世界内角色名', worldNote: '世界内备注不变', bindingId: 'b1',
    })
  })

  it('原件 404：标 missing、不改 world、不发 PUT、不删绑定', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new mocks.MockAPIError(404))
    renderProfile()
    await screen.findByText('原件正文')
    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(screen.getByText('原件已不存在')).toBeInTheDocument())
    expect(mocks.toast.error).toHaveBeenCalledWith('原件已不存在，已保留世界内资料')
    await user.click(screen.getByRole('button', { name: '保存' }))
    const [, , sent] = mocks.updateWorld.mock.calls[0]
    // 绑定保留，仍是旧快照
    expect(sent.bindings[0]).toMatchObject({ nameSnapshot: '旧名', masterRevision: 'sha256:old' })
    expect(sent.characters[0].bindingId).toBe('b1')
  })

  it('网络/5xx：unavailable、不改 world', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new mocks.MockAPIError(500))
    renderProfile()
    await screen.findByText('原件正文')
    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(screen.getByText('暂时无法检查')).toBeInTheDocument())
    expect(mocks.updateWorld).not.toHaveBeenCalled()
  })

  it('成功但 master_revision 为空：保持 unavailable，不 apply、不报成功、绑定不变', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ master_revision: '' }))
    renderProfile()
    await screen.findByText('原件正文')
    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('暂时无法检查，未改动资料'))
    expect(mocks.toast.success).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '保存' }))
    const [, , sent] = mocks.updateWorld.mock.calls[0]
    expect(sent.bindings[0]).toMatchObject({ nameSnapshot: '旧名', masterRevision: 'sha256:old' })
  })
})

describe('CharacterProfile 异步失效保护', () => {
  it('切换角色后，旧角色晚返回的请求不得覆盖新角色', async () => {
    const world = worldFixture()
    world.bindings.push({
      bindingId: 'b2', masterItemId: 'm2', recordKind: 'character_template',
      semanticType: 'character', nameSnapshot: '角色二', tagsSnapshot: [], masterRevision: 'sha256:b2', boundAt: '',
    })
    world.characters.push({ id: 'c2', bindingId: 'b2', displayName: '第二个角色' })

    let resolveOld!: (d: MasterAssetDetail) => void
    const oldPending = new Promise<MasterAssetDetail>((r) => { resolveOld = r })
    mocks.fetchMasterAsset.mockImplementation((id: string) =>
      id === 'm1'
        ? oldPending
        : Promise.resolve(detail({ master_item_id: 'm2', name: '角色二原件', master_revision: 'sha256:b2now' })))
    mocks.getWorld.mockResolvedValue({ world, revision: 'r' })

    const view = render(<CharacterProfile worldId="w1" characterId="c1" onBack={vi.fn()} />)
    // 初始 c1 的请求挂起
    await waitFor(() => expect(mocks.fetchMasterAsset).toHaveBeenCalledWith('m1'))
    // 切到 c2
    view.rerender(<CharacterProfile worldId="w1" characterId="c2" onBack={vi.fn()} />)
    await screen.findByText('角色二原件')
    // 旧角色 c1 请求此刻才晚返回
    resolveOld(detail({ master_item_id: 'm1', name: '角色一原件（迟到）' }))
    await new Promise((r) => setTimeout(r, 0))
    // 展示的仍是 c2 的原件，未被 c1 覆盖
    const aside = screen.getByText('总资料库原件').closest('aside')!
    expect(within(aside).queryByText('角色一原件（迟到）')).toBeNull()
    expect(within(aside).getByText('角色二原件')).toBeInTheDocument()
  })

  it('切到无绑定角色时，旧在途请求失效且回到 idle', async () => {
    const world = worldFixture()
    world.characters.push({ id: 'cNone', displayName: '无绑定角色' })
    let resolveOld!: (d: MasterAssetDetail) => void
    const oldPending = new Promise<MasterAssetDetail>((r) => { resolveOld = r })
    mocks.fetchMasterAsset.mockImplementation((id: string) =>
      id === 'm1' ? oldPending : Promise.resolve(detail()))
    mocks.getWorld.mockResolvedValue({ world, revision: 'r' })

    const view = render(<CharacterProfile worldId="w1" characterId="c1" onBack={vi.fn()} />)
    await waitFor(() => expect(mocks.fetchMasterAsset).toHaveBeenCalledWith('m1'))
    view.rerender(<CharacterProfile worldId="w1" characterId="cNone" onBack={vi.fn()} />)
    await screen.findByText('未绑定总资料库')
    resolveOld(detail({ name: '迟到原件' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('迟到原件')).toBeNull()
  })
})

describe('CharacterProfile 冲突重新加载', () => {
  it('保存 409 出现重新加载；取消不重载，确认后重新 getWorld', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset.mockResolvedValue(detail())
    renderProfile()
    await screen.findByText('原件正文')
    mocks.updateWorld.mockRejectedValueOnce(new mocks.MockAPIError(409))

    await user.click(screen.getByRole('button', { name: '保存' }))
    const reloadBtn = await screen.findByRole('button', { name: '重新加载' })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(reloadBtn)
    expect(mocks.getWorld).toHaveBeenCalledTimes(1) // 仅初始一次
    confirmSpy.mockRestore()

    mocks.updateWorld.mockImplementationOnce((_i: string, _r: string, w: World) =>
      Promise.resolve({ world: w, revision: 'r3' }))
    const confirmOk = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(mocks.getWorld).toHaveBeenCalledTimes(2))
    confirmOk.mockRestore()
  })
})

describe('CharacterProfile 未保存（dirty）保护', () => {
  it('未编辑时返回不提示；编辑后返回需确认，取消留下、确认才离开', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset.mockResolvedValue(detail())
    const { onBack } = renderProfile()
    await screen.findByText('原件正文')

    // 干净状态直接返回
    const back = screen.getByLabelText('返回控制台')
    const cleanConfirm = vi.spyOn(window, 'confirm')
    await user.click(back)
    expect(cleanConfirm).not.toHaveBeenCalled()
    expect(onBack).toHaveBeenCalledTimes(1)
    cleanConfirm.mockRestore()

    // 编辑后变 dirty
    const nameInput = screen.getByDisplayValue('世界内角色名')
    await user.clear(nameInput)
    await user.type(nameInput, '改过的名字')
    const cancel = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByLabelText('返回控制台'))
    expect(cancel).toHaveBeenCalled()
    expect(onBack).toHaveBeenCalledTimes(1) // 未增加
    cancel.mockRestore()

    const ok = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByLabelText('返回控制台'))
    expect(onBack).toHaveBeenCalledTimes(2)
    ok.mockRestore()
  })

  it('显式刷新成功后置 dirty，保存成功后清除 dirty，再返回不提示', async () => {
    const user = userEvent.setup()
    mocks.fetchMasterAsset.mockResolvedValue(detail())
    const { onBack } = renderProfile()
    await screen.findByText('原件正文')
    await user.click(screen.getByRole('button', { name: '刷新资料摘要' }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled())
    // 刷新即 dirty，返回需确认
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByLabelText('返回控制台'))
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    // 保存后 dirty 清除
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateWorld).toHaveBeenCalledTimes(1))
    const noSpy = vi.spyOn(window, 'confirm')
    await user.click(screen.getByLabelText('返回控制台'))
    expect(noSpy).not.toHaveBeenCalled()
    expect(onBack).toHaveBeenCalled()
    noSpy.mockRestore()
  })
})
