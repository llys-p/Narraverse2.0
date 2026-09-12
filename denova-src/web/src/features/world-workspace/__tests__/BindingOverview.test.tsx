import { StrictMode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BindingOverview } from '../components/context/BindingOverview'
import type { World } from '../types'

const mocks = vi.hoisted(() => {
  class MockAPIError extends Error {
    status: number

    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  }
  return { fetchMasterAsset: vi.fn(), MockAPIError }
})

vi.mock('@/lib/api-client', () => ({
  APIError: mocks.MockAPIError,
  fetchMasterAsset: mocks.fetchMasterAsset,
}))

function worldFixture(overrides: Partial<World> = {}): World {
  return {
    id: 'w1', schemaVersion: 1, name: '绑定世界', status: 'active',
    bindings: [
      {
        bindingId: 'shared', masterItemId: 'master-character', recordKind: 'character_template',
        semanticType: 'character', nameSnapshot: '共享角色原件', tagsSnapshot: ['主角'],
        masterRevision: 'sha256:stored', scope: 'entity', boundAt: '2026-09-01T00:00:00Z',
      },
      {
        bindingId: 'world-rule', masterItemId: 'master-rule', recordKind: 'lorebook_template',
        semanticType: 'rule', nameSnapshot: '世界规则集', tagsSnapshot: [],
        scope: 'world', boundAt: '2026-09-01T00:00:00Z',
      },
    ],
    characters: [
      { id: 'c1', bindingId: 'shared', displayName: '角色甲' },
      { id: 'c2', bindingId: 'shared', displayName: '角色乙' },
    ],
    locations: [{ id: 'l1', bindingId: 'shared', name: '地点甲' }],
    factions: [{ id: 'f1', bindingId: 'shared', name: '势力甲' }],
    timeline: [], createdAt: '', updatedAt: '',
    ...overrides,
  }
}

function detail(masterRevision: string) {
  return {
    summary: {
      master_item_id: 'master-character', name: '原件名称', tags: ['新标签'], nested_entry_count: 0,
      record_kind: 'character_template', semantic_type: 'character', source_id: 'source', source_name: 'source',
      source_revision: 'source-r1', master_revision: masterRevision, availability: 'usable', usage_count: 1,
      pipeline: { availability: 'usable', nodes: [], issues: [], translation: { total_fields: 0, active_fields: 0, pending_fields: 0, review_fields: 0, failed_fields: 0, content_version_kind: {} }, usage_count: 1 },
    },
    item: {}, source: {}, source_revision: {}, translations: [], usages: [],
  }
}

beforeEach(() => mocks.fetchMasterAsset.mockReset())

describe('BindingOverview C2a', () => {
  it('展示全部绑定、真实多对多引用与 world scope 语义，不暴露单一 owner', () => {
    render(<BindingOverview world={worldFixture()} />)

    const entityRow = screen.getByTestId('binding-overview-shared')
    for (const name of ['角色甲', '角色乙', '地点甲', '势力甲']) {
      expect(entityRow.textContent).toContain(name)
    }
    expect(entityRow.textContent).not.toMatch(/ownerId|references/)

    const worldRow = screen.getByTestId('binding-overview-world-rule')
    expect(worldRow.textContent).toContain('世界级资料，不依赖实体存活')
    expect(worldRow.textContent).not.toContain('待清理')
  })

  it('初始只读展示存储基线状态，挂载不请求 Master', () => {
    render(<BindingOverview world={worldFixture()} />)
    expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('已记录基线，尚未联网检查')
    expect(screen.getByTestId('binding-overview-world-rule')).toHaveTextContent('尚未检查')
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
  })

  it('只检查用户点击的单项；相同 revision 显示 latest', async () => {
    mocks.fetchMasterAsset.mockResolvedValue(detail('sha256:stored'))
    const user = userEvent.setup()
    render(<BindingOverview world={worldFixture()} />)

    await user.click(screen.getByRole('button', { name: '检查原件：共享角色原件' }))

    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('已是最新'))
    expect(mocks.fetchMasterAsset).toHaveBeenCalledTimes(1)
    expect(mocks.fetchMasterAsset).toHaveBeenCalledWith('master-character')
    expect(screen.getByTestId('binding-overview-world-rule')).toHaveTextContent('尚未检查')
  })

  it('React StrictMode 重挂载后仍可完成显式检查', async () => {
    mocks.fetchMasterAsset.mockResolvedValue(detail('sha256:stored'))
    const user = userEvent.setup()
    render(<StrictMode><BindingOverview world={worldFixture()} /></StrictMode>)

    await user.click(screen.getByRole('button', { name: '检查原件：共享角色原件' }))

    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('已是最新'))
  })

  it('原件 revision 不同显示 stale；空 revision 显示 unavailable', async () => {
    mocks.fetchMasterAsset
      .mockResolvedValueOnce(detail('sha256:new'))
      .mockResolvedValueOnce(detail(''))
    const user = userEvent.setup()
    render(<BindingOverview world={worldFixture()} />)

    await user.click(screen.getByRole('button', { name: '检查原件：共享角色原件' }))
    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('原件有更新'))

    await user.click(screen.getByRole('button', { name: '检查原件：世界规则集' }))
    await waitFor(() => expect(screen.getByTestId('binding-overview-world-rule')).toHaveTextContent('暂时无法检查'))
  })

  it.each([
    [404, '原件已不存在'],
    [500, '暂时无法检查'],
  ])('HTTP %s 映射为安全健康态并保留绑定行', async (status, label) => {
    mocks.fetchMasterAsset.mockRejectedValueOnce(new mocks.MockAPIError(status))
    const user = userEvent.setup()
    render(<BindingOverview world={worldFixture()} />)

    await user.click(screen.getByRole('button', { name: '检查原件：共享角色原件' }))

    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent(label))
    expect(screen.getByText('共享角色原件')).toBeInTheDocument()
  })

  it('切换 World 后清除上一世界会话健康态且不自动请求', async () => {
    mocks.fetchMasterAsset.mockResolvedValue(detail('sha256:stored'))
    const user = userEvent.setup()
    const { rerender } = render(<BindingOverview world={worldFixture()} />)
    await user.click(screen.getByRole('button', { name: '检查原件：共享角色原件' }))
    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('已是最新'))

    rerender(<BindingOverview world={worldFixture({ id: 'w2' })} />)

    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('已记录基线，尚未联网检查'))
    expect(mocks.fetchMasterAsset).toHaveBeenCalledTimes(1)
  })

  it('旧请求晚返回不会覆盖同 bindingId 的新 Master 原件状态', async () => {
    let resolveOld!: (value: ReturnType<typeof detail>) => void
    const oldRequest = new Promise<ReturnType<typeof detail>>((resolve) => { resolveOld = resolve })
    mocks.fetchMasterAsset.mockReturnValueOnce(oldRequest)
    const user = userEvent.setup()
    const { rerender } = render(<BindingOverview world={worldFixture()} />)
    await user.click(screen.getByRole('button', { name: '检查原件：共享角色原件' }))

    const nextWorld = worldFixture({
      bindings: worldFixture().bindings.map((binding) => binding.bindingId === 'shared'
        ? { ...binding, masterItemId: 'master-new', nameSnapshot: '新角色原件', masterRevision: 'sha256:new' }
        : binding),
    })
    rerender(<BindingOverview world={nextWorld} />)
    resolveOld(detail('sha256:stored'))

    await waitFor(() => expect(screen.getByTestId('binding-overview-shared')).toHaveTextContent('已记录基线，尚未联网检查'))
    expect(within(screen.getByTestId('binding-overview-shared')).queryByText('已是最新')).toBeNull()
  })

  it('空绑定列表显示空态，不发请求也不访问浏览器存储', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    render(<BindingOverview world={worldFixture({ bindings: [] })} />)
    expect(screen.getByText('这个世界还没有绑定资料')).toBeInTheDocument()
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
  })
})
