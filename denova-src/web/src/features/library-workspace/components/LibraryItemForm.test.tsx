import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibraryItem } from '@/lib/api-client'
import { LibraryItemForm } from './LibraryItemForm'

const reference: WorkLibraryItem = {
  id: 'linchong', name: '林冲', type: 'character', enabled: true, importance: 'important',
  loadMode: 'auto', origin: 'reference', source: {
    kind: 'master', id: 'master-1', revision: 'sha256:abc', label: '林冲',
  }, createdAt: 'a', updatedAt: 'b',
}

describe('LibraryItemForm provenance', () => {
  it('keeps the source body and name read-only until the user explicitly adapts it', () => {
    const onSave = vi.fn()
    render(<LibraryItemForm item={reference} vocabulary={null} saving={false} onSave={onSave}
      onDelete={vi.fn()} readOnlyBody />)
    expect(screen.getByLabelText('名称')).toHaveAttribute('readonly')
    expect(screen.getByLabelText(/^正文/)).toHaveAttribute('readonly')
    expect(screen.getByText(/sha256:abc/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建本项目版本' }))
    fireEvent.change(screen.getByLabelText(/^正文/), { target: { value: '本库改编内容' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'adaptation', content: '本库改编内容', baseUpdatedAt: 'b',
    }))
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('source')
  })

  it('reports an unsaved local draft when a field changes', async () => {
    const onDirtyChange = vi.fn()
    render(<LibraryItemForm item={reference} vocabulary={null} saving={false} onSave={vi.fn()}
      onDelete={vi.fn()} readOnlyBody onDirtyChange={onDirtyChange} />)
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '梁山' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })
})
