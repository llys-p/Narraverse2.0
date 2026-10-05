import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BookGraphView, deriveLoreGraph, pickNodeAt, relationControlPoint } from './BookGraphView'
import type { LoreItem } from '@/lib/api'

function mockLoreItem(overrides: Partial<LoreItem> & { id: string; name: string }): LoreItem {
  return {
    enabled: true, type: 'character', type_source: 'manual',
    importance: 'major', pinned: false, pin_order: 0, load_mode: 'auto', tags: [],
    brief_description: '', keywords: [],
    content: '',
    created_at: '2026-01-01', updated_at: 'r1',
    ...overrides,
  }
}

describe('deriveLoreGraph', () => {
  it('links two items when one mentions the other by name, in either direction', () => {
    const a = mockLoreItem({ id: 'a', name: '守灯人岚', content: '岚守着第七灯塔。' })
    const b = mockLoreItem({ id: 'b', name: '第七灯塔', content: '塔里只有一盏灯。' })
    const graph = deriveLoreGraph([a, b])
    expect(graph.edges).toEqual([{ source: 'a', target: 'b', mentions: 1 }])
  })

  it('merges mutual mentions into one undirected edge', () => {
    const a = mockLoreItem({ id: 'a', name: '守灯人岚', content: '岚守着第七灯塔。' })
    const b = mockLoreItem({ id: 'b', name: '第七灯塔', content: '塔顶住着守灯人岚。' })
    const graph = deriveLoreGraph([a, b])
    expect(graph.edges).toEqual([{ source: 'a', target: 'b', mentions: 2 }])
  })

  it('never links an item to itself even when its own name repeats in its text', () => {
    const a = mockLoreItem({ id: 'a', name: '守灯人岚', content: '守灯人岚守着灯。' })
    expect(deriveLoreGraph([a]).edges).toEqual([])
  })

  it('ignores single-character names and ASCII prefix collisions', () => {
    const lan = mockLoreItem({ id: 'lan', name: '岚', content: '岚守着旧塔。' })
    const tower = mockLoreItem({ id: 'tower', name: '灯塔', content: '灯塔很旧。' })
    const ed = mockLoreItem({ id: 'ed', name: 'Ed', content: 'Ed walks the docks.', type: 'other' })
    const edmund = mockLoreItem({ id: 'edmund', name: 'Edmund', content: 'Edmund knows the harbor.', type: 'other' })
    // 「岚」一字名不建边；「Ed」不命中「Edmund」的前缀，两对之间都没有边。
    expect(deriveLoreGraph([lan, tower, ed, edmund]).edges).toEqual([])
  })

  it('matches ASCII names only at whole-word boundaries', () => {
    const ed = mockLoreItem({ id: 'ed', name: 'Ed', content: '', type: 'other' })
    const dock = mockLoreItem({ id: 'dock', name: 'docks', content: '', type: 'location' })
    const hit = mockLoreItem({ id: 'y', name: 'logs', content: 'Ed spoke near the docks.', type: 'item' })
    const graph = deriveLoreGraph([ed, dock, hit])
    // hit 的正文整词提到 Ed 与 docks，各自成边；dock 的名字不吃进 hit 自己的正文之外。
    expect(graph.edges).toEqual([
      { source: 'ed', target: 'y', mentions: 1 },
      { source: 'dock', target: 'y', mentions: 1 },
    ])
  })

  it('derives directed labeled relations by stable item IDs and suppresses duplicate mention links for that pair', () => {
    const a = mockLoreItem({ id: 'a', name: '北岸', content: '北岸与南港长期往来。', relations: [
      { target_id: 'b', label: '贸易伙伴', note: '每月互市' },
      { target_id: 'b', label: '政治盟友' },
      { target_id: 'missing', label: '失效关系' },
      { target_id: 'a', label: '自我关系' },
    ] })
    const b = mockLoreItem({ id: 'b', name: '南港', content: '南港也提到北岸。', relations: [
      { target_id: 'a', label: '竞争对手' },
    ] })
    const before = structuredClone([a, b])

    const graph = deriveLoreGraph([a, b])

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: 'a', target: 'b', label: '贸易伙伴', note: '每月互市', confirmed: true }),
      expect.objectContaining({ source: 'a', target: 'b', label: '政治盟友', confirmed: true }),
      expect.objectContaining({ source: 'b', target: 'a', label: '竞争对手', confirmed: true }),
    ])
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(3)
    expect(deriveLoreGraph([{ ...a, name: '北境' }, b]).edges.map((edge) => edge.id)).toEqual(graph.edges.map((edge) => edge.id))
    expect([a, b]).toEqual(before)
  })

  it('keeps ordinary inferred mention links visibly distinct from confirmed relations', () => {
    const a = mockLoreItem({ id: 'a', name: '林间旅者', content: '她认识石门村。' })
    const b = mockLoreItem({ id: 'b', name: '石门村' })
    const [edge] = deriveLoreGraph([a, b]).edges
    expect(edge).toMatchObject({ source: 'a', target: 'b', mentions: 1 })
    expect(edge).not.toHaveProperty('confirmed')
  })
})

describe('pickNodeAt', () => {
  it('returns the node under the point (topmost first) and null otherwise', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0, r: 5 },
      { id: 'b', x: 20, y: 0, r: 5 },
    ]
    expect(pickNodeAt(nodes, 4, 0)).toBe('a')
    expect(pickNodeAt(nodes, 16, 0)).toBe('b')
    expect(pickNodeAt(nodes, 10, 10)).toBeNull()
  })
})

describe('relationControlPoint', () => {
  it('keeps opposite directions on distinct canonical sides of the same pair', () => {
    const forward = relationControlPoint({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, 0, 2)
    const reverse = relationControlPoint({ id: 'b', x: 100, y: 0 }, { id: 'a', x: 0, y: 0 }, 1, 2)

    expect(forward.y).toBeLessThan(0)
    expect(reverse.y).toBeGreaterThan(0)
    expect(forward).not.toEqual(reverse)
  })
})

describe('BookGraphView', () => {
  beforeEach(() => {
    // jsdom 没有 2D 上下文：拦截掉，让绘制逻辑安静地跳过，测试只看 DOM 行为。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders an empty state without any items', () => {
    render(<BookGraphView items={[]} />)
    expect(screen.getByText(/还没有资料条目/)).toBeInTheDocument()
  })

  it('filters nodes by type without mutating the underlying items', () => {
    const a = mockLoreItem({ id: 'a', name: '守灯人岚', content: '守着第七灯塔。' })
    const b = mockLoreItem({ id: 'b', name: '第七灯塔', type: 'location', content: '岚住在塔里。' })
    render(<BookGraphView items={[a, b]} />)

    expect(screen.getByText('2 个条目 · 1 条关系')).toBeInTheDocument()
    const relationList = screen.getByRole('list', { name: '图谱关系说明' })
    expect(within(relationList).getAllByRole('listitem')).toHaveLength(1)
    const characterBox = screen.getByRole('checkbox', { name: '角色' }) as HTMLInputElement
    expect(characterBox).toBeChecked()
    fireEvent.click(characterBox)
    expect(characterBox).not.toBeChecked()
    expect(screen.getByText('1 个条目 · 0 条关系')).toBeInTheDocument()
    expect(within(relationList).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('renders explicit relation labels and notes in an accessible DOM list', () => {
    const a = mockLoreItem({ id: 'a', name: '北岸', relations: [{ target_id: 'b', label: '贸易伙伴', note: '每月互市' }] })
    const b = mockLoreItem({ id: 'b', name: '南港' })
    render(<BookGraphView items={[a, b]} />)

    const relations = screen.getByRole('list', { name: '图谱关系说明' })
    expect(within(relations).getByRole('listitem')).toHaveTextContent('北岸 → 南港：贸易伙伴 — 每月互市')
  })

  it('exposes a search field and a reset control', () => {
    const a = mockLoreItem({ id: 'a', name: '守灯人岚', content: '' })
    render(<BookGraphView items={[a]} />)
    fireEvent.change(screen.getByPlaceholderText('搜索条目...'), { target: { value: '岚' } })
    expect(screen.getByRole('button', { name: '重置视图' })).toBeInTheDocument()
  })

  it('binds canvas listeners when items arrive after the empty state', () => {
    const canvasAddEventListener = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener')
    const windowAddEventListener = vi.spyOn(window, 'addEventListener')
    const { rerender } = render(<BookGraphView items={[]} />)
    canvasAddEventListener.mockClear()
    windowAddEventListener.mockClear()

    rerender(<BookGraphView items={[mockLoreItem({ id: 'a', name: '守灯人岚' })]} />)

    expect(canvasAddEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })
    expect(windowAddEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('cleans up the timeout fallback when animation frames are unavailable', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const { unmount } = render(<BookGraphView items={[mockLoreItem({ id: 'a', name: '守灯人岚' })]} />)

    expect(() => unmount()).not.toThrow()
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('subscribes to app theme changes so canvas colors can be redrawn', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    render(<BookGraphView items={[mockLoreItem({ id: 'a', name: '守灯人岚' })]} />)

    expect(observe).toHaveBeenCalledWith(document.documentElement, expect.objectContaining({ attributes: true }))
  })

  it('does not open a node on secondary-button input and clears a cancelled pointer', () => {
    const onOpenItem = vi.fn()
    render(<BookGraphView items={[mockLoreItem({ id: 'a', name: '守灯人岚' })]} onOpenItem={onOpenItem} />)
    const canvas = document.querySelector('canvas')!

    fireEvent.pointerDown(canvas, { button: 2, pointerId: 3, clientX: -20, clientY: 18 })
    fireEvent.pointerUp(canvas, { button: 2, pointerId: 3, clientX: -20, clientY: 18 })
    expect(onOpenItem).not.toHaveBeenCalled()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: -20, clientY: 18 })
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 4, clientX: -20, clientY: 18 })
    expect(onOpenItem).toHaveBeenCalledWith('a')

    onOpenItem.mockClear()
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 5, clientX: -20, clientY: 18 })
    fireEvent.pointerCancel(canvas, { pointerId: 5, clientX: -20, clientY: 18 })
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 5, clientX: -20, clientY: 18 })
    expect(onOpenItem).not.toHaveBeenCalled()
  })
})
