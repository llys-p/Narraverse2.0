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
})
