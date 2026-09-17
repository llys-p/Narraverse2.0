import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibrarySummary } from '@/lib/api-client'
import { LibraryConflictBanner } from './LibraryConflictBanner'
import { LibraryListPanel } from './LibraryListPanel'

describe('library panels', () => {
  it('preserves a conflict draft until the caller chooses reload or dismiss', () => {
    const onReload = vi.fn()
    const onDismiss = vi.fn()
    render(<LibraryConflictBanner conflict={{ scope: 'item', message: 'conflict' }} onReload={onReload} onDismiss={onDismiss} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }))
    fireEvent.click(screen.getByRole('button', { name: /保留草稿/ }))
    expect(onReload).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('offers creation in an empty library and opens an existing library by stable ID', () => {
    const onCreate = vi.fn()
    const onOpen = vi.fn()
    const props = { status: 'ready' as const, warnings: [], creating: false, vocabulary: null, onCreate, onOpen }
    const view = render(<LibraryListPanel {...props} libraries={[]} />)
    expect(screen.getByText(/还没有作品设定库/)).toBeInTheDocument()
    view.rerender(<LibraryListPanel {...props} libraries={[{
      id: 'abcdefghijklmnop', name: '水浒', purpose: 'any', itemCount: 0, eventCount: 0,
      relationCount: 0, referenceCount: 0, residentCount: 0, createdAt: '', updatedAt: '',
    } satisfies WorkLibrarySummary]} />)
    fireEvent.click(screen.getByRole('button', { name: /水浒/ }))
    expect(onOpen).toHaveBeenCalledWith('abcdefghijklmnop')
  })

  it('shows a load failure with retry instead of presenting an empty library', () => {
    const onRetry = vi.fn()
    render(<LibraryListPanel status="error" error="network" onRetry={onRetry} libraries={[]}
      warnings={[]} creating={false} vocabulary={null} onOpen={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.queryByText(/还没有作品设定库/)).toBeNull()
    expect(screen.getByText('network')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('retains the new-library form after a failed create request', async () => {
    const onCreate = vi.fn(async () => false)
    render(<LibraryListPanel status="ready" libraries={[]} warnings={[]} creating={false}
      vocabulary={null} onOpen={vi.fn()} onCreate={onCreate} />)
    fireEvent.click(screen.getAllByRole('button', { name: '创建' })[0])
    fireEvent.change(screen.getByPlaceholderText(/梁山风云/), { target: { value: '水浒' } })
    fireEvent.click(screen.getAllByRole('button', { name: '创建' })[1])
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(screen.getByPlaceholderText(/梁山风云/)).toHaveValue('水浒')
  })
})
