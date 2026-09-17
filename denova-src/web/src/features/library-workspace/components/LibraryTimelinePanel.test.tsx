import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LibraryTimelinePanel } from './LibraryTimelinePanel'

describe('LibraryTimelinePanel', () => {
  it('opens the underlying event item rather than persisting a second timeline', () => {
    const onOpen = vi.fn()
    render(<LibraryTimelinePanel timeline={[{
      itemId: 'evt', title: '梁山聚义', era: '北宋', order: 1,
      category: 'historical', enabled: true, participants: ['linchong'], locationId: 'liangshan',
    }]} onOpen={onOpen} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /梁山聚义/ }))
    expect(onOpen).toHaveBeenCalledWith('evt')
    expect(screen.getByText(/派生视图/)).toBeInTheDocument()
  })
})
