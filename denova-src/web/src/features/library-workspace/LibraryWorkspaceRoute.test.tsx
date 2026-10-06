import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LibraryWorkspaceRoute } from './LibraryWorkspaceRoute'
import { useWorkspaceStore } from '@/stores/workspace-store'

vi.mock('./LibraryWorkspacePage', () => ({
  LibraryWorkspacePage: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <button type="button" onClick={() => onDirtyChange(true)}>edit draft</button>
  ),
}))
vi.mock('@/features/library/LibraryView', () => ({ LibraryView: () => <div>public materials</div> }))
vi.mock('@/features/book-library/BookLibraryWorkspace', () => ({
  BookLibraryWorkspace: ({ workspace, bookName, onDirtyChange }: { workspace: string; bookName: string; onDirtyChange: (dirty: boolean) => void }) => (
    <div data-slot="book-workbench" data-workspace={workspace} data-book={bookName}>
      <span>book workbench</span>
      <button type="button" onClick={() => onDirtyChange(true)}>mark book draft</button>
    </div>
  ),
}))

describe('library workspace draft guard', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ librarySection: null })
    window.localStorage.removeItem('nova:library-section')
  })

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

  it('有当前书时默认进入本书资料分区，没有书时回落作品设定库', async () => {
    render(<LibraryWorkspaceRoute workspace="/books/雾港" bookName="雾港纪事" onClose={vi.fn()} />)
    expect(screen.getByRole('tab', { name: '本书资料' })).toHaveAttribute('aria-selected', 'true')
    const panel = await screen.findByText('book workbench')
    expect(panel.closest('[data-slot="book-workbench"]')).toHaveAttribute('data-workspace', '/books/雾港')
    expect(panel.closest('[data-slot="book-workbench"]')).toHaveAttribute('data-book', '雾港纪事')
  })

  it('无当前书时仍进作品设定库；本书分区拿到的作用域为空，不塞演示书', async () => {
    render(<LibraryWorkspaceRoute workspace="" bookName="" onClose={vi.fn()} />)
    expect(screen.getByRole('tab', { name: '我的作品设定库' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: '本书资料' }))
    // 空 workspace 原样传给工作台，由它给出「选择书籍」提示，而不是伪造一本书
    const panel = await screen.findByText('book workbench')
    expect(panel.closest('[data-slot="book-workbench"]')).toHaveAttribute('data-workspace', '')
    expect(screen.getByRole('tab', { name: '本书资料' })).toHaveAttribute('aria-selected', 'true')
  })

  it('本书分区的未保存草稿同样受分区切换保护', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<LibraryWorkspaceRoute workspace="/books/雾港" bookName="雾港纪事" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'mark book draft' }))
    fireEvent.click(screen.getByRole('tab', { name: '我的作品设定库' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: '本书资料' })).toHaveAttribute('aria-selected', 'true')
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('tab', { name: '我的作品设定库' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'edit draft' })).toBeInTheDocument())
    confirm.mockRestore()
  })

  it('外部入口请求分区时以请求为准，并把选择写回共享状态', () => {
    const onSectionChange = vi.fn()
    render(
      <LibraryWorkspaceRoute
        workspace=""
        onClose={vi.fn()}
        section="public"
        onSectionChange={onSectionChange}
      />,
    )
    expect(screen.getByRole('tab', { name: '公共素材' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: '本书资料' }))
    expect(onSectionChange).toHaveBeenCalledWith('book')
  })

  it('作品设定库与公共素材在原有路径上继续可用', async () => {
    render(<LibraryWorkspaceRoute workspace="" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'edit draft' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '公共素材' }))
    await waitFor(() => expect(screen.getByText('public materials')).toBeInTheDocument())
  })
})
