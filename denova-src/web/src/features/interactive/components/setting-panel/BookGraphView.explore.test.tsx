import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoreItem } from '@/lib/api'
import { BookGraphView } from './BookGraphView'

const item = (id: string, name: string, extra: Partial<LoreItem> = {}): LoreItem => ({
  id, name, type: 'character', type_source: 'manual', enabled: true, importance: 'major',
  load_mode: 'auto', pinned: false, pin_order: 0, keywords: [], tags: [], brief_description: '',
  content: '', created_at: 'r1', updated_at: 'r1', ...extra,
})
const items = [
  item('a', '北岸', { relations: [{ target_id: 'b', label: '盟友' }] }),
  item('b', '南港', { relations: [{ target_id: 'c', label: '贸易' }] }),
  item('c', '西城'), item('d', '东塔', { content: '北岸有往来。' }),
]

describe('BookGraphView exploration', () => {
  beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null))
  afterEach(() => vi.restoreAllMocks())

  it('defaults to confirmed relations and explicitly opts into mention clues', () => {
    render(<BookGraphView items={items} />)
    expect(screen.getByText('4 个条目 · 2 条关系')).toBeInTheDocument()
    const inferred = screen.getByRole('checkbox', { name: '显示正文提及线索' })
    expect(inferred).not.toBeChecked()
    fireEvent.click(inferred)
    expect(screen.getByText('4 个条目 · 3 条关系')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '关系类型' }), { target: { value: '盟友' } })
    expect(screen.getByText('4 个条目 · 1 条关系')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: '图谱关系说明' })).getByRole('listitem')).toHaveTextContent('盟友')
  })

  it('shows one or two hops, opens the chosen item and can return to the full graph', () => {
    const open = vi.fn()
    const before = structuredClone(items)
    render(<BookGraphView items={items} onOpenItem={open} />)
    fireEvent.change(screen.getByRole('combobox', { name: '局部图中心' }), { target: { value: 'a' } })
    expect(screen.getByText('2 个条目 · 1 条关系')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '邻居层数' }), { target: { value: '2' } })
    expect(screen.getByText('3 个条目 · 2 条关系')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开中心条目' }))
    expect(open).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByRole('button', { name: '返回全图' }))
    expect(screen.getByText('4 个条目 · 2 条关系')).toBeInTheDocument()
    expect(items).toEqual(before)
  })

  it('falls back safely when the selected center is removed', () => {
    const { rerender } = render(<BookGraphView items={items} />)
    fireEvent.change(screen.getByRole('combobox', { name: '局部图中心' }), { target: { value: 'a' } })
    rerender(<BookGraphView items={items.slice(1)} />)
    expect(screen.getByRole('combobox', { name: '局部图中心' })).toHaveValue('')
    expect(screen.getByText('3 个条目 · 1 条关系')).toBeInTheDocument()
  })

  it('resets a relation filter whose label no longer exists', () => {
    const { rerender } = render(<BookGraphView items={items} />)
    fireEvent.change(screen.getByRole('combobox', { name: '关系类型' }), { target: { value: '盟友' } })
    expect(screen.getByText('4 个条目 · 1 条关系')).toBeInTheDocument()
    rerender(<BookGraphView items={[{ ...items[0], relations: [] }, ...items.slice(1)]} />)
    expect(screen.getByRole('combobox', { name: '关系类型' })).toHaveValue('')
    expect(within(screen.getByRole('list', { name: '图谱关系说明' })).getByRole('listitem')).toHaveTextContent('贸易')
  })

  it('has one canvas in full screen, closes via Escape and preserves view filters', () => {
    render(<BookGraphView items={items} />)
    fireEvent.change(screen.getByRole('combobox', { name: '局部图中心' }), { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: '全屏图谱' }))
    const dialog = screen.getByRole('dialog', { name: '关系图谱' })
    expect(document.querySelectorAll('canvas')).toHaveLength(1)
    expect(within(dialog).getByText('2 个条目 · 1 条关系')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '局部图中心' })).toHaveValue('a')
    expect(document.querySelectorAll('canvas')).toHaveLength(1)
  })

  it('changes display spacing without storage or network writes', () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const fetch = vi.spyOn(globalThis, 'fetch')
    const before = structuredClone(items)
    render(<BookGraphView items={items} />)
    fireEvent.change(screen.getByRole('slider', { name: '节点间距' }), { target: { value: '1.8' } })
    expect(screen.getByRole('slider', { name: '节点间距' })).toHaveValue('1.8')
    expect(storage).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(items).toEqual(before)
  })
})
