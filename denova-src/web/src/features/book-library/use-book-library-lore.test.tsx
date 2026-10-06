import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLoreItemImage, generateLoreItemImage, createLoreItem, deleteLoreItem, getLoreItems, updateLoreItem, uploadLoreItemImages } from '@/lib/api'
import type { LoreItem } from '@/lib/api'
import { useBookLibraryLore } from './use-book-library-lore'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    getLoreItems: vi.fn(),
    updateLoreItem: vi.fn(),
    createLoreItem: vi.fn(),
    deleteLoreItem: vi.fn(),
    uploadLoreItemImages: vi.fn(),
    removeLoreItemImage: vi.fn(),
    generateLoreItemImage: vi.fn(),
    clearLoreItemImage: vi.fn(),
  }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }
})

function entry(overrides: Partial<LoreItem> = {}): LoreItem {
  return {
    id: 'a1',
    enabled: true,
    type: 'character',
    type_source: 'manual',
    name: '林照',
    importance: 'major',
    load_mode: 'resident',
    character_tier: 'major',
    tags: ['守灯人'],
    keywords: [],
    brief_description: '第七灯塔的新任守灯人',
    content: '正文',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: 'rev-1',
    ...overrides,
  } as LoreItem
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

describe('useBookLibraryLore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(updateLoreItem).mockImplementation(async (id, input) => ({ ...entry(), ...input, id, updated_at: 'rev-2' }))
    vi.mocked(createLoreItem).mockImplementation(async (input) => ({ ...entry(), ...input, id: 'new-1', updated_at: 'rev-new' } as LoreItem))
  })

  it('A→B→A：迟到的 A 列表不会覆盖已经落地的 B 视图', async () => {
    const bookA = deferred<LoreItem[]>()
    const bookB = deferred<LoreItem[]>()
    vi.mocked(getLoreItems).mockImplementationOnce(() => bookA.promise).mockImplementationOnce(() => bookB.promise)

    const hook = renderHook(({ workspace }) => useBookLibraryLore(workspace), { initialProps: { workspace: '/books/A' } })
    hook.rerender({ workspace: '/books/B' })

    // B 先返回，A 的请求随后迟到
    bookB.resolve([entry({ id: 'b1', name: '沈砚' })])
    await waitFor(() => expect(hook.result.current.items.map((item) => item.id)).toEqual(['b1']))

    bookA.resolve([entry({ id: 'a1', name: '林照' })])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hook.result.current.items.map((item) => item.id)).toEqual(['b1'])
    expect(hook.result.current.activeId).toBe('b1')

    // 切回 A 时重新读取，A 的旧响应不会被当成当前状态复用
    vi.mocked(getLoreItems).mockImplementationOnce(async () => [entry({ id: 'a1', name: '林照' })])
    hook.rerender({ workspace: '/books/A' })
    await waitFor(() => expect(hook.result.current.items.map((item) => item.id)).toEqual(['a1']))
    hook.unmount()
  })

  it('迟到的 A 响应被丢弃后，当前书仍能拿到自己的列表', async () => {
    const bookA = deferred<LoreItem[]>()
    const bookB = deferred<LoreItem[]>()
    vi.mocked(getLoreItems).mockImplementationOnce(() => bookA.promise).mockImplementationOnce(() => bookB.promise)

    const hook = renderHook(({ workspace }) => useBookLibraryLore(workspace), { initialProps: { workspace: '/books/A' } })
    hook.rerender({ workspace: '/books/B' })

    bookA.resolve([entry({ id: 'a1', name: '林照' })])
    bookB.resolve([entry({ id: 'b1', name: '沈砚' })])
    await waitFor(() => expect(hook.result.current.loading).toBe(false))

    expect(hook.result.current.items.map((item) => item.id)).toEqual(['b1'])
    hook.unmount()
  })

  it('同名不同 workspace 的两本书各自独立，不会互相串数据', async () => {
    const first = [entry({ id: 'a1', name: '雾港' })]
    const second = [entry({ id: 'b1', name: '雾港' }), entry({ id: 'b2', name: '第七灯塔' })]
    vi.mocked(getLoreItems)
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => second)

    const hook = renderHook(({ workspace }) => useBookLibraryLore(workspace), { initialProps: { workspace: '/ws-one/雾港' } })
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1))
    expect(hook.result.current.activeId).toBe('a1')

    hook.rerender({ workspace: '/ws-two/雾港' })
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2))
    expect(hook.result.current.items.map((item) => item.id)).toEqual(['b1', 'b2'])
    expect(hook.result.current.activeId).toBe('b1')
    hook.unmount()
  })

  it('没有当前书时不请求条目，也不会伪造演示数据', async () => {
    const hook = renderHook(() => useBookLibraryLore(''))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(getLoreItems).not.toHaveBeenCalled()
    expect(hook.result.current.items).toEqual([])
    expect(hook.result.current.draft).toBeNull()
    hook.unmount()
  })

  it('编辑走既有 revision/autosave 通道，并把 workspace 作为 CAS 守卫', async () => {
    vi.mocked(getLoreItems).mockImplementation(async () => [entry()])
    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    act(() => hook.result.current.setDraft({ ...entry(), name: '林照（改）' }))
    await act(async () => { await hook.result.current.saveNow() })

    expect(updateLoreItem).toHaveBeenCalled()
    const [id, payload, baseRevision] = vi.mocked(updateLoreItem).mock.calls.at(-1) || []
    expect(id).toBe('a1')
    expect(payload).toMatchObject({ name: '林照（改）' })
    expect(baseRevision).toBeTruthy()
    hook.unmount()
  })

  it('批改层级只改 character_tier，不动加载方式与重要性', async () => {
    const target = entry({ id: 'a1', character_tier: 'unclassified', load_mode: 'auto', importance: 'important' })
    vi.mocked(getLoreItems).mockImplementation(async () => [target])
    vi.mocked(updateLoreItem).mockImplementation(async (id, input) => ({ ...target, ...input, id, updated_at: 'rev-2' } as LoreItem))

    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    let result: { changed: string[]; failed: number } | undefined
    await act(async () => { result = await hook.result.current.updateTierBatch(['a1'], 'major') })

    expect(result).toEqual({ changed: ['a1'], failed: 0 })
    const [, payload, baseRevision, workspace] = vi.mocked(updateLoreItem).mock.calls.at(-1) || []
    expect(payload).toMatchObject({ character_tier: 'major', load_mode: 'auto', importance: 'important' })
    expect(baseRevision).toBe('rev-1')
    expect(workspace).toBe('/books/A')
    hook.unmount()
  })

  it('批改遇到迟到批次时丢弃旧书结果，不写回当前书视图', async () => {
    const batch = deferred<LoreItem>()
    vi.mocked(getLoreItems).mockImplementation(async () => [entry({ id: 'a1', character_tier: 'major' })])
    vi.mocked(updateLoreItem).mockImplementation(() => batch.promise)

    const hook = renderHook(({ workspace }) => useBookLibraryLore(workspace), { initialProps: { workspace: '/books/A' } })
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    let pending: Promise<{ changed: string[]; failed: number }> | undefined
    act(() => { pending = hook.result.current.updateTierBatch(['a1'], 'minor') })
    await act(async () => { hook.rerender({ workspace: '/books/B' }) })

    batch.resolve({ ...entry({ id: 'a1' }), character_tier: 'minor', updated_at: 'rev-late' })
    const outcome = await pending!
    expect(outcome.changed).toEqual([])

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.items.map((item) => item.character_tier)).toEqual(['major'])
    hook.unmount()
  })

  it('外部写入事件只刷新当前书，并按 workspace 过滤', async () => {
    vi.mocked(getLoreItems).mockImplementation(async () => [entry()])
    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(getLoreItems).toHaveBeenCalledTimes(1))

    act(() => {
      window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { workspace: '/books/OTHER' } }))
    })
    expect(getLoreItems).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new CustomEvent('nova:lore-updated', { detail: { workspace: '/books/A' } }))
    })
    await waitFor(() => expect(getLoreItems).toHaveBeenCalledTimes(2))
    hook.unmount()
  })

  it('新建条目使用真实接口返回，并把选中项切到新条目', async () => {
    vi.mocked(getLoreItems).mockImplementation(async () => [entry()])
    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    let created: LoreItem | null | undefined
    await act(async () => {
      created = await hook.result.current.createItem({ name: '雾港', type: 'location', brief_description: '港口' })
    })

    expect(createLoreItem).toHaveBeenCalledWith(expect.objectContaining({ name: '雾港', type: 'location' }), '/books/A')
    expect(created?.id).toBe('new-1')
    await waitFor(() => expect(hook.result.current.activeId).toBe('new-1'))
    hook.unmount()
  })

  // ---- 复审返修 F1：写入必须带目标书籍守卫，且不能靠响应后再比对 ----

  it('F1 反例：删除等待保存期间切书，不得继续发出删除请求', async () => {
    const pendingSave = deferred<LoreItem>()
    vi.mocked(getLoreItems).mockImplementation(async () => [entry({ id: 'same-id' })])
    vi.mocked(updateLoreItem).mockImplementation(() => pendingSave.promise)
    vi.mocked(deleteLoreItem).mockResolvedValue()

    const hook = renderHook(({ workspace }) => useBookLibraryLore(workspace), { initialProps: { workspace: '/books/A' } })
    await waitFor(() => expect(hook.result.current.activeId).toBe('same-id'))

    act(() => hook.result.current.setDraft({ ...entry({ id: 'same-id' }), content: '未保存编辑' }))
    let removing!: Promise<boolean>
    act(() => { removing = hook.result.current.removeItem('same-id') })
    await waitFor(() => expect(updateLoreItem).toHaveBeenCalled())

    // 保存仍在等待时换书
    await act(async () => { hook.rerender({ workspace: '/books/B' }) })
    await act(async () => {
      pendingSave.resolve({ ...entry({ id: 'same-id' }), content: 'saved', updated_at: 'r2' })
      await removing
    })

    expect(deleteLoreItem).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('F1 同书删除仍然可用，并把目标书籍交给服务端复核', async () => {
    vi.mocked(getLoreItems).mockImplementation(async () => [entry()])
    vi.mocked(deleteLoreItem).mockResolvedValue()
    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    let ok: boolean | undefined
    await act(async () => { ok = await hook.result.current.removeItem('a1') })

    expect(ok).toBe(true)
    expect(deleteLoreItem).toHaveBeenCalledWith('a1', '/books/A')
    hook.unmount()
  })

  it('F1 普通自动保存也带目标 workspace，服务端才能拒绝跨书写入', async () => {
    vi.mocked(getLoreItems).mockImplementation(async () => [entry()])
    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    act(() => hook.result.current.setDraft({ ...entry(), name: '林照（改）' }))
    await act(async () => { await hook.result.current.saveNow() })

    expect(updateLoreItem).toHaveBeenCalled()
    const call = vi.mocked(updateLoreItem).mock.calls.at(-1) || []
    expect(call[0]).toBe('a1')
    expect(call[1]).toMatchObject({ name: '林照（改）' })
    expect(call[2]).toBeTruthy()
    expect(call[3]).toBe('/books/A')
    hook.unmount()
  })

  it('F1 图片结果晚到时不得并回换书后的视图', async () => {
    const upload = deferred<LoreItem>()
    vi.mocked(getLoreItems).mockImplementation(async () => [entry()])
    const uploadSpy = vi.mocked(uploadLoreItemImages).mockImplementation(async () => upload.promise)

    const hook = renderHook(({ workspace }) => useBookLibraryLore(workspace), { initialProps: { workspace: '/books/A' } })
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))

    let running!: Promise<void>
    act(() => { running = hook.result.current.uploadImages([new File(['x'], 'a.png', { type: 'image/png' })]) })
    await act(async () => { hook.rerender({ workspace: '/books/B' }) })
    await act(async () => {
      upload.resolve({ ...entry(), images: [{ image_path: 'assets/lore/uploads/a.png' }], updated_at: 'r9' } as LoreItem)
      await running
    })

    expect(uploadSpy).toHaveBeenCalledWith('a1', '/books/A', expect.anything())
    expect(hook.result.current.items.find((item) => item.id === 'a1')?.images || []).toHaveLength(0)
    hook.unmount()
  })

  it('AI 生图和清图请求都携带发起书的 workspace', async () => {
    vi.mocked(getLoreItems).mockResolvedValue([entry()])
    vi.mocked(generateLoreItemImage).mockResolvedValue(entry())
    vi.mocked(clearLoreItemImage).mockResolvedValue(entry())
    const hook = renderHook(() => useBookLibraryLore('/books/A'))
    await waitFor(() => expect(hook.result.current.activeId).toBe('a1'))
    await act(async () => { await hook.result.current.generateImage('夜色', 'game-cg') })
    expect(generateLoreItemImage).toHaveBeenCalledWith('a1', { instruction: '夜色', image_preset_id: 'game-cg' }, '/books/A')
    await act(async () => { await hook.result.current.clearImage() })
    expect(clearLoreItemImage).toHaveBeenCalledWith('a1', '/books/A')
    hook.unmount()
  })
})
