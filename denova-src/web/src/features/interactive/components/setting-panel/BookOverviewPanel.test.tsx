import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookOverviewPanel } from './BookOverviewPanel'
import { organizeBookOverview, updateLoreItem } from '@/lib/api'
import type { LoreItem } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, organizeBookOverview: vi.fn(), updateLoreItem: vi.fn() }
})

function mockLoreItem(overrides: Partial<LoreItem> = {}): LoreItem {
  return {
    id: 'lore-1', enabled: true, type: 'character', type_source: 'manual',
    name: '守灯人岚', importance: 'major', load_mode: 'auto', tags: [],
    brief_description: '灰潮港最后的守灯人。', keywords: [],
    content: '岚守着旧灯塔。',
    created_at: '2026-01-01', updated_at: 'r1', ...overrides,
  }
}

// 后端已保证数组字段；此用例锁定前端在收到 null（旧响应/异常上游）时也不崩。
const nullArrayUsage = {
  resident_count: 0,
  selected_ids: null,
  unknown_ids: null,
  include_outline: false,
  outline_found: false,
  draft_chars: 0,
  missing: null,
}

describe('BookOverviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('discards an existing draft when switching books with identical content', async () => {
    vi.mocked(organizeBookOverview).mockResolvedValue({ draft: '# Book A draft', used: nullArrayUsage } as never)
    const setContent = vi.fn()
    const { rerender } = render(<BookOverviewPanel workspace="book-a" content="" setContent={setContent} items={[]} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 整理总览/ }))
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }))
    await waitFor(() => expect(screen.getByText('# Book A draft')).toBeInTheDocument())
    rerender(<BookOverviewPanel workspace="book-b" content="" setContent={setContent} items={[]} onSave={vi.fn()} />)
    expect(screen.queryByText('# Book A draft')).not.toBeInTheDocument()
    expect(setContent).not.toHaveBeenCalled()
  })

  it('ignores a generation response arriving after a book switch', async () => {
    let finish!: (value: Awaited<ReturnType<typeof organizeBookOverview>>) => void
    vi.mocked(organizeBookOverview).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const setContent = vi.fn()
    const { rerender } = render(<BookOverviewPanel workspace="book-a" content="" setContent={setContent} items={[]} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 整理总览/ }))
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }))
    rerender(<BookOverviewPanel workspace="book-b" content="" setContent={setContent} items={[]} onSave={vi.fn()} />)
    await act(async () => {
      finish({ draft: '# Late book A draft', used: nullArrayUsage as never })
    })
    expect(screen.queryByText('# Late book A draft')).not.toBeInTheDocument()
    expect(setContent).not.toHaveBeenCalled()
  })

  it('reads the overview as sections and keeps the raw editor behind a toggle', () => {
    const content = [
      '# 雾港',
      '',
      '> 一座被锈潮吞没的港口。',
      '',
      '## 世界概况与时代基调',
      '低魔海雾与账册。',
      '',
      '## 核心矛盾与当前局势',
      '借钥之争。',
    ].join('\n')
    render(<BookOverviewPanel workspace="book-a" content={content} setContent={vi.fn()} items={[mockLoreItem()]} onSave={vi.fn()} />)

    expect(screen.getByText('一座被锈潮吞没的港口。')).toBeInTheDocument()
    expect(screen.getByText('低魔海雾与账册。')).toBeInTheDocument()
    expect(screen.getByText('借钥之争。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
    expect(screen.getByRole('textbox')).toHaveValue(content)
  })

  it('pins an entry without copying its body and refreshes the list', async () => {
    vi.mocked(updateLoreItem).mockResolvedValue(mockLoreItem({ pinned: true, pin_order: 0 }))
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    render(<BookOverviewPanel workspace="book-a" content="# 雾港" setContent={vi.fn()} items={[mockLoreItem()]} onSave={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /选择关键条目/ }))
    fireEvent.click(screen.getByRole('button', { name: '设为关键' }))

    await waitFor(() => expect(updateLoreItem).toHaveBeenCalledWith(
      'lore-1',
      expect.objectContaining({ id: 'lore-1', name: '守灯人岚', pinned: true, pin_order: 0 }),
      'r1',
      'book-a',
    ))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'nova:lore-updated', detail: { workspace: 'book-a' } }))
  })

  it('moves a pinned entry by swapping orders instead of renumbering the book', async () => {
    const first = mockLoreItem({ id: 'a', name: '甲', pinned: true, pin_order: 0 })
    const second = mockLoreItem({ id: 'b', name: '乙', pinned: true, pin_order: 1 })
    vi.mocked(updateLoreItem).mockImplementation(async (id, item) => ({ ...first, ...item, id }) as never)
    render(<BookOverviewPanel workspace="book-a" content="# 雾港" setContent={vi.fn()} items={[first, second]} onSave={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /选择关键条目/ }))
    // 每行都有「下移」，取第一条精选行
    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0])

    await waitFor(() => expect(updateLoreItem).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(updateLoreItem).mock.calls
    expect(calls.map((call) => [call[0], call[1].pin_order].join(':')).sort()).toEqual(['a:1', 'b:0'])
  })

  it('renders an organize draft whose usage arrays arrive as null', async () => {
    vi.mocked(organizeBookOverview).mockResolvedValue({ draft: '# 整理草稿', used: nullArrayUsage } as never)
    const setContent = vi.fn()
    render(<BookOverviewPanel workspace="book-a" content="" setContent={setContent} items={[mockLoreItem()]} onSave={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /AI 整理总览/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: '守灯人岚' }))
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }))

    await waitFor(() => expect(organizeBookOverview).toHaveBeenCalledWith({
      current_draft: '', selected_lore_ids: ['lore-1'], include_outline: true,
    }))
    await waitFor(() => expect(screen.getByText('整理草稿（未保存）')).toBeInTheDocument())
    expect(screen.getByText(/# 整理草稿/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '应用到编辑器' }))
    expect(setContent).toHaveBeenCalledWith('# 整理草稿')
  })

  it('keeps the draft pane separate from the editor until explicitly applied', async () => {
    vi.mocked(organizeBookOverview).mockResolvedValue({
      draft: '# 新草稿',
      used: { ...nullArrayUsage, resident_count: 1, selected_ids: ['lore-1'], missing: ['无长期大纲'] },
    } as never)
    const setContent = vi.fn()
    render(<BookOverviewPanel workspace="book-a" content="# 用户原文" setContent={setContent} items={[mockLoreItem()]} onSave={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /AI 整理总览/ }))
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }))
    await waitFor(() => expect(screen.getByText('整理草稿（未保存）')).toBeInTheDocument())

    // 迟到响应只进预览区：编辑器内容未被覆盖
    expect(setContent).not.toHaveBeenCalled()
    expect(screen.getByText(/无长期大纲/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '放弃草稿' }))
    await waitFor(() => expect(screen.queryByText('整理草稿（未保存）')).not.toBeInTheDocument())
    expect(setContent).not.toHaveBeenCalled()
  })

  it('does not let a late AI draft overwrite edits made while generation was pending', async () => {
    let finish!: (value: Awaited<ReturnType<typeof organizeBookOverview>>) => void
    vi.mocked(organizeBookOverview).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const applied = vi.fn()
    function Harness() {
      const [content, setContent] = useState('# Original')
      return <BookOverviewPanel workspace="book-a" content={content} setContent={(value) => { applied(value); setContent(value) }} items={[]} onSave={vi.fn()} />
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: /AI 整理总览/ }))
    fireEvent.click(screen.getByRole('button', { name: '生成草稿' }))
    await waitFor(() => expect(organizeBookOverview).toHaveBeenCalledWith(expect.objectContaining({ current_draft: '# Original' })))
    fireEvent.change(screen.getByPlaceholderText(/写下本书/), { target: { value: '# New user edit' } })
    finish({ draft: '# AI draft based on old text', used: nullArrayUsage as never })
    await waitFor(() => expect(screen.getByText('整理草稿（未保存）')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '应用到编辑器' }))

    expect(applied).toHaveBeenCalledTimes(1)
    expect(applied).toHaveBeenCalledWith('# New user edit')
    expect(screen.getByPlaceholderText(/写下本书/)).toHaveValue('# New user edit')
  })
  it('stops the remaining pin writes and refresh events when the book changes', async () => {
    let finish!: (value: LoreItem) => void
    vi.mocked(updateLoreItem).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const first = mockLoreItem({ id: 'a', name: '甲', pinned: true, pin_order: 0 })
    const second = mockLoreItem({ id: 'b', name: '乙', pinned: true, pin_order: 1 })
    const events: Event[] = []
    const listener = (event: Event) => { events.push(event) }
    window.addEventListener('nova:lore-updated', listener)
    const props = { content: '', setContent: vi.fn(), items: [first, second], onSave: vi.fn() }
    const { rerender } = render(<BookOverviewPanel workspace="book-a" {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /选择关键条目/ }))
    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0])
    expect(updateLoreItem).toHaveBeenCalledTimes(1)
    rerender(<BookOverviewPanel workspace="book-b" {...props} />)
    await act(async () => { finish(first) })
    expect(updateLoreItem).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    window.removeEventListener('nova:lore-updated', listener)
  })

  it('refreshes after a partially failed swap without selecting a lore row', async () => {
    const first = mockLoreItem({ id: 'a', name: '甲', pinned: true, pin_order: 0 })
    const second = mockLoreItem({ id: 'b', name: '乙', pinned: true, pin_order: 1 })
    vi.mocked(updateLoreItem).mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('CAS conflict'))
    const events: CustomEvent[] = []
    const listener = (event: Event) => { events.push(event as CustomEvent) }
    window.addEventListener('nova:lore-updated', listener)
    render(<BookOverviewPanel workspace="book-a" content="" setContent={vi.fn()} items={[first, second]} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /选择关键条目/ }))
    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0])
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0].detail).toEqual({ workspace: 'book-a' })
    expect(screen.getAllByRole('button', { name: '下移' })[0]).toBeEnabled()
    window.removeEventListener('nova:lore-updated', listener)
  })

  it('opens the full entry from a key card without changing its loading mode', () => {
    const open = vi.fn()
    render(<BookOverviewPanel workspace="book-a" content="" setContent={vi.fn()} items={[mockLoreItem({ pinned: true, load_mode: 'manual' })]} onSave={vi.fn()} onOpenItem={open} />)
    fireEvent.click(screen.getByRole('button', { name: '查看完整条目' }))
    expect(open).toHaveBeenCalledWith('lore-1')
    expect(updateLoreItem).not.toHaveBeenCalled()
  })
})
