import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfiguredLocale } from '@/i18n'
import { WorkbenchShell } from './WorkbenchShell'
import { useWorkspaceStore, type ContentMode, type WorkspaceMode } from '@/stores/workspace-store'

const automationActivityApi = vi.hoisted(() => ({
  getAutomationInbox: vi.fn(),
  getActiveAutomationRuns: vi.fn(),
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/features/messages/MessageCenter', () => ({ MessageCenterButton: () => null }))
vi.mock('@/lib/api', () => ({
  getAutomationInbox: automationActivityApi.getAutomationInbox,
  getActiveAutomationRuns: automationActivityApi.getActiveAutomationRuns,
}))

function workbenchProps(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'ide' as WorkspaceMode,
    booksReturnMode: 'ide' as ContentMode,
    currentBookName: '雾港纪事',
    workspace: '/books/雾港纪事',
    books: [{ name: '雾港纪事', path: '/books/雾港纪事', author: '', last_opened_at: '' }],
    appVersion: 'test',
    summary: null,
    isStreaming: false,
    projectVisible: false,
    activityBarExpanded: true,
    rightPanel: null,
    settingsOpen: false,
    interactiveSubmode: 'story' as const,
    sidebar: null,
    main: <div data-testid="main" />,
    rightPanelContent: null,
    onSetMode: vi.fn(),
    onToggleActivityBarExpanded: vi.fn(),
    onSetInteractiveSubmode: vi.fn(),
    onSetRightPanel: vi.fn(),
    onToggleSettings: vi.fn(),
    onCloseSettings: vi.fn(),
    onQuickSwitchBook: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

async function renderShell(overrides: Record<string, unknown> = {}) {
  const props = workbenchProps(overrides)
  await act(async () => {
    render(<WorkbenchShell {...(props as unknown as React.ComponentProps<typeof WorkbenchShell>)} />)
    await Promise.resolve()
  })
  return props
}

describe('本书资料快捷入口', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setConfiguredLocale('zh-CN')
    useWorkspaceStore.setState({ librarySection: null })
    automationActivityApi.getAutomationInbox.mockReset().mockResolvedValue([])
    automationActivityApi.getActiveAutomationRuns.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['ide', 'ide'],
    ['interactive', 'interactive'],
    ['narraverse', 'narraverse'],
  ] as const)('%s 模式只显示一个资料库入口并打开本书分区', async (mode, returnMode) => {
    const props = await renderShell({ mode, booksReturnMode: returnMode })
    const libraryButtons = await screen.findAllByRole('button', { name: '资料库' })
    expect(libraryButtons).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '本书资料' })).not.toBeInTheDocument()
    fireEvent.click(libraryButtons[0])
    expect(props.onSetMode).toHaveBeenCalledWith('library')
    expect(useWorkspaceStore.getState().librarySection).toBe('book')
    expect(props.onSetRightPanel).not.toHaveBeenCalled()
  })

  it('游戏模式打开再返回不改动子模式，游戏上下文保持原位', async () => {
    const gameProps = await renderShell({ mode: 'interactive', booksReturnMode: 'interactive' })
    fireEvent.click(await screen.findByRole('button', { name: '资料库' }))
    expect(gameProps.onSetMode).toHaveBeenCalledWith('library')
    expect(gameProps.onSetInteractiveSubmode).not.toHaveBeenCalled()
    expect(gameProps.onSetRightPanel).not.toHaveBeenCalled()
  })

  it('已经在资料库时再次点击返回进入前的内容模式', async () => {
    const props = await renderShell({ mode: 'library', booksReturnMode: 'interactive' })
    fireEvent.click(await screen.findByRole('button', { name: '资料库' }))
    await waitFor(() => expect(props.onSetMode).toHaveBeenCalledWith('interactive'))
  })

  it('没有当前工作区时进入资料库个人分区', async () => {
    const props = await renderShell({ mode: 'ide', booksReturnMode: 'ide', workspace: null })
    fireEvent.click(await screen.findByRole('button', { name: '资料库' }))
    expect(props.onSetMode).toHaveBeenCalledWith('library')
    expect(useWorkspaceStore.getState().librarySection).toBe('mine')
  })

  it('工作区异步加载后点击入口进入本书分区', async () => {
    const props = workbenchProps({ mode: 'ide', booksReturnMode: 'ide', workspace: '' })
    let rerender!: (ui: React.ReactNode) => void
    await act(async () => {
      rerender = render(<WorkbenchShell {...(props as unknown as React.ComponentProps<typeof WorkbenchShell>)} />).rerender
      await Promise.resolve()
    })
    await act(async () => {
      rerender(<WorkbenchShell {...(props as unknown as React.ComponentProps<typeof WorkbenchShell>)} workspace="/books/雾港纪事" />)
      await Promise.resolve()
    })

    fireEvent.click(await screen.findByRole('button', { name: '资料库' }))
    expect(useWorkspaceStore.getState().librarySection).toBe('book')
  })

  it('把旧活动栏排序中的 lore 和 book-library 合并到 library 并保留靠前位置', async () => {
    window.localStorage.setItem('nova.activity.order.ide.v2', JSON.stringify(['writing', 'lore', 'book-library', 'teller', 'library']))
    await renderShell({ mode: 'ide', booksReturnMode: 'ide' })
    const activityIds = [...document.querySelectorAll<HTMLButtonElement>('.nova-activity-bar button[data-activity-id]')]
      .map((button) => button.dataset.activityId)
    expect(activityIds.filter((id) => id === 'library')).toHaveLength(1)
    expect(activityIds.indexOf('library')).toBe(activityIds.indexOf('writing') + 1)
  })
})
