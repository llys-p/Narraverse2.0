import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorldContextSelection } from '../components/context/WorldContextSelection'
import type { World } from '../types'
import {
  SELECTION_LIMITS,
  MAX_SELECTED_TOTAL,
  emptyContextSelection,
  findSelectionOverflow,
  pruneContextSelection,
  remapSelectionAfterRuleRemoval,
  toggleRuleIndex,
  toggleSelectionId,
} from '../world-context'

function worldFixture(): World {
  return {
    id: 'w1', schemaVersion: 1, name: '选择世界', status: 'active',
    worldSetting: { tone: '冷峻', rules: ['规则甲', '规则乙'] },
    bindings: [
      // entity 作用域：不应出现在可手动勾选的 world 资料列表
      { bindingId: 'be', masterItemId: 'me', recordKind: 'character_template', semanticType: 'character', nameSnapshot: '角色绑定', tagsSnapshot: [], scope: 'entity', boundAt: '' },
      // world 作用域：应出现
      { bindingId: 'bw', masterItemId: 'mw', recordKind: 'lorebook_template', semanticType: 'rule', nameSnapshot: '世界规则集', tagsSnapshot: [], scope: 'world', boundAt: '' },
    ],
    characters: [
      { id: 'c1', bindingId: 'be', displayName: '角色甲' },
      { id: 'c2', displayName: '角色乙' },
    ],
    locations: [{ id: 'l1', name: '地点甲' }],
    factions: [{ id: 'f1', name: '势力甲' }],
    timeline: [{ id: 't1', order: 0, title: '事件甲', category: 'historical' }],
    createdAt: '', updatedAt: '',
  }
}

function setup(selection = emptyContextSelection()) {
  const onChange = vi.fn()
  const onConsumerChange = vi.fn()
  render(
    <WorldContextSelection
      world={worldFixture()}
      consumer="writing"
      selection={selection}
      onChange={onChange}
      onConsumerChange={onConsumerChange}
    />,
  )
  return { onChange, onConsumerChange }
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('WorldContextSelection B1', () => {
  it('默认 identity-only：所有复选框未选，且出现仅含概览提示', () => {
    setup()
    expect(screen.getByTestId('context-selection-identity-only')).toBeInTheDocument()
    screen.getAllByRole('checkbox').forEach((cb) => expect(cb).not.toBeChecked())
  })

  it('只提供 writing/game 两个 consumer，没有 narraverse/module4', () => {
    setup()
    const group = screen.getByTestId('context-consumer')
    expect(within(group).getByRole('button', { name: '写作模式' })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: '游戏模式' })).toBeInTheDocument()
    expect(within(group).queryByText(/narraverse|module4|叙界|沙盒/i)).toBeNull()
  })

  it('勾选/取消角色：onChange 增删对应 id（不存名称）', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByRole('checkbox', { name: '角色甲' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ characterIds: ['c1'] }))
    const selected = { ...emptyContextSelection(), characterIds: ['c1'] }
    onChange.mockClear()
    // 再次点击取消
    render(<WorldContextSelection world={worldFixture()} consumer="writing" selection={selected} onChange={onChange} onConsumerChange={vi.fn()} />)
    await user.click(screen.getAllByRole('checkbox', { name: '角色甲' })[1])
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ characterIds: [] }))
  })

  it('规则按索引选择，ruleIndexes 存数字下标而非规则正文', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByRole('checkbox', { name: '规则甲' }))
    const next = onChange.mock.calls[0][0]
    expect(next.ruleIndexes).toEqual([0])
    expect(JSON.stringify(next)).not.toContain('规则甲')
  })

  it('纯函数 toggleRuleIndex/toggleSelectionId 去重保序、再次切换移除', () => {
    expect(toggleSelectionId(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleSelectionId(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleRuleIndex([2], 1)).toEqual([1, 2])
    expect(toggleRuleIndex([1, 2], 1)).toEqual([2])
  })

  it('草稿变化后统一剪枝全部六类引用，且无变化时保持原对象', () => {
    const world = worldFixture()
    const selection = {
      includeTone: true,
      ruleIndexes: [-1, 0, 1, 2],
      characterIds: ['missing-character', 'c2'],
      locationIds: ['l1', 'missing-location'],
      factionIds: ['missing-faction', 'f1'],
      timelineEntryIds: ['t1', 'missing-timeline'],
      bindingIds: ['missing-binding', 'bw'],
    }

    expect(pruneContextSelection(selection, world)).toEqual({
      includeTone: true,
      ruleIndexes: [0, 1],
      characterIds: ['c2'],
      locationIds: ['l1'],
      factionIds: ['f1'],
      timelineEntryIds: ['t1'],
      bindingIds: ['bw'],
    })
    const valid = pruneContextSelection(selection, world)
    expect(pruneContextSelection(valid, world)).toBe(valid)
  })

  it('删除规则时移除被删项并重编号后续选择，避免静默选中另一条规则', () => {
    const selection = { ...emptyContextSelection(), ruleIndexes: [0, 2] }
    expect(remapSelectionAfterRuleRemoval(selection, 0).ruleIndexes).toEqual([1])
    expect(remapSelectionAfterRuleRemoval(selection, 1).ruleIndexes).toEqual([0, 1])
    expect(remapSelectionAfterRuleRemoval(selection, 3)).toBe(selection)
  })

  it('全选/清空某一分区', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    // 角色分区有 2 人：点“全选”
    const characterSection = screen.getByText('角色').closest('section')!
    await user.click(within(characterSection).getByRole('button', { name: '全选' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ characterIds: ['c1', 'c2'] }))
  })

  it('world 资料只列 world-scope 绑定，entity 绑定不出现', () => {
    setup()
    const materialSection = screen.getByText('世界级资料').closest('section')!
    expect(materialSection.textContent).toContain('世界规则集')
    expect(materialSection.textContent).not.toContain('角色绑定')
  })

  it('空集合显示空态文案', () => {
    const empty: World = { ...worldFixture(), locations: [], factions: [], timeline: [], worldSetting: { rules: [] } }
    const onChange = vi.fn()
    render(<WorldContextSelection world={empty} consumer="writing" selection={emptyContextSelection()} onChange={onChange} onConsumerChange={vi.fn()} />)
    expect(screen.getByText('还没有地点')).toBeInTheDocument()
    expect(screen.getByText('还没有势力')).toBeInTheDocument()
    expect(screen.getByText('还没有时间线条目')).toBeInTheDocument()
    expect(screen.getByText('还没有世界规则')).toBeInTheDocument()
  })

  it('超限：纯函数报告但不截断，组件显示明确超限提示', () => {
    const ids = Array.from({ length: SELECTION_LIMITS.characterIds + 1 }, (_, i) => `c${i}`)
    const over = { ...emptyContextSelection(), characterIds: ids }
    // 不静默截断：长度保持 21
    expect(over.characterIds).toHaveLength(21)
    const issues = findSelectionOverflow(over)
    expect(issues).toEqual([{ key: 'characterIds', count: 21, max: 20 }])

    render(<WorldContextSelection world={worldFixture()} consumer="writing" selection={over} onChange={vi.fn()} onConsumerChange={vi.fn()} />)
    expect(screen.getByTestId('context-selection-overflow')).toBeInTheDocument()
  })

  it('跨分区总量超过后端上限时也提示，且不静默截断', () => {
    const over = {
      ...emptyContextSelection(),
      characterIds: Array.from({ length: 20 }, (_, i) => `c${i}`),
      locationIds: Array.from({ length: 20 }, (_, i) => `l${i}`),
      factionIds: Array.from({ length: 20 }, (_, i) => `f${i}`),
      bindingIds: ['b-extra'],
    }
    expect(over.characterIds.length + over.locationIds.length + over.factionIds.length + over.bindingIds.length)
      .toBe(MAX_SELECTED_TOTAL + 1)
    expect(findSelectionOverflow(over)).toContainEqual({ key: 'total', count: MAX_SELECTED_TOTAL + 1, max: MAX_SELECTED_TOTAL })

    render(<WorldContextSelection world={worldFixture()} consumer="writing" selection={over} onChange={vi.fn()} onConsumerChange={vi.fn()} />)
    expect(screen.getByTestId('context-selection-total-overflow')).toBeInTheDocument()
  })

  it('挂载时零网络请求、不访问任何浏览器持久化', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setup()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })
})
