import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LibraryDeleteImpact } from './LibraryDeleteImpact'

describe('LibraryDeleteImpact', () => {
  it('shows both affected relations and event references before cascade', () => {
    render(<LibraryDeleteImpact impact={{
      itemId: 'c', itemName: '林冲',
      relations: [{ id: 'r1', fromItemId: 'c', toItemId: 's', kind: 'ally', createdAt: '', updatedAt: '' }],
      events: [{ itemId: 'e', title: '聚义', era: '宋', order: 1, category: 'historical', enabled: true }],
    }} />)
    expect(screen.getByText(/r1/)).toBeInTheDocument()
    expect(screen.getByText(/聚义/)).toBeInTheDocument()
  })
})
