import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkLibrary } from '@/lib/api-client'
import { LibraryContextPreview } from './LibraryContextPreview'
import { previewWorkLibrary } from '../library-context-api'

vi.mock('../library-context-api', () => ({ previewWorkLibrary: vi.fn() }))
const library: WorkLibrary = { id: 'abcdefghijklmnop', name: '测试库', purpose: 'any', schemaVersion: 1,
  items: [
    { id: 'a', name: '按需项', type: 'character', enabled: true, loadMode: 'auto', origin: 'original', importance: 'major', createdAt: '', updatedAt: '' },
    { id: 'm', name: '手动项', type: 'rule', enabled: true, loadMode: 'manual', origin: 'original', importance: 'minor', createdAt: '', updatedAt: '' },
    { id: 'off', name: '禁用项', type: 'rule', enabled: false, loadMode: 'manual', origin: 'original', importance: 'minor', createdAt: '', updatedAt: '' },
  ], relations: [], createdAt: '', updatedAt: '' }
const result = { libraryId: library.id, revision: 'one', name: '测试库', summary: '', tone: '', startingPoint: '',
  catalog: { items: [], offset: 0, total: 0 }, loaded: [], relations: [], issues: [],
  budget: { bytes: 300, maxBytes: 262144, estimatedTokens: 100, maxEstimatedTokens: 16000 } }

describe('library load preview', () => {
  beforeEach(() => vi.resetAllMocks())
  it('requests only after a click and excludes disabled entries', async () => {
    vi.mocked(previewWorkLibrary).mockResolvedValue(result)
    render(<LibraryContextPreview library={library} revision="one" dirty={false} />)
    expect(previewWorkLibrary).not.toHaveBeenCalled()
    expect(screen.queryByText(/禁用项/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生成加载预览' }))
    await waitFor(() => expect(previewWorkLibrary).toHaveBeenCalledOnce())
    expect(previewWorkLibrary).toHaveBeenCalledWith(library.id, {
      expectedRevision: 'one', manualItemIds: [], autoItemIds: [], catalogOffset: 0, catalogLimit: 50,
    })
    expect(screen.getByText(/尚未发送模型/)).toBeInTheDocument()
  })
  it('never generates from an unsaved draft', () => {
    render(<LibraryContextPreview library={library} revision="one" dirty />)
    expect(screen.getByRole('button', { name: '生成加载预览' })).toBeDisabled()
    expect(previewWorkLibrary).not.toHaveBeenCalled()
  })
  it('discards a late response after revision changes and keeps prior results stale', async () => {
    let resolve!: (value: typeof result) => void
    vi.mocked(previewWorkLibrary).mockReturnValue(new Promise((done) => { resolve = done }))
    const view = render(<LibraryContextPreview library={library} revision="one" dirty={false} />)
    fireEvent.click(screen.getByRole('button', { name: '生成加载预览' }))
    view.rerender(<LibraryContextPreview library={library} revision="two" dirty={false} />)
    await act(async () => resolve(result))
    expect(screen.queryByText(/100.*16000/)).toBeNull()
    expect(screen.getByRole('button', { name: '生成加载预览' })).not.toBeDisabled()
  })
  it('shows failures without claiming content was loaded', async () => {
    vi.mocked(previewWorkLibrary).mockRejectedValue({ code: 'revision_conflict' })
    render(<LibraryContextPreview library={library} revision="one" dirty={false} />)
    fireEvent.click(screen.getByRole('button', { name: '生成加载预览' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('资料库已变化'))
  })
})
