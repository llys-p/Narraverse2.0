import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibraryItemInput } from '@/lib/api-client'
import { LibrarySourcePicker } from './LibrarySourcePicker'

const mocks = vi.hoisted(() => ({ listMasterAssets: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ listMasterAssets: mocks.listMasterAssets }))

describe('LibrarySourcePicker', () => {
  it('creates a versioned read-only reference from an explicitly selected Master asset', async () => {
    mocks.listMasterAssets.mockResolvedValue({ assets: [{
      master_item_id: 'm1', name: '林冲', semantic_type: 'character', master_revision: 'sha256:abc',
      availability: 'usable', tags: ['豹子头'],
    }], total: 1 })
    const onCreate = vi.fn(async (_input: WorkLibraryItemInput) => true)
    render(<LibrarySourcePicker onCreate={onCreate} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: '林冲' } })
    fireEvent.click(screen.getByRole('button', { name: /搜索/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /林冲/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /林冲/ }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'reference', source: { kind: 'master', id: 'm1', revision: 'sha256:abc', label: '林冲' },
    })))
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty('content')
  })

  it('records a manually identified legacy source as a pointer without a body', async () => {
    const onCreate = vi.fn(async (_input: WorkLibraryItemInput) => true)
    render(<LibrarySourcePicker onCreate={onCreate} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('来源类型'), { target: { value: 'lore' } })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '旧作品人物' } })
    fireEvent.change(screen.getByLabelText('来源条目 ID'), { target: { value: 'old-1' } })
    fireEvent.change(screen.getByLabelText('来源版本'), { target: { value: 'sha256:old' } })
    fireEvent.click(screen.getByRole('button', { name: '建立只读引用' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'reference', name: '旧作品人物', source: expect.objectContaining({ kind: 'lore', id: 'old-1', revision: 'sha256:old' }),
    })))
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty('content')
  })
})
