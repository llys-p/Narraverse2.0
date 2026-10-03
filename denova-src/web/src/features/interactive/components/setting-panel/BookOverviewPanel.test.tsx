import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookOverviewPanel } from './BookOverviewPanel'
import { organizeBookOverview } from '@/lib/api'
import type { LoreItem } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, organizeBookOverview: vi.fn() }
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
})
