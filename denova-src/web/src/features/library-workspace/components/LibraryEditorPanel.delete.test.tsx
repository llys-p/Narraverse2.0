import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibrary } from '@/lib/api-client'
import type { WorkLibraryEditorState } from '../use-work-library'
import { LibraryEditorPanel } from './LibraryEditorPanel'

const mocks = vi.hoisted(() => ({ getWorkLibraryItemImpact: vi.fn() }))
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  getWorkLibraryItemImpact: mocks.getWorkLibraryItemImpact,
}))

const library: WorkLibrary = {
  id: 'abcdefghijklmnop', schemaVersion: 1, name: '水浒', purpose: 'any',
  items: [{ id: 'c', name: '林冲', type: 'character', enabled: true, importance: 'important',
    loadMode: 'auto', origin: 'original', createdAt: '', updatedAt: 'b' }],
  relations: [], createdAt: '', updatedAt: '',
}

describe('delete impact before library item removal', () => {
  it('loads the impact before offering an explicit cascade', async () => {
    const deleteItem = vi.fn(async () => ({ status: 'deleted' as const }))
    const editor = {
      status: 'ready', error: null, library, revision: 'sha256:one', timeline: [], conflict: null,
      dismissConflict: vi.fn(), reload: vi.fn(), saveMeta: vi.fn(), createItem: vi.fn(),
      saveItem: vi.fn(), deleteItem, createRelation: vi.fn(), saveRelation: vi.fn(),
      deleteRelation: vi.fn(), lastError: null, clearLastError: vi.fn(),
    } as WorkLibraryEditorState
    mocks.getWorkLibraryItemImpact.mockResolvedValue({ itemId: 'c', itemName: '林冲',
      relations: [{ id: 'r1', fromItemId: 'c', toItemId: 'x', kind: 'ally' }], events: [],
    })
    render(<LibraryEditorPanel editor={editor} vocabulary={null} onBack={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '条目' }))
    fireEvent.click(screen.getByRole('button', { name: '删除条目' }))
    expect(deleteItem).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText(/r1/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /同时移除这些引用并删除/ }))
    await waitFor(() => expect(deleteItem).toHaveBeenCalledWith('c', true))
  })
})
