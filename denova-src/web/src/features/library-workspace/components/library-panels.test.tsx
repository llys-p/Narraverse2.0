import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkLibrary, WorkLibraryItemInput, WorkLibrarySummary } from '@/lib/api-client'
import type { WorkLibraryEditorState } from '../use-work-library'
import { LibraryConflictBanner } from './LibraryConflictBanner'
import { LibraryEditorPanel } from './LibraryEditorPanel'
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

  it('shows an inline hint instead of staying silent when the new-library name is empty', async () => {
    const onCreate = vi.fn()
    render(<LibraryListPanel status="ready" libraries={[]} warnings={[]} creating={false}
      vocabulary={null} onOpen={vi.fn()} onCreate={onCreate} />)
    fireEvent.click(screen.getAllByRole('button', { name: '创建' })[0])
    const nameInput = screen.getByPlaceholderText(/梁山风云/)
    // 按钮已禁用，但输入框里按 Enter 以前会静默无响应。
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('请填写库名称')
    expect(onCreate).not.toHaveBeenCalled()
    // 输入有效名称后提示消失，Enter 正常提交且名称被 trim。
    fireEvent.change(nameInput, { target: { value: '  水浒  ' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: '水浒', purpose: 'any' }))
  })
})

const editorLibrary: WorkLibrary = {
  id: 'abcdefghijklmnop', schemaVersion: 1, name: '水浒', purpose: 'any',
  items: [{ id: 'c', name: '林冲', type: 'character', enabled: true, importance: 'important',
    loadMode: 'auto', origin: 'original', createdAt: '', updatedAt: 'b' }],
  relations: [], createdAt: '', updatedAt: '',
}

function renderEditorPanel(createItem: ReturnType<typeof vi.fn>) {
  const editor = {
    status: 'ready', error: null, library: editorLibrary, revision: 'sha256:one', timeline: [], conflict: null,
    dismissConflict: vi.fn(), reload: vi.fn(), saveMeta: vi.fn(), createItem,
    saveItem: vi.fn(), deleteItem: vi.fn(async () => ({ status: 'deleted' as const })),
    createRelation: vi.fn(), saveRelation: vi.fn(), deleteRelation: vi.fn(),
    lastError: null, clearLastError: vi.fn(),
  } as unknown as WorkLibraryEditorState
  return render(<LibraryEditorPanel editor={editor} vocabulary={null} onBack={vi.fn()} />)
}

describe('new entry composer', () => {
  it('requires a real name before creating so the stable id never comes from the placeholder', async () => {
    const createItem = vi.fn(async (input: WorkLibraryItemInput) => ({
      id: 'wusong', name: input.name, type: input.type, enabled: true, importance: input.importance,
      loadMode: 'auto', origin: 'original', createdAt: '', updatedAt: 't1',
    }))
    renderEditorPanel(createItem)
    fireEvent.click(screen.getByRole('button', { name: '条目' }))
    fireEvent.click(screen.getByRole('button', { name: '新建条目' }))
    // 打开作曲器时不发起任何创建请求。
    expect(createItem).not.toHaveBeenCalled()
    const nameInput = screen.getByPlaceholderText(/条目名称/)
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('请填写条目名称')
    expect(createItem).not.toHaveBeenCalled()
    fireEvent.change(nameInput, { target: { value: '武松' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(createItem).toHaveBeenCalledOnce())
    expect(createItem.mock.calls[0][0]).toMatchObject({ type: 'character', name: '武松', loadMode: 'auto' })
  })

  it('creates timeline events from the composer with the typed title and event type locked', async () => {
    const createItem = vi.fn(async (input: WorkLibraryItemInput) => ({
      id: 'juyi', name: input.name, type: 'event', enabled: true, importance: input.importance,
      loadMode: 'auto', origin: 'original', createdAt: '', updatedAt: 't1',
    }))
    renderEditorPanel(createItem)
    fireEvent.click(screen.getByRole('button', { name: '事件与时间线' }))
    fireEvent.click(screen.getByRole('button', { name: '新建事件' }))
    // 从时间线发起：自动回到条目 tab，类型选择锁定为 event。
    const typeSelect = screen.getAllByRole('combobox')
      .find((element) => (element as HTMLSelectElement).disabled) as HTMLSelectElement
    expect(typeSelect).toBeDefined()
    expect(typeSelect).toHaveValue('event')
    fireEvent.change(screen.getByPlaceholderText(/条目名称/), { target: { value: '聚义' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(createItem).toHaveBeenCalledOnce())
    expect(createItem.mock.calls[0][0]).toMatchObject({
      type: 'event', name: '聚义', event: { category: 'background', participantItemIds: [] },
    })
  })
})
