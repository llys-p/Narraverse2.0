import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibraryItem } from '@/lib/api-client'
import { LibraryLoadSettings } from './LibraryLoadSettings'

const items: WorkLibraryItem[] = [{
  id: 'c', name: '林冲', type: 'character', enabled: true, importance: 'important', loadMode: 'auto',
  origin: 'original', createdAt: 'a', updatedAt: 'b',
}, {
  id: 'r', name: '核心规则', type: 'rule', enabled: true, importance: 'major', loadMode: 'resident',
  origin: 'original', createdAt: 'a', updatedAt: 'b',
}]

describe('LibraryLoadSettings', () => {
  it('saves selected load modes and enabled flags using per-item baselines', async () => {
    const onSave = vi.fn(async () => true)
    render(<LibraryLoadSettings items={items} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText(/林冲.*加载档位/), { target: { value: 'manual' } })
    fireEvent.click(screen.getByLabelText(/林冲.*启用/))
    fireEvent.click(screen.getByRole('button', { name: /保存设置/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('c', {
      baseUpdatedAt: 'b', loadMode: 'manual', enabled: false,
    }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
