import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeEntries } from '../components/ModeEntries'
import type { World } from '../types'

const mocks = vi.hoisted(() => ({
  selectInteractiveStory: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/features/interactive/api', () => ({ selectInteractiveStory: mocks.selectInteractiveStory }))

function worldFixture(): World {
  return {
    id: 'w1', schemaVersion: 1, name: 'W', status: 'active',
    bindings: [], characters: [], locations: [], factions: [], timeline: [],
    primaryBookPath: '/book.md', primaryInteractiveStoryId: 'story-1',
    createdAt: '', updatedAt: '',
  }
}

function setup(confirmLeave: () => boolean) {
  const onSetMode = vi.fn()
  const onQuickSwitchBook = vi.fn(async () => true)
  const onOpenModule4 = vi.fn()
  const onCloseModule4 = vi.fn()
  render(
    <ModeEntries
      world={worldFixture()}
      confirmLeave={confirmLeave}
      onSetMode={onSetMode}
      onQuickSwitchBook={onQuickSwitchBook}
      onOpenModule4={onOpenModule4}
      onCloseModule4={onCloseModule4}
    />,
  )
  return { onSetMode, onQuickSwitchBook, onOpenModule4, onCloseModule4 }
}

beforeEach(() => vi.clearAllMocks())

describe('ModeEntries 统一单次 preflight（M1）', () => {
  it('confirmLeave=false：游戏不发 selectInteractiveStory、不切模式，且只确认一次', async () => {
    const user = userEvent.setup()
    const confirmLeave = vi.fn(() => false)
    const { onSetMode } = setup(confirmLeave)
    await user.click(screen.getByRole('button', { name: /游戏模式/ }))
    expect(confirmLeave).toHaveBeenCalledTimes(1)
    expect(mocks.selectInteractiveStory).not.toHaveBeenCalled()
    expect(onSetMode).not.toHaveBeenCalled()
  })

  it('confirmLeave=false：写作不切书、不切模式', async () => {
    const user = userEvent.setup()
    const { onQuickSwitchBook, onSetMode } = setup(() => false)
    await user.click(screen.getByRole('button', { name: /写作模式/ }))
    expect(onQuickSwitchBook).not.toHaveBeenCalled()
    expect(onSetMode).not.toHaveBeenCalled()
  })

  it('confirmLeave=false：叙界不关 Module4、不切模式', async () => {
    const user = userEvent.setup()
    const { onCloseModule4, onSetMode } = setup(() => false)
    await user.click(screen.getByRole('button', { name: /叙界/ }))
    expect(onCloseModule4).not.toHaveBeenCalled()
    expect(onSetMode).not.toHaveBeenCalled()
  })

  it('confirmLeave=true：写作切书成功后才进入 ide，且只确认一次', async () => {
    const user = userEvent.setup()
    const confirmLeave = vi.fn(() => true)
    const { onQuickSwitchBook, onSetMode } = setup(confirmLeave)
    await user.click(screen.getByRole('button', { name: /写作模式/ }))
    expect(confirmLeave).toHaveBeenCalledTimes(1)
    expect(onQuickSwitchBook).toHaveBeenCalledWith('/book.md')
    await vi.waitFor(() => expect(onSetMode).toHaveBeenCalledWith('ide'))
  })

  it('写作切书返回 false（真失败）：不切模式、提示失败、按钮恢复可点（pending 复位）', async () => {
    const user = userEvent.setup()
    const onQuickSwitchBook = vi.fn(async () => false)
    render(<ModeEntries world={worldFixture()} confirmLeave={() => true} onSetMode={vi.fn()}
      onQuickSwitchBook={onQuickSwitchBook} />)
    const btn = screen.getByRole('button', { name: /写作模式/ })
    await user.click(btn)
    expect(onQuickSwitchBook).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenCalled())
    await vi.waitFor(() => expect(btn).not.toBeDisabled())
  })

  it('游戏：selectInteractiveStory（服务端副作用）在 confirmLeave 通过后、onSetMode 之前发生', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    mocks.selectInteractiveStory.mockImplementation(async () => { order.push('select') })
    const onSetMode = vi.fn(() => order.push('setMode'))
    render(<ModeEntries world={worldFixture()} confirmLeave={() => true} onSetMode={onSetMode}
      onQuickSwitchBook={vi.fn(async () => true)} />)
    await user.click(screen.getByRole('button', { name: /游戏模式/ }))
    await vi.waitFor(() => expect(onSetMode).toHaveBeenCalledWith('interactive'))
    expect(order).toEqual(['select', 'setMode'])
  })

  it('游戏成功进入后 pending 复位（保活返回时卡片不卡死）', async () => {
    const user = userEvent.setup()
    mocks.selectInteractiveStory.mockResolvedValue(undefined)
    render(<ModeEntries world={worldFixture()} confirmLeave={() => true} onSetMode={vi.fn()}
      onQuickSwitchBook={vi.fn(async () => true)} />)
    const btn = screen.getByRole('button', { name: /游戏模式/ })
    await user.click(btn)
    await vi.waitFor(() => expect(btn).not.toBeDisabled())
  })

  it('叙界：confirmLeave 通过后只确认一次，先关 Module4 再切 narraverse', async () => {
    const user = userEvent.setup()
    const confirmLeave = vi.fn(() => true)
    const order: string[] = []
    const onCloseModule4 = vi.fn(() => order.push('close'))
    const onSetMode = vi.fn(() => order.push('setMode'))
    render(<ModeEntries world={worldFixture()} confirmLeave={confirmLeave} onSetMode={onSetMode}
      onQuickSwitchBook={vi.fn(async () => true)} onCloseModule4={onCloseModule4} />)
    await user.click(screen.getByRole('button', { name: /叙界/ }))
    expect(confirmLeave).toHaveBeenCalledTimes(1)
    expect(onCloseModule4).toHaveBeenCalledTimes(1)
    expect(onSetMode).toHaveBeenCalledWith('narraverse')
    expect(order).toEqual(['close', 'setMode'])
  })

  it('沙盒：confirmLeave 通过后打开 Module4', async () => {
    const user = userEvent.setup()
    const { onOpenModule4 } = setup(() => true)
    await user.click(screen.getByRole('button', { name: /开放沙盒/ }))
    expect(onOpenModule4).toHaveBeenCalledTimes(1)
  })
})
