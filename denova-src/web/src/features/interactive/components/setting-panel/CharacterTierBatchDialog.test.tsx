import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CharacterTierBatchDialog } from './CharacterTierBatchDialog'
import { getLoreItems, updateLoreItem } from '@/lib/api'
import type { LoreItem } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, getLoreItems: vi.fn(), updateLoreItem: vi.fn() }
})

function lore(overrides: Partial<LoreItem> = {}): LoreItem {
  return {
    id: 'person-1', enabled: true, type: 'character', type_source: 'manual', name: '岚',
    importance: 'major', load_mode: 'auto', character_tier: 'unclassified', tags: [], keywords: [],
    brief_description: '守灯人', content: '完整人物正文', created_at: 'created', updated_at: 'revision-1', ...overrides,
  }
}

const props = (overrides: Partial<React.ComponentProps<typeof CharacterTierBatchDialog>> = {}) => ({
  workspace: 'book-a', items: [lore()], onBeforeWrite: vi.fn(async () => true),
  onSaved: vi.fn(), onChanged: vi.fn(), ...overrides,
})

describe('CharacterTierBatchDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('closes on cancel without writing', () => {
    render(<CharacterTierBatchDialog {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(updateLoreItem).not.toHaveBeenCalled()
  })

  it('searches only characters and selects all visible matches', () => {
    render(<CharacterTierBatchDialog {...props({ items: [
      lore(), lore({ id: 'person-2', name: '岚的同伴' }), lore({ id: 'place', type: 'location', name: '灯塔' }),
    ] })} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    expect(screen.queryByText('灯塔')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: '同伴' } })
    expect(screen.getByRole('checkbox', { name: '岚的同伴' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '岚' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(screen.getByRole('checkbox', { name: '岚的同伴' })).toBeChecked()
  })

  it('flushes first, rereads, then sends a full item with CAS revision and workspace', async () => {
    const item = lore()
    const latest = { ...item, content: 'flush后的完整正文', updated_at: 'revision-flushed' }
    const order: string[] = []
    const onBeforeWrite = vi.fn(async () => { order.push('flush'); return true })
    vi.mocked(getLoreItems).mockImplementation(async () => { order.push('reread'); return [latest] })
    vi.mocked(updateLoreItem).mockImplementation(async () => {
      order.push('write')
      return { ...latest, character_tier: 'major' }
    })
    render(<CharacterTierBatchDialog {...props({ onBeforeWrite })} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '岚' }))
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: '主要人物' }))
    fireEvent.click(screen.getByRole('button', { name: '应用人物层级' }))

    await waitFor(() => expect(updateLoreItem).toHaveBeenCalledOnce())
    expect(onBeforeWrite).toHaveBeenCalledOnce()
    expect(getLoreItems).toHaveBeenCalledOnce()
    expect(updateLoreItem).toHaveBeenCalledWith('person-1', {
      id: 'person-1', enabled: true, type: 'character', type_source: 'manual', name: '岚', importance: 'major',
      load_mode: 'auto', character_tier: 'major', tags: [], brief_description: '守灯人', keywords: [],
      content: 'flush后的完整正文',
    }, 'revision-flushed', 'book-a')
    expect(order).toEqual(['flush', 'reread', 'write'])
  })

  it('does not write when flushing fails', async () => {
    render(<CharacterTierBatchDialog {...props({ onBeforeWrite: vi.fn(async () => false) })} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '岚' }))
    fireEvent.click(screen.getByRole('button', { name: '应用人物层级' }))
    await waitFor(() => expect(updateLoreItem).not.toHaveBeenCalled())
    expect(getLoreItems).not.toHaveBeenCalled()
  })

  it('reports partial failure and returns only successful ids', async () => {
    const one = lore()
    const two = lore({ id: 'person-2', name: '澄', updated_at: 'revision-2' })
    const onChanged = vi.fn()
    const onSaved = vi.fn()
    vi.mocked(getLoreItems).mockResolvedValue([one, two])
    vi.mocked(updateLoreItem).mockResolvedValueOnce({ ...one, character_tier: 'minor' }).mockRejectedValueOnce(new Error('conflict'))
    render(<CharacterTierBatchDialog {...props({ items: [one, two], onChanged, onSaved })} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '岚' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '澄' }))
    fireEvent.click(screen.getByRole('button', { name: '应用人物层级' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(['person-1']))
    expect(onSaved).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent('部分人物层级未能保存')
  })

  it('shows an explicit error and skips an id missing from the flushed list', async () => {
    const onChanged = vi.fn()
    vi.mocked(getLoreItems).mockResolvedValue([])
    render(<CharacterTierBatchDialog {...props({ onChanged })} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '岚' }))
    fireEvent.click(screen.getByRole('button', { name: '应用人物层级' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('选中的条目已不存在或不再是人物'))
    expect(updateLoreItem).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('ignores late responses after switching workspaces', async () => {
    let finish!: (value: LoreItem[]) => void
    vi.mocked(getLoreItems).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const onSaved = vi.fn()
    const onChanged = vi.fn()
    const shared = props({ onSaved, onChanged })
    const { rerender } = render(<CharacterTierBatchDialog {...shared} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '岚' }))
    fireEvent.click(screen.getByRole('button', { name: '应用人物层级' }))
    rerender(<CharacterTierBatchDialog {...shared} workspace="book-b" />)
    await act(async () => finish([lore()]))
    expect(updateLoreItem).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('does not write or call back after unmount', async () => {
    let finish!: (value: LoreItem[]) => void
    vi.mocked(getLoreItems).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const onSaved = vi.fn()
    const onChanged = vi.fn()
    const { unmount } = render(<CharacterTierBatchDialog {...props({ onSaved, onChanged })} />)
    fireEvent.click(screen.getByRole('button', { name: '批量设置人物层级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '岚' }))
    fireEvent.click(screen.getByRole('button', { name: '应用人物层级' }))
    unmount()
    await act(async () => finish([lore()]))
    expect(updateLoreItem).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
