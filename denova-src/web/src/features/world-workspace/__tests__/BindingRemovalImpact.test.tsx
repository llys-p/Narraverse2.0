import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BindingRemovalImpact } from '../components/context/BindingRemovalImpact'
import type { World } from '../types'

const mocks = vi.hoisted(() => ({ fetchMasterAsset: vi.fn() }))

vi.mock('@/lib/api-client', () => ({
  APIError: class extends Error {},
  fetchMasterAsset: mocks.fetchMasterAsset,
}))

const ENTITY_BINDING = {
  bindingId: 'shared', masterItemId: 'master-character', recordKind: 'character_template' as const,
  semanticType: 'character' as const, nameSnapshot: '共享角色原件', tagsSnapshot: [],
  masterRevision: 'sha256:stored', scope: 'entity' as const, boundAt: '2026-09-01T00:00:00Z',
}

const WORLD_BINDING = {
  bindingId: 'world-rule', masterItemId: 'master-rule', recordKind: 'lorebook_template' as const,
  semanticType: 'rule' as const, nameSnapshot: '世界规则集', tagsSnapshot: [],
  scope: 'world' as const, boundAt: '2026-09-01T00:00:00Z',
}

function worldFixture(overrides: Partial<World> = {}): World {
  return {
    id: 'w1', schemaVersion: 1, name: '绑定世界', status: 'active',
    bindings: [ENTITY_BINDING, WORLD_BINDING],
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

beforeEach(() => mocks.fetchMasterAsset.mockReset())

describe('BindingRemovalImpact C2b', () => {
  it('共享 Binding：列出全部将被解除绑定的角色、地点与势力', () => {
    render(<BindingRemovalImpact world={worldFixture()} bindingId="shared" onCancel={vi.fn()} onConfirm={vi.fn()} />)

    const panel = screen.getByTestId('binding-removal-impact')
    expect(panel).toHaveTextContent('共享角色原件')
    expect(within(panel).getByTestId('binding-removal-detached-characters').textContent).toContain('角色甲')
    expect(within(panel).getByTestId('binding-removal-detached-characters').textContent).toContain('角色乙')
    expect(within(panel).getByTestId('binding-removal-detached-locations').textContent).toContain('地点甲')
    expect(within(panel).getByTestId('binding-removal-detached-factions').textContent).toContain('势力甲')
  })

  it('entity scope 零引用：明确显示没有实体受影响，且仍声明原件不会被删除', () => {
    const world = worldFixture({
      characters: [{ id: 'c9', displayName: '无关角色' }],
      locations: [], factions: [],
    })
    render(<BindingRemovalImpact world={world} bindingId="shared" onCancel={vi.fn()} onConfirm={vi.fn()} />)

    const panel = screen.getByTestId('binding-removal-impact')
    expect(panel).toHaveTextContent('没有实体受影响')
    expect(panel).toHaveTextContent('总资料库原件不会被删除')
  })

  it('world scope 零引用：仍说明它属于世界级资料，绝不显示待清理', () => {
    render(<BindingRemovalImpact world={worldFixture()} bindingId="world-rule" onCancel={vi.fn()} onConfirm={vi.fn()} />)

    const panel = screen.getByTestId('binding-removal-impact')
    expect(panel).toHaveTextContent('世界级资料')
    expect(panel).toHaveTextContent('总资料库原件不会被删除')
    expect(panel.textContent).not.toContain('待清理')
  })

  it('取消：只回调 onCancel，不触发确认，不发 Master 请求', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<BindingRemovalImpact world={worldFixture()} bindingId="shared" onCancel={onCancel} onConfirm={onConfirm} />)

    await user.click(screen.getByTestId('binding-removal-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
  })

  it('确认：以目标 bindingId 触发一次回调，且不叠加 window.confirm', async () => {
    const onConfirm = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    render(<BindingRemovalImpact world={worldFixture()} bindingId="shared" onCancel={vi.fn()} onConfirm={onConfirm} />)

    await user.click(screen.getByTestId('binding-removal-confirm'))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('shared')
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('Binding 已不存在：禁用确认并给出明确状态', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <BindingRemovalImpact
        world={worldFixture({ bindings: [WORLD_BINDING] })}
        bindingId="shared"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    const panel = screen.getByRole('alertdialog', { name: '移除影响' })
    expect(panel).toHaveTextContent('该绑定已不存在，无法继续移除')
    expect(panel).not.toHaveTextContent('shared')
    expect(panel).not.toHaveTextContent('实体资料')
    expect(screen.getByTestId('binding-removal-confirm')).toBeDisabled()
    await user.click(screen.getByTestId('binding-removal-confirm'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('预览期间 World 变化：影响按最新 world 重新派生，不使用过期结果', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <BindingRemovalImpact world={worldFixture()} bindingId="shared" onCancel={vi.fn()} onConfirm={onConfirm} />,
    )
    expect(screen.getByTestId('binding-removal-detached-characters').textContent).toContain('角色乙')

    // 世界草稿在预览期间变化：角色乙已被解除，影响必须随之减少。
    const next = worldFixture({ characters: [{ id: 'c1', bindingId: 'shared', displayName: '角色甲' }] })
    rerender(<BindingRemovalImpact world={next} bindingId="shared" onCancel={vi.fn()} onConfirm={onConfirm} />)

    expect(screen.getByTestId('binding-removal-detached-characters').textContent).not.toContain('角色乙')
    expect(screen.getByTestId('binding-removal-detached-characters').textContent).toContain('角色甲')

    await user.click(screen.getByTestId('binding-removal-confirm'))
    expect(onConfirm).toHaveBeenCalledWith('shared')
  })

  it('预览期间 Binding 被移除：确认被禁用，不得用旧影响执行删除', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <BindingRemovalImpact world={worldFixture()} bindingId="shared" onCancel={vi.fn()} onConfirm={onConfirm} />,
    )
    expect(screen.getByTestId('binding-removal-confirm')).toBeEnabled()

    rerender(
      <BindingRemovalImpact
        world={worldFixture({ bindings: [WORLD_BINDING] })}
        bindingId="shared"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByTestId('binding-removal-confirm')).toBeDisabled()
    await user.click(screen.getByTestId('binding-removal-confirm'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('打开预览零 Master 请求、零浏览器存储写入', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const getItem = vi.spyOn(Storage.prototype, 'getItem')

    render(<BindingRemovalImpact world={worldFixture()} bindingId="shared" onCancel={vi.fn()} onConfirm={vi.fn()} />)

    expect(mocks.fetchMasterAsset).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
  })
})
