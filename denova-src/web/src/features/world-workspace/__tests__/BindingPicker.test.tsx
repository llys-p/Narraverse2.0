import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BindingPicker } from '../components/BindingPicker'
import type { MasterAssetSummary } from '@/lib/api-client'

const mocks = vi.hoisted(() => ({ listMasterAssets: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ listMasterAssets: mocks.listMasterAssets }))

function asset(id: string, name: string): MasterAssetSummary {
  return {
    master_item_id: id, name, tags: [], nested_entry_count: 0,
    record_kind: 'character_template', semantic_type: 'character',
    source_id: 's', source_name: 's', source_revision: 'r', master_revision: 'sha256:' + id,
    availability: 'usable', usage_count: 0,
    pipeline: { availability: 'usable', nodes: [], issues: [] },
  } as unknown as MasterAssetSummary
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function renderPicker() {
  return render(
    <BindingPicker open onClose={vi.fn()} boundMasterIds={new Set()} recordKind="character_template" semanticType="character" onBind={vi.fn()} />,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('BindingPicker 搜索代失效保护', () => {
  it('旧查询的 loadMore 晚返回时不得混入新搜索结果', async () => {
    const user = userEvent.setup()
    // 首屏：25 条，total 50 → 可 loadMore
    mocks.listMasterAssets.mockImplementationOnce(async () => ({
      assets: Array.from({ length: 25 }, (_, i) => asset(`old-${i}`, `旧${i}`)), total: 50,
    }))
    renderPicker()
    await waitFor(() => expect(screen.getByText('旧0')).toBeInTheDocument())
    const loadMoreBtn = screen.getByRole('button', { name: '加载更多' })

    // 点击加载更多，但让旧分页挂起
    const oldPage = deferred<{ assets: MasterAssetSummary[]; total: number }>()
    mocks.listMasterAssets.mockImplementationOnce(() => oldPage.promise)
    await user.click(loadMoreBtn)
    await waitFor(() => expect(mocks.listMasterAssets).toHaveBeenCalledTimes(2))

    // 改搜索词 → 触发新一代首屏
    const newFirst = deferred<{ assets: MasterAssetSummary[]; total: number }>()
    mocks.listMasterAssets.mockImplementationOnce(() => newFirst.promise)
    await user.type(screen.getByPlaceholderText('搜索资产名称或来源'), '新')
    await waitFor(() => expect(mocks.listMasterAssets).toHaveBeenCalledTimes(3))
    newFirst.resolve({ assets: [asset('new-1', '新结果1')], total: 1 })
    await waitFor(() => expect(screen.getByText('新结果1')).toBeInTheDocument())

    // 旧查询的分页此刻才晚返回
    oldPage.resolve({ assets: Array.from({ length: 25 }, (_, i) => asset(`late-${i}`, `迟到${i}`)), total: 50 })
    await new Promise((r) => setTimeout(r, 0))

    expect(screen.queryByText('迟到0')).toBeNull()
    expect(screen.queryByText('旧0')).toBeNull()
    expect(screen.getByText('新结果1')).toBeInTheDocument()
    // total=1 已全部加载，不再显示加载更多
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })
})

describe('BindingPicker 多选模式（世界资料）', () => {
  it('勾选多条后一次性回调 onBindMany，绑定带显式 scope，并禁用已绑定项', async () => {
    const user = userEvent.setup()
    const onBindMany = vi.fn()
    const onClose = vi.fn()
    mocks.listMasterAssets.mockResolvedValueOnce({
      assets: [
        { ...asset('rule-1', '世界规则'), semantic_type: 'rule', record_kind: 'lorebook_template' },
        { ...asset('lore-1', '设定集'), semantic_type: 'world', record_kind: 'lorebook_template' },
      ],
      total: 2,
    })
    render(
      <BindingPicker open multi onClose={onClose} boundMasterIds={new Set(['rule-1'])}
        onBind={vi.fn()} onBindMany={onBindMany} />,
    )
    await waitFor(() => expect(screen.getByText('世界规则')).toBeInTheDocument())

    // rule-1 已绑定 → 按钮禁用且显示“已绑定”
    const boundBtn = screen.getByRole('button', { name: /已绑定/ })
    expect(boundBtn).toBeDisabled()

    // 勾选设定集
    await user.click(screen.getByRole('button', { name: '选择' }))
    const confirmBtn = screen.getByRole('button', { name: /添加所选/ })
    expect(confirmBtn).toHaveTextContent('1')
    await user.click(confirmBtn)

    expect(onBindMany).toHaveBeenCalledTimes(1)
    const picked = onBindMany.mock.calls[0][0]
    expect(picked).toHaveLength(1)
    expect(picked[0].masterItemId).toBe('lore-1')
    expect(picked[0].scope).toBe('world')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('世界资料只显示可零引用保存的语义，并保持服务端原始分页偏移', async () => {
    const user = userEvent.setup()
    const onBindMany = vi.fn()
    mocks.listMasterAssets
      .mockResolvedValueOnce({
        assets: [
          asset('character-1', '不应出现的角色'),
          { ...asset('lore-1', '可绑定设定'), semantic_type: 'lorebook', record_kind: 'lorebook_template' },
        ], total: 3,
      })
      .mockResolvedValueOnce({ assets: [{ ...asset('rule-1', '第二页规则'), semantic_type: 'rule', record_kind: 'lorebook_template' }], total: 3 })

    render(
      <BindingPicker open multi onClose={vi.fn()} boundMasterIds={new Set()} onBind={vi.fn()} onBindMany={onBindMany}
        allowedSemanticTypes={['world', 'rule', 'item', 'other']} />,
    )
    await waitFor(() => expect(screen.getByText('可绑定设定')).toBeInTheDocument())
    expect(screen.queryByText('不应出现的角色')).toBeNull()

    await user.click(screen.getByRole('button', { name: '选择' }))
    await user.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(mocks.listMasterAssets).toHaveBeenCalledTimes(2))
    expect(mocks.listMasterAssets.mock.calls[1][0]).toMatchObject({ offset: 2 })
    expect(await screen.findByText('第二页规则')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /添加所选/ }))
    expect(onBindMany).toHaveBeenCalledWith([expect.objectContaining({ semanticType: 'other', scope: 'world' })])
  })
})
