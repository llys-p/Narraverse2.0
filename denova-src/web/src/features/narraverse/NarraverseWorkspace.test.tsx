import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarraverseWorkspace } from '@/features/narraverse/NarraverseWorkspace'

const themeMock = vi.hoisted(() => ({ theme: 'dark', resolvedTheme: 'dark' }))

vi.mock('next-themes', () => ({
  useTheme: () => themeMock,
}))

describe('NarraverseWorkspace', () => {
  beforeEach(() => {
    vi.useRealTimers()
    themeMock.theme = 'dark'
    themeMock.resolvedTheme = 'dark'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function renderWorkspace(overrides: { visible?: boolean; onSwitchMode?: (mode: 'ide' | 'interactive') => void } = {}) {
    const onSwitchMode = overrides.onSwitchMode ?? vi.fn()
    const result = render(
      <NarraverseWorkspace visible={overrides.visible ?? true} onSwitchMode={onSwitchMode} />,
    )
    const iframe = result.container.querySelector('iframe') as HTMLIFrameElement
    return { ...result, iframe, onSwitchMode }
  }

  function dispatchFromIframe(iframe: HTMLIFrameElement, data: unknown, origin = window.location.origin, sourceOverride?: unknown) {
    const event = new MessageEvent('message', {
      data,
      source: (sourceOverride ?? iframe.contentWindow) as Window,
      origin,
    })
    act(() => {
      window.dispatchEvent(event)
    })
  }

  it('embeds the same-origin narraverse route and never hardcodes host/port/localhost', () => {
    const { iframe } = renderWorkspace()
    expect(iframe).toBeTruthy()
    expect(iframe.getAttribute('src')).toBe('/narraverse/index.html?embedded=denova&v=20260906-model-gateway-v1')
    // 不写死盘符/端口/localhost
    expect(iframe.getAttribute('src')).not.toMatch(/localhost|127\.0\.0\.1|:[0-9]{4}/)
    expect(iframe).not.toHaveAttribute('border')
    expect(iframe.className).toContain('h-full')
  })

  it('shows a loading overlay until the iframe announces ready, then hides it', () => {
    const { iframe } = renderWorkspace()

    expect(screen.getByText('正在进入叙界…')).toBeInTheDocument()

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'ready' })

    expect(screen.queryByText('正在进入叙界…')).not.toBeInTheDocument()
  })

  it('sends the current theme and locale whenever the iframe loads', () => {
    const { iframe } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    fireEvent.load(iframe)

    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'theme-changed', payload: { theme: 'dark' },
    }, window.location.origin)
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'locale-changed', payload: { locale: 'zh-CN' },
    }, window.location.origin)
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'visibility-changed', payload: { visible: true },
    }, window.location.origin)
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'module4-open', payload: { open: false },
    }, window.location.origin)
  })

  it('opens Module4 through the host protocol and reports iframe close', () => {
    const onModule4Close = vi.fn()
    const { iframe, rerender } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    rerender(<NarraverseWorkspace visible openModule4 onModule4Close={onModule4Close} onSwitchMode={vi.fn()} />)
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'module4-open', payload: { open: true },
    }, window.location.origin)

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'module4-closed' })
    expect(onModule4Close).toHaveBeenCalledTimes(1)
  })

  it('notifies the iframe when narraverse becomes visible again', () => {
    const { iframe, rerender } = renderWorkspace({ visible: false })
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    rerender(<NarraverseWorkspace visible onSwitchMode={vi.fn()} />)

    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'visibility-changed', payload: { visible: true },
    }, window.location.origin)
  })

  it('sends light theme changes using the same host protocol', () => {
    themeMock.theme = 'light'
    themeMock.resolvedTheme = 'light'
    const { iframe } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    fireEvent.load(iframe)

    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'theme-changed', payload: { theme: 'light' },
    }, window.location.origin)
  })

  it('forwards switch-mode requests only for ide/interactive', () => {
    const onSwitchMode = vi.fn()
    const { iframe } = renderWorkspace({ onSwitchMode })

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'switch-mode', payload: { mode: 'ide' } })
    expect(onSwitchMode).toHaveBeenCalledWith('ide')

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'switch-mode', payload: { mode: 'interactive' } })
    expect(onSwitchMode).toHaveBeenCalledWith('interactive')

    // 不允许切到叙界自身或非法目标
    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'switch-mode', payload: { mode: 'narraverse' } })
    expect(onSwitchMode).not.toHaveBeenCalledWith('narraverse')

    expect(onSwitchMode).toHaveBeenCalledTimes(2)
  })

  it('ignores messages from a different source window, cross-origin, or malformed envelope', () => {
    const onSwitchMode = vi.fn()
    const { iframe } = renderWorkspace({ onSwitchMode })

    // 非当前 iframe 的 source window
    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'switch-mode', payload: { mode: 'ide' } }, window.location.origin, {})
    expect(onSwitchMode).not.toHaveBeenCalled()

    // 跨源
    dispatchFromIfaceCrossOrigin(iframe)
    expect(onSwitchMode).not.toHaveBeenCalled()

    // 错误信封（来源不是 narraverse）
    dispatchFromIframe(iframe, { source: 'denova', version: 1, type: 'switch-mode', payload: { mode: 'ide' } })
    expect(onSwitchMode).not.toHaveBeenCalled()

    // 版本不符
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'switch-mode', payload: { mode: 'ide' } })
    expect(onSwitchMode).not.toHaveBeenCalled()
  })

  it('exposes a retry control after a load failure and reloads the iframe on retry', () => {
    vi.useFakeTimers()
    const { iframe, container } = renderWorkspace()
    act(() => {
      vi.advanceTimersByTime(6000)
    })

    expect(screen.getByText('叙界加载失败')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    const reloadedIframe = container.querySelector('iframe') as HTMLIFrameElement
    expect(reloadedIframe).not.toBe(iframe)
    expect(screen.getByText('正在进入叙界…')).toBeInTheDocument()
  })

  function dispatchFromIfaceCrossOrigin(iframe: HTMLIFrameElement) {
    const event = new MessageEvent('message', {
      data: { source: 'narraverse', version: 1, type: 'switch-mode', payload: { mode: 'ide' } },
      source: iframe.contentWindow as Window,
      origin: 'http://evil.example',
    })
    act(() => {
      window.dispatchEvent(event)
    })
  }
})
