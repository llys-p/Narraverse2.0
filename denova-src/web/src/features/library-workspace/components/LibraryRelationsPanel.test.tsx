import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibraryItem } from '@/lib/api-client'
import { LibraryRelationsPanel } from './LibraryRelationsPanel'

const items = ['a', 'b'].map((id) => ({
  id, name: '同名', type: 'character', enabled: true, importance: 'important', loadMode: 'auto',
  origin: 'original', createdAt: '', updatedAt: '',
})) as WorkLibraryItem[]

describe('LibraryRelationsPanel', () => {
  it('uses stable IDs when two entries have the same display name', async () => {
    const onCreate = vi.fn(async () => true)
    render(<LibraryRelationsPanel items={items} relations={[]} vocabulary={null}
      onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '新建关联' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      fromItemId: 'a', toItemId: 'b', kind: 'ally',
    })))
  })

  it('reports an unsaved relation draft to the editor guard', async () => {
    const onDirtyChange = vi.fn()
    render(<LibraryRelationsPanel items={items} relations={[]} vocabulary={null}
      onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onDirtyChange={onDirtyChange} />)
    fireEvent.change(screen.getByLabelText('展示标签'), { target: { value: '结义' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })
})
