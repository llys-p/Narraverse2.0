import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LibraryWorkspaceRoute } from './LibraryWorkspaceRoute'

vi.mock('./LibraryWorkspacePage', () => ({
  LibraryWorkspacePage: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <button type="button" onClick={() => onDirtyChange(true)}>edit draft</button>
  ),
}))
vi.mock('@/features/library/LibraryView', () => ({ LibraryView: () => <div>public materials</div> }))

describe('library workspace draft guard', () => {
  it('does not switch away from an unsaved library when the user cancels', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<LibraryWorkspaceRoute workspace="" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'edit draft' }))
    fireEvent.click(screen.getByRole('tab', { name: '公共素材' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: '我的作品设定库' })).toHaveAttribute('aria-selected', 'true')
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('tab', { name: '公共素材' }))
    await waitFor(() => expect(screen.getByText('public materials')).toBeInTheDocument())
    confirm.mockRestore()
  })
})
