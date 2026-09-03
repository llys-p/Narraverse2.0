import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoreTranslationDialog } from './LoreTranslationDialog'
import { createTranslationJobs } from '@/lib/api'
import type { LoreItem } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, createTranslationJobs: vi.fn() }
})

function mockLoreItem(overrides: Partial<LoreItem> = {}): LoreItem {
  return {
    id: 'lore-1', enabled: true, type: 'character', type_source: 'manual',
    name: 'Alice', importance: 'major', load_mode: 'resident', tags: ['protagonist'],
    brief_description: 'A brave hero.', keywords: ['Alice'],
    content: 'Alice is a brave hero who saves the world.',
    created_at: '2026-01-01', updated_at: 'r1', ...overrides,
  }
}

describe('LoreTranslationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createTranslationJobs).mockResolvedValue({ ok: true, schema_version: 1, jobs: [], pause_reasons: [], active_id: '', paused: false, counts: {} })
  })

  it('defaults to content only and enqueues it for review', async () => {
    const onOpenChange = vi.fn()
    render(<LoreTranslationDialog open onOpenChange={onOpenChange} workspace="C:/story" draft={mockLoreItem()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.map((box) => (box as HTMLInputElement).checked)).toEqual([false, false, true])

    fireEvent.click(screen.getByTestId('lore-translate-enqueue'))
    await waitFor(() => expect(createTranslationJobs).toHaveBeenCalledWith('C:/story', [{
      item_id: 'lore-1', item_name: 'Alice', field: 'content',
      source_text: 'Alice is a brave hero who saves the world.', base_revision: 'r1',
      mode: 'faithful_zh', apply_policy: 'review_content',
    }]))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses localized-name mode and auto-apply policy for names', async () => {
    render(<LoreTranslationDialog open onOpenChange={vi.fn()} workspace="C:/story" draft={mockLoreItem()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[2])
    fireEvent.click(screen.getByTestId('lore-translate-enqueue'))

    await waitFor(() => expect(createTranslationJobs).toHaveBeenCalledWith('C:/story', [{
      item_id: 'lore-1', item_name: 'Alice', field: 'name', source_text: 'Alice',
      base_revision: 'r1', mode: 'name_zh', apply_policy: 'auto_apply_metadata',
    }]))
  })

  it('disables empty fields and requires a selected nonempty field', () => {
    render(<LoreTranslationDialog open onOpenChange={vi.fn()} workspace="C:/story" draft={mockLoreItem({ content: '', brief_description: '' })} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[1]).toBeDisabled()
    expect(checkboxes[2]).toBeDisabled()
    expect(screen.getByTestId('lore-translate-enqueue')).toBeDisabled()
  })

  it('keeps the dialog open and shows queue failures', async () => {
    vi.mocked(createTranslationJobs).mockRejectedValue(new Error('bridge offline'))
    const onOpenChange = vi.fn()
    render(<LoreTranslationDialog open onOpenChange={onOpenChange} workspace="C:/story" draft={mockLoreItem()} />)
    fireEvent.click(screen.getByTestId('lore-translate-enqueue'))
    expect(await screen.findByText('bridge offline')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
