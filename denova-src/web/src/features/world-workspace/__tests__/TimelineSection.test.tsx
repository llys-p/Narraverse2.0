import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TimelineSection } from '../components/sections/TimelineSection'
import type { World, WorldTimelineEntry } from '../types'

function entry(id: string, title: string, category?: WorldTimelineEntry['category']): WorldTimelineEntry {
  const value: WorldTimelineEntry = { id, title, order: Number(id.replace(/\D/g, '')) || 1 }
  if (arguments.length >= 3) value.category = category
  return value
}

function worldWith(timeline: WorldTimelineEntry[]): World {
  return {
    id: 'w1', schemaVersion: 1, name: '时间线世界', status: 'active',
    bindings: [], characters: [], locations: [], factions: [], timeline,
    createdAt: '', updatedAt: '',
  }
}

function cardFor(title: string): HTMLElement {
  const titleInput = screen.getByDisplayValue(title)
  const card = titleInput.parentElement?.parentElement
  if (!card) throw new Error(`missing timeline card for ${title}`)
  return card
}

describe('TimelineSection Phase 3.1C3b', () => {
  it('按八态契约展示当前值、旧值和空值，不把旧 Canon 显示成新 Canon', () => {
    const timeline = [
      entry('e1', '背景事件', 'background'),
      entry('e2', '历史事件', 'historical'),
      entry('e3', '规划事件', 'planned'),
      entry('e4', '旧 Canon', 'canon'),
      entry('e5', '未知旧值', 'legacy-custom'),
      entry('e6', '空字符串', ''),
      entry('e7', '空值', null),
      entry('e8', '缺失字段'),
    ]

    render(<TimelineSection world={worldWith(timeline)} onChange={vi.fn()} />)

    expect(cardFor('背景事件')).toHaveTextContent('背景')
    expect(cardFor('历史事件')).toHaveTextContent('历史')
    expect(cardFor('规划事件')).toHaveTextContent('规划中')
    expect(cardFor('旧 Canon')).toHaveTextContent('历史（旧数据）')
    expect(cardFor('旧 Canon')).not.toHaveTextContent('Canon')
    expect(cardFor('未知旧值')).toHaveTextContent('背景（旧数据）')
    for (const title of ['空字符串', '空值', '缺失字段']) {
      expect(cardFor(title)).toHaveTextContent('背景')
      expect(cardFor(title)).not.toHaveTextContent('旧数据')
    }
  })

  it('挂载和只读展示不会自动改写原始分类', () => {
    const onChange = vi.fn()
    const timeline = [
      entry('e1', '旧 Canon', 'canon'),
      entry('e2', '未知旧值', 'legacy-custom'),
      entry('e3', '空值', null),
      entry('e4', '缺失字段'),
    ]
    const world = worldWith(timeline)

    render(<TimelineSection world={world} onChange={onChange} readOnly />)

    expect(onChange).not.toHaveBeenCalled()
    expect(world.timeline).toBe(timeline)
    expect(world.timeline[0].category).toBe('canon')
    expect(world.timeline[1].category).toBe('legacy-custom')
    expect(world.timeline[2].category).toBeNull()
    expect(Object.hasOwn(world.timeline[3], 'category')).toBe(false)
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled()
  })

  it('只有用户显式选择时才把旧值升级为当前三值，并保留条目其它字段', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const original = { ...entry('e1', '旧 Canon', 'canon'), eraLabel: '旧纪元', description: '既有描述' }
    render(<TimelineSection world={worldWith([original])} onChange={onChange} />)

    const select = within(cardFor('旧 Canon')).getByRole('combobox')
    expect(within(select).getAllByRole('option').map((option) => option.getAttribute('value')))
      .toEqual(['background', 'historical', 'planned'])
    await user.selectOptions(select, 'planned')

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0][0]).toEqual([{ ...original, category: 'planned' }])
  })

  it('有条目和空状态都显示世界背景边界说明', () => {
    const { rerender } = render(
      <TimelineSection world={worldWith([entry('e1', '背景事件', 'background')])} onChange={vi.fn()} />,
    )
    expect(screen.getByText('时间线用于记录世界背景，不是跨模式共享的剧情真相。')).toBeInTheDocument()

    rerender(<TimelineSection world={worldWith([])} onChange={vi.fn()} />)
    expect(screen.getByText('时间线用于记录世界背景，不是跨模式共享的剧情真相。')).toBeInTheDocument()
  })
})
