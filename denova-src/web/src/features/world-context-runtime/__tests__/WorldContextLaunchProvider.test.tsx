import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorldContextLaunchProvider,
  useWorldContextLaunch,
  type WritingWorldContextLaunch,
} from '../WorldContextLaunchProvider'
import { emptyContextSelection } from '@/features/world-workspace/world-context'

function launchFixture(overrides: Partial<WritingWorldContextLaunch> = {}): WritingWorldContextLaunch {
  return {
    worldId: 'w1',
    expectedWorldRevision: 'sha256:r1',
    selection: { ...emptyContextSelection(), includeTone: true, characterIds: ['c1'] },
    worldName: '测试世界',
    selectedCount: 2,
    launchedAt: 1000,
    ...overrides,
  }
}

function Harness() {
  const launch = useWorldContextLaunch()
  return (
    <div>
      <span data-testid="pending">{launch.pendingWriting ? launch.pendingWriting.worldName : 'none'}</span>
      <button type="button" onClick={() => launch.launchWriting(launchFixture())}>launch</button>
      <button type="button" onClick={() => {
        const taken = launch.takeWritingLaunch()
        ;(window as unknown as { __taken: string | null }).__taken = taken ? taken.worldId : null
      }}>take</button>
      <button type="button" onClick={() => launch.clearWritingLaunch()}>clear</button>
    </div>
  )
}

function renderHarness() {
  return render(
    <WorldContextLaunchProvider>
      <Harness />
    </WorldContextLaunchProvider>,
  )
}

describe('WorldContextLaunchProvider', () => {
  beforeEach(() => {
    ;(window as unknown as { __taken: string | null }).__taken = null
  })
  afterEach(() => cleanup())

  it('初始挂载没有待交接 Ref（刷新即空）', () => {
    renderHarness()
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('launchWriting 写入后响应式可见', () => {
    renderHarness()
    fireEvent.click(screen.getByText('launch'))
    expect(screen.getByTestId('pending').textContent).toBe('测试世界')
  })

  it('takeWritingLaunch 一次性取走并清空', () => {
    renderHarness()
    fireEvent.click(screen.getByText('launch'))
    fireEvent.click(screen.getByText('take'))
    expect((window as unknown as { __taken: string | null }).__taken).toBe('w1')
    expect(screen.getByTestId('pending').textContent).toBe('none')
    // 再次 take 返回 null
    fireEvent.click(screen.getByText('take'))
    expect((window as unknown as { __taken: string | null }).__taken).toBeNull()
  })

  it('clearWritingLaunch 清空待交接', () => {
    renderHarness()
    fireEvent.click(screen.getByText('launch'))
    fireEvent.click(screen.getByText('clear'))
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('卸载后重新挂载（模拟刷新）不保留任何 Ref', () => {
    const view = renderHarness()
    fireEvent.click(screen.getByText('launch'))
    expect(screen.getByTestId('pending').textContent).toBe('测试世界')
    view.unmount()
    renderHarness()
    expect(screen.getByTestId('pending').textContent).toBe('none')
  })

  it('全程不写 localStorage / sessionStorage / indexedDB', () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem')
    renderHarness()
    fireEvent.click(screen.getByText('launch'))
    fireEvent.click(screen.getByText('take'))
    expect(localSet).not.toHaveBeenCalled()
    expect(sessionSet).not.toHaveBeenCalled()
    localSet.mockRestore()
    sessionSet.mockRestore()
  })

  it('在 Provider 外使用 hook 抛错', () => {
    // 抑制 React 错误边界噪音
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Harness />)).toThrow(/WorldContextLaunchProvider/)
    spy.mockRestore()
  })
})
