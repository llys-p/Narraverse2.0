import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookLibraryWorkspace } from './BookLibraryWorkspace'
import { createLoreItem, getLoreItems, readFile, saveFile, updateLoreItem } from '@/lib/api'
import type { LoreItem } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    getLoreItems: vi.fn(),
    updateLoreItem: vi.fn(),
    createLoreItem: vi.fn(),
    deleteLoreItem: vi.fn(),
    readFile: vi.fn(),
    saveFile: vi.fn(),
  }
})

vi.mock('@/features/interactive/api', () => ({
  getImagePresets: vi.fn(async () => []),
}))

const tools = vi.hoisted(() => ({ flush: vi.fn(async () => true) }))
vi.mock('@/features/interactive/components/SettingPanel', () => ({
  SettingPanel: ({ showBookOverview, onFlushHandlerChange }: {
    showBookOverview?: boolean
    onFlushHandlerChange?: (handler: (() => Promise<boolean>) | null) => void
  }) => {
    useEffect(() => {
      onFlushHandlerChange?.(tools.flush)
      return () => onFlushHandlerChange?.(null)
    }, [onFlushHandlerChange])
    return <div data-testid="library-tools" data-overview={String(showBookOverview)}>原有资料工具</div>
  },
}))

// 图谱自身有独立回归；这里用桩统计「存活的画布实例数」，验证跳转不会重新挂载画布。
const graph = { live: 0, mounts: 0, unmounts: 0, lastCount: -1 }
vi.mock('@/features/interactive/components/setting-panel/BookGraphView', () => ({
  BookGraphView: ({ items, onOpenItem }: { items: LoreItem[]; onOpenItem?: (id: string) => void }) => {
    useEffect(() => {
      graph.live += 1
      graph.mounts += 1
      return () => { graph.live -= 1; graph.unmounts += 1 }
    }, [])
    graph.lastCount = items.length
    return (
      <div data-testid="graph-stub" data-count={items.length}>
        <button type="button" onClick={() => onOpenItem?.('a1')}>从图谱打开档案</button>
      </div>
    )
  },
}))

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
    content: '正文一',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    ...overrides,
  } as LoreItem
}

function realBook(): LoreItem[] {
  return [
    entry({ id: 'a1', name: '林照', updated_at: '2026-10-04T00:00:00Z' }),
    entry({ id: 'a2', name: '沈砚', character_tier: 'major', updated_at: '2026-10-05T00:00:00Z' }),
    entry({ id: 'a3', name: '陶铃', character_tier: undefined, updated_at: '2026-10-04T00:00:00Z' }),
    entry({ id: 'p1', name: '雾港', type: 'location', load_mode: 'auto', importance: 'important', character_tier: undefined, updated_at: '2026-10-03T00:00:00Z' }),
    entry({ id: 'f1', name: '守灯人协会', type: 'faction', load_mode: 'auto', importance: 'important', character_tier: undefined, updated_at: '2026-10-02T00:00:00Z' }),
    entry({ id: 'r1', name: '守灯人誓言', type: 'rule', load_mode: 'manual', importance: 'minor', character_tier: undefined, updated_at: '2026-10-01T00:00:00Z' }),
  ]
}

function withMinors(count: number): LoreItem[] {
  return Array.from({ length: count }, (_, index) => entry({
    id: `n${index}`,
    name: index % 5 === 0 ? `共同前缀${index}` : `次要${index}`,
    character_tier: 'minor',
    load_mode: 'auto',
    importance: 'minor',
    tags: [],
  }))
}

function renderWorkspace(items = realBook(), workspace = '/books/雾港') {
  vi.mocked(getLoreItems).mockImplementation(async () => items)
  return render(<BookLibraryWorkspace workspace={workspace} bookName="雾港纪事" onClose={vi.fn()} />)
}

const nav = () => screen.getByRole('navigation', { name: '本书资料导航' })

async function gotoView(label: RegExp | string) {
  fireEvent.click(await screen.findByRole('button', { name: label }))
}

/** 打开详情是异步的（先 flush 上一条保存），以档案标题作为落地信号。 */
async function openDetail(name: string) {
  fireEvent.click(await screen.findByText(name))
  await waitFor(() => expect(screen.getByRole('heading', { name })).toBeInTheDocument())
  await screen.findByRole('button', { name: '编辑' })
}

describe('BookLibraryWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tools.flush.mockReset().mockResolvedValue(true)
    graph.live = 0
    graph.mounts = 0
    graph.unmounts = 0
    vi.mocked(updateLoreItem).mockImplementation(async (id, input) => ({ ...entry(), ...input, id, updated_at: 'rev-2' } as LoreItem))
    vi.mocked(createLoreItem).mockImplementation(async (input) => ({ ...entry(), ...input, id: 'created-1', updated_at: 'rev-new' } as LoreItem))
    vi.mocked(readFile).mockImplementation(async (path) => ({
      path,
      content: '# 雾港纪事 · 故事总览\n\n原文。\n',
      workspace: '/books/雾港',
      revision: 'file-rev-1',
    }))
    vi.mocked(saveFile).mockImplementation(async (path, content) => ({ path, content, message: 'saved', revision: 'file-rev-2' }))
  })

  it('条目与计数全部来自真实接口，不用演示数据填充', async () => {
    renderWorkspace()
    await waitFor(() => expect(within(nav()).getByRole('button', { name: /全部资料/ })).toHaveTextContent('6'))
    expect(within(nav()).getByRole('button', { name: /角色/ })).toHaveTextContent('3')
    expect(within(nav()).getByRole('button', { name: /地点/ })).toHaveTextContent('1')
    expect(within(nav()).getByRole('button', { name: /势力/ })).toHaveTextContent('1')
    expect(within(nav()).getByRole('button', { name: /世界与规则/ })).toHaveTextContent('1')
    expect(within(nav()).getByText('6 条资料')).toBeInTheDocument()
    expect(await screen.findByText('本书资料 · 6 条')).toBeInTheDocument()
    // 继续编辑按真实更新时间排序，最新的一条在最前
    expect(screen.getByText('沈砚')).toBeInTheDocument()
  })

  it('全部资料列表渲染真实条目，点行进入统一档案并显示未填写语义', async () => {
    renderWorkspace()
    await gotoView(/全部资料/)
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('row', { name: /雾港/ })).toBeInTheDocument()

    fireEvent.click(within(table).getByRole('row', { name: /雾港/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '雾港' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
    expect(screen.getAllByText('未填写').length).toBeGreaterThan(0)
  })

  it('人物默认只展示主要人物卡，次要人物走紧凑列表并按 12 位分页', async () => {
    renderWorkspace([...realBook(), ...withMinors(25)])

    await gotoView(/角色/)
    await waitFor(() => expect(screen.getByRole('button', { name: /主要人物 2/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /次要人物 25/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /未分类人物 1/ })).toBeInTheDocument()
    // 默认只看主要人物：两张卡，不混入次要人物
    expect(screen.getByText('林照')).toBeInTheDocument()
    expect(screen.queryByText('次要0')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /次要人物 25/ }))
    await waitFor(() => expect(screen.getByText('第 1–12 位 / 当前 25 位')).toBeInTheDocument())
    expect(screen.getByRole('navigation', { name: '人物分页' })).toBeInTheDocument()
    expect(screen.getByText('第 1 页 / 共 3 页')).toBeInTheDocument()
    const namePattern = /^(次要|共同前缀)\d+$/
    expect(screen.getAllByText(namePattern)).toHaveLength(12)

    const firstPage = screen.getAllByText(namePattern).map((node) => node.textContent)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByText('第 13–24 位 / 当前 25 位')).toBeInTheDocument())
    const secondPage = screen.getAllByText(namePattern).map((node) => node.textContent)
    expect(secondPage).toHaveLength(12)
    expect(secondPage.some((name) => firstPage.includes(name))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByText('第 25–25 位 / 当前 25 位')).toBeInTheDocument())
    const thirdPage = screen.getAllByText(namePattern).map((node) => node.textContent)
    expect(thirdPage).toHaveLength(1)
    const combined = [...firstPage, ...secondPage, ...thirdPage]
    expect(combined).toHaveLength(25)
    expect(new Set(combined).size).toBe(25)

    fireEvent.click(screen.getByRole('button', { name: /未分类人物 1/ }))
    await waitFor(() => expect(screen.getByText('第 1–1 位 / 当前 1 位')).toBeInTheDocument())
    expect(screen.getByText('陶铃')).toBeInTheDocument()
  })

  it('搜索先作用于全量人物再分页，翻页控件随结果同步', async () => {
    renderWorkspace([...realBook(), ...withMinors(25)])
    await gotoView(/角色/)
    await waitFor(() => expect(screen.getByRole('button', { name: /次要人物 25/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /次要人物 25/ }))
    await waitFor(() => expect(screen.getByText('第 1–12 位 / 当前 25 位')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled()

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索本书资料' }), { target: { value: '共同前缀' } })
    await waitFor(() => expect(screen.getByText('第 1–5 位 / 当前 5 位')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument()
    expect(screen.getAllByText(/共同前缀/)).toHaveLength(5)
  })

  it('从档案编辑走既有条目保存通道，加载方式与重要性原样回写', async () => {
    renderWorkspace()
    await gotoView(/全部资料/)
    await openDetail('沈砚')

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const nameInput = await screen.findByRole('textbox', { name: '名称' })
    fireEvent.change(nameInput, { target: { value: '沈砚（改）' } })
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))

    await waitFor(() => expect(updateLoreItem).toHaveBeenCalled())
    const [id, payload, baseRevision] = vi.mocked(updateLoreItem).mock.calls.at(-1) || []
    expect(id).toBe('a2')
    expect(payload).toMatchObject({ name: '沈砚（改）', load_mode: 'resident', importance: 'major', character_tier: 'major' })
    expect(baseRevision).toBeTruthy()
  })

  it('图谱作为独立视图挂载真实条目集合，抽屉打开与关闭都不重新挂载画布', async () => {
    renderWorkspace()
    await gotoView('关系图')
    const stub = await screen.findByTestId('graph-stub')
    expect(stub).toHaveAttribute('data-count', '6')
    await waitFor(() => expect(graph.live).toBe(1))
    expect(graph.mounts).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '从图谱打开档案' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: '条目抽屉' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '打开完整档案' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '林照' })).toBeInTheDocument()
    expect(graph.unmounts).toBe(0)
    expect(graph.mounts).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '条目抽屉' })).not.toBeInTheDocument())
    expect(screen.getByTestId('graph-stub')).toBeInTheDocument()
    expect(graph.unmounts).toBe(0)
    expect(graph.mounts).toBe(1)
  })

  it('抽屉里的「打开完整档案」才离开图谱', async () => {
    renderWorkspace()
    await gotoView('关系图')
    await screen.findByTestId('graph-stub')
    await waitFor(() => expect(graph.live).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: '从图谱打开档案' }))
    fireEvent.click(await screen.findByRole('button', { name: '打开完整档案' }))
    await waitFor(() => expect(screen.queryByTestId('graph-stub')).not.toBeInTheDocument())
    // 只有视图切换才会卸载画布，抽屉本身不造成卸载/重挂
    expect(graph.unmounts).toBe(1)
    expect(graph.mounts).toBe(1)
  })

  it('档案只列同书可解析的显式关系，不把正文提及当关系', async () => {
    renderWorkspace([
      entry({ id: 'a1', name: '林照', relations: [
        { target_id: 'a2', label: '互相信任', note: '未说出那一页' },
        { target_id: 'ghost', label: '旧关联' },
      ] }),
      entry({ id: 'a2', name: '沈砚', character_tier: 'major' }),
    ])
    await gotoView(/全部资料/)
    await openDetail('林照')

    expect(screen.getByText('显式关系 · 1 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '沈砚' })).toBeInTheDocument()
    expect(screen.queryByText('旧关联')).not.toBeInTheDocument()
    expect(screen.getByText('互相信任 · 未说出那一页')).toBeInTheDocument()
  })

  it('没有当前书时给出选择书籍提示，不伪造演示书', async () => {
    renderWorkspace([], '')
    expect(await screen.findByText('还没有打开书籍')).toBeInTheDocument()
    expect(getLoreItems).not.toHaveBeenCalled()
  })

  it('新建走真实创建接口并落到新条目档案', async () => {
    const created = entry({ id: 'created-1', name: '第七灯塔', type: 'location', character_tier: undefined })
    vi.mocked(getLoreItems).mockImplementation(async () => [created, ...realBook()])
    render(<BookLibraryWorkspace workspace="/books/雾港" bookName="雾港纪事" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '新建资料' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '第七灯塔' } })
    fireEvent.click(screen.getByRole('combobox', { name: '类型' }))
    fireEvent.click(await screen.findByRole('option', { name: '地点' }))
    fireEvent.click(screen.getByRole('button', { name: '添加资料' }))

    await waitFor(() => expect(createLoreItem).toHaveBeenCalledWith(expect.objectContaining({ name: '第七灯塔', type: 'location' }), '/books/雾港'))
    await waitFor(() => expect(screen.getByRole('heading', { name: '第七灯塔' })).toBeInTheDocument())
  })

  it('换书后回到工作台并重新读取，上一本书的条目不残留', async () => {
    const first = realBook()
    const second = [entry({ id: 'z9', name: '另一个角色', character_tier: undefined })]
    vi.mocked(getLoreItems)
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => second)
    const view = render(<BookLibraryWorkspace workspace="/books/A" bookName="A" onClose={vi.fn()} />)
    await waitFor(() => expect(within(nav()).getByRole('button', { name: /全部资料/ })).toHaveTextContent('6'))

    view.rerender(<BookLibraryWorkspace workspace="/books/B" bookName="B" onClose={vi.fn()} />)
    await waitFor(() => expect(within(nav()).getByRole('button', { name: /全部资料/ })).toHaveTextContent('1'))
    expect(screen.queryByText('林照')).not.toBeInTheDocument()
  })

  // ---- 复审返修 F2：总览草稿不能随视图卸载而静默丢失 ----

  const overviewEditor = () => within(overviewHost()).getByPlaceholderText(/写下本书的整体背景/) as HTMLTextAreaElement

  const overviewArea = () => {
    return within(overviewHost())
  }

  function overviewHost() {
    const host = document.querySelector('.bl-overview-host')
    if (!host) throw new Error('overview host not mounted')
    return host as HTMLElement
  }

  async function enterOverview() {
    await gotoView('书籍总览')
    await waitFor(() => expect(document.querySelector('.bl-overview-host')).not.toBeNull())
    fireEvent.click(overviewArea().getByRole('button', { name: '编辑' }))
    return overviewEditor()
  }

  it('编辑总览后立即切页会先落盘，切回来草稿仍在', async () => {
    renderWorkspace()
    const editor = await enterOverview()

    fireEvent.change(editor, { target: { value: '# 雾港纪事 · 故事总览\n\n快速切页标记。' } })
    fireEvent.click(within(nav()).getByRole('button', { name: '工作台' }))

    await waitFor(() => expect(saveFile).toHaveBeenCalled())
    const [path, content, baseRevision, fileWorkspace] = vi.mocked(saveFile).mock.calls.at(-1) || []
    expect(path).toBe('setting/book-overview.md')
    expect(String(content)).toContain('快速切页标记')
    expect(baseRevision).toBeTruthy()
    expect(fileWorkspace).toBe('/books/雾港')

    // 草稿归工作台持有：切回来仍是刚写的内容，不是服务器旧值
    fireEvent.click(within(nav()).getByRole('button', { name: '书籍总览' }))
    await waitFor(() => expect(document.querySelector('.bl-overview-host')).not.toBeNull())
    fireEvent.click(overviewArea().getByRole('button', { name: '编辑' }))
    expect(overviewEditor().value).toContain('快速切页标记')
  })

  it('总览保存失败时留在总览视图并保留草稿', async () => {
    renderWorkspace()
    const editor = await enterOverview()
    vi.mocked(saveFile).mockRejectedValueOnce(new Error('disk locked'))

    fireEvent.change(editor, { target: { value: '# 总览\n\n失败仍要保住的内容。' } })
    fireEvent.click(within(nav()).getByRole('button', { name: '工作台' }))

    await waitFor(() => expect(saveFile).toHaveBeenCalled())
    await waitFor(() => expect(within(nav()).getByRole('button', { name: '书籍总览' })).toHaveAttribute('aria-current', 'page'))
    expect(overviewEditor().value).toContain('失败仍要保住的内容')
  })

  it('总览固定在本书导航，资料工具不再持有第二份总览', async () => {
    renderWorkspace()
    const buttons = within(nav()).getAllByRole('button')
    expect(buttons[1]).toHaveTextContent('书籍总览')
    await gotoView('资料工具')
    expect(await screen.findByTestId('library-tools')).toHaveAttribute('data-overview', 'false')
    expect(screen.getAllByRole('button', { name: '书籍总览' })).toHaveLength(1)
  })

  it('资料工具保存失败时不得离开，成功后才打开统一总览', async () => {
    renderWorkspace()
    await gotoView('资料工具')
    await screen.findByTestId('library-tools')
    tools.flush.mockResolvedValueOnce(false)
    await gotoView('书籍总览')
    await waitFor(() => expect(tools.flush).toHaveBeenCalledOnce())
    expect(screen.getByTestId('library-tools')).toBeInTheDocument()
    await gotoView('书籍总览')
    await waitFor(() => expect(screen.queryByTestId('library-tools')).not.toBeInTheDocument())
    expect(screen.getByText(/书籍总览记录整本书的背景/)).toBeInTheDocument()
  })

  it('把最新总览草稿保存注册到外层切书边界，失败返回 false 并保留草稿', async () => {
    let flush: (() => Promise<boolean>) | null = null
    vi.mocked(getLoreItems).mockResolvedValue(realBook())
    const registration = vi.fn((handler: (() => Promise<boolean>) | null) => { flush = handler })
    render(<BookLibraryWorkspace workspace="/books/雾港" bookName="雾港纪事" onFlushHandlerChange={registration} />)
    const editor = await enterOverview()
    fireEvent.change(editor, { target: { value: '切书前需要保存的草稿' } })
    await waitFor(() => expect(flush).toBeTypeOf('function'))
    vi.mocked(saveFile).mockRejectedValueOnce(new Error('disk locked'))
    let saved: boolean | undefined
    await act(async () => { saved = await flush!() })
    expect(saved).toBe(false)
    expect(overviewEditor().value).toBe('切书前需要保存的草稿')
    await act(async () => { saved = await flush!() })
    expect(saved).toBe(true)
    expect(saveFile).toHaveBeenLastCalledWith('setting/book-overview.md', '切书前需要保存的草稿', expect.any(String), '/books/雾港')
  })
})
