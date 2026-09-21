import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarraverseWorkspace } from '@/features/narraverse/NarraverseWorkspace'

const themeMock = vi.hoisted(() => ({ theme: 'dark', resolvedTheme: 'dark' }))
const runtimeMocks = vi.hoisted(() => ({
  hostState: 'ready' as 'checking' | 'ready' | 'unavailable',
  pending: { narraverse: null as null | Record<string, unknown>, module4: null as null | Record<string, unknown> },
  take: vi.fn(),
}))

vi.mock('next-themes', () => ({
  useTheme: () => themeMock,
}))
vi.mock('@/features/world-context-runtime/WorldContextHostProvider', () => ({
  useWorldContextHost: () => ({ state: runtimeMocks.hostState, migration: null }),
}))
vi.mock('@/features/world-context-runtime/IframeWorldContextLaunchProvider', () => ({
  useIframeWorldContextLaunch: () => ({ pending: runtimeMocks.pending, take: runtimeMocks.take, launch: vi.fn(), clear: vi.fn() }),
}))

describe('NarraverseWorkspace', () => {
  beforeEach(() => {
    vi.useRealTimers()
    themeMock.theme = 'dark'
    themeMock.resolvedTheme = 'dark'
    runtimeMocks.hostState = 'ready'
    runtimeMocks.pending = { narraverse: null, module4: null }
    runtimeMocks.take.mockReset()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/call')) return new Response(JSON.stringify({ content: '生成结果', contextSummary: { state: 'active' } }), { status: 200 })
      if (path.endsWith('/bind')) return new Response(JSON.stringify({ contextSummary: { state: 'none' } }), { status: 200 })
      return new Response('', { status: 204 })
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => vi.unstubAllGlobals())

  function renderWorkspace(overrides: { visible?: boolean; onSwitchMode?: (mode: 'ide' | 'interactive') => void } = {}) {
    const onSwitchMode = overrides.onSwitchMode ?? vi.fn()
    const result = render(
      <NarraverseWorkspace visible={overrides.visible ?? true} onSwitchMode={onSwitchMode} />,
    )
    const iframe = result.container.querySelector('iframe') as HTMLIFrameElement
    return { ...result, iframe, onSwitchMode }
  }

  function targetOrigin() {
    const url = new URL(window.location.origin)
    url.hostname = 'localhost'
    return url.origin
  }

  function dispatchFromIframe(iframe: HTMLIFrameElement, data: unknown, origin = targetOrigin(), sourceOverride?: unknown) {
    const event = new MessageEvent('message', {
      data,
      source: (sourceOverride ?? iframe.contentWindow) as Window,
      origin,
    })
    act(() => {
      window.dispatchEvent(event)
    })
  }

  it('embeds Narraverse on the localhost cross-origin boundary with explicit host origin', () => {
    const { iframe } = renderWorkspace()
    expect(iframe).toBeTruthy()
    const url = new URL(iframe.src)
    expect(url.hostname).toBe('localhost')
    expect(url.pathname).toBe('/narraverse/index.html')
    expect(url.searchParams.get('embedded')).toBe('denova')
    expect(url.searchParams.get('host_origin')).toBe(window.location.origin)
    expect(url.searchParams.get('v')).toBe('20260915-host-proxy-v2')
    expect(iframe).not.toHaveAttribute('border')
    expect(iframe.className).toContain('h-full')
  })

  it('shows a loading overlay until the iframe announces ready, then hides it', async () => {
    const { iframe } = renderWorkspace()

    expect(screen.getByText('正在进入叙界…')).toBeInTheDocument()

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'ready' })

    await waitFor(() => expect(screen.queryByText('正在进入叙界…')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('iframe-world-context-state')).toBeInTheDocument())
  })

  it('sends the current theme and locale whenever the iframe loads', () => {
    const { iframe } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    fireEvent.load(iframe)

    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'theme-changed', payload: { theme: 'dark' },
    }, targetOrigin())
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'locale-changed', payload: { locale: 'zh-CN' },
    }, targetOrigin())
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'visibility-changed', payload: { visible: true },
    }, targetOrigin())
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'module4-open', payload: { open: false },
    }, targetOrigin())
  })

  it('opens Module4 through the host protocol and reports iframe close', () => {
    const onModule4Close = vi.fn()
    const { iframe, rerender } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    rerender(<NarraverseWorkspace visible openModule4 onModule4Close={onModule4Close} onSwitchMode={vi.fn()} />)
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'module4-open', payload: { open: true },
    }, targetOrigin())

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'module4-closed' })
    expect(onModule4Close).toHaveBeenCalledTimes(1)
  })

  it('notifies the iframe when narraverse becomes visible again', () => {
    const { iframe, rerender } = renderWorkspace({ visible: false })
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    rerender(<NarraverseWorkspace visible onSwitchMode={vi.fn()} />)

    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'visibility-changed', payload: { visible: true },
    }, targetOrigin())
  })

  it('sends light theme changes using the same host protocol', () => {
    themeMock.theme = 'light'
    themeMock.resolvedTheme = 'light'
    const { iframe } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    fireEvent.load(iframe)

    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'theme-changed', payload: { theme: 'light' },
    }, targetOrigin())
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

    // 信封带未知字段必须忽略
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'switch-mode', payload: { mode: 'ide' }, consumer: 'module4' })
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

  it('binds a pending Narraverse Ref only through the protected host route and consumes it after success', async () => {
    runtimeMocks.pending.narraverse = {
      worldId: 'w1', expectedWorldRevision: 'sha256:r1', selection: { includeTone: true, ruleIndexes: [], characterIds: [], locationIds: [], factionIds: [], timelineEntryIds: [], bindingIds: [] },
    }
    const { iframe } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: { capabilities: ['host-model-proxy-v2'] } })
    await act(async () => {})
    expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/bind', expect.objectContaining({ method: 'POST' }))
    const bindCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/narraverse/bind'))
    const body = JSON.parse(String((bindCall?.[1] as RequestInit).body))
    expect(body.world_context).toEqual(expect.objectContaining({ worldId: 'w1', expectedWorldRevision: 'sha256:r1' }))
    expect(body).not.toHaveProperty('consumer')
    expect(body).not.toHaveProperty('runContextId')
    expect(runtimeMocks.take).toHaveBeenCalledWith('narraverse')
  })

  it('proxies a strict v2 model request and reports active read-only context', async () => {
    const { iframe } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')
    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'abcdefghijklmnop', messages: [{ role: 'user', content: '继续' }], options: { maxTokens: 128 } },
    })
    await act(async () => {})
    expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.objectContaining({ method: 'POST' }))
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'denova', version: 2, type: 'model-call-result', payload: expect.objectContaining({ requestId: 'abcdefghijklmnop', ok: true, content: '生成结果' }),
    }), targetOrigin())
    expect(screen.getByTestId('iframe-world-context-state')).toHaveTextContent('世界背景已连接（只读）')
  })

  it('waits for the pending host bind before forwarding the first iframe model request', async () => {
    const deferredBind: { resolve?: (response: Response) => void } = {}
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/bind')) {
        return new Promise<Response>((resolve) => { deferredBind.resolve = resolve })
      }
      if (path.endsWith('/call')) {
        return new Response(JSON.stringify({ content: '生成结果', contextSummary: { state: 'active' } }), { status: 200 })
      }
      return new Response('', { status: 204 })
    })
    const { iframe } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/bind', expect.any(Object)))

    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'firstrequestwaits', messages: [{ role: 'user', content: '立即生成' }], options: {} },
    })
    await act(async () => { await Promise.resolve() })
    expect(fetch).not.toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.any(Object))

    deferredBind.resolve?.(new Response(JSON.stringify({ contextSummary: { state: 'active' } }), { status: 200 }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.any(Object)))
  })

  it('rejects iframe-supplied control fields before any host model call', () => {
    const { iframe } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')
    vi.mocked(fetch).mockClear()
    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'abcdefghijklmnop', messages: [{ role: 'user', content: '继续' }], options: {}, consumer: 'module4' },
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ ok: false, code: 'consumer_not_trusted' }) }), targetOrigin())
  })

  it('fixes Module4 consumer from host state rather than iframe payload', async () => {
    const view = render(<NarraverseWorkspace visible openModule4 onSwitchMode={vi.fn()} />)
    const frame = view.container.querySelector('iframe') as HTMLIFrameElement
    dispatchFromIframe(frame, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    vi.mocked(fetch).mockClear()
    dispatchFromIframe(frame, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'module4request0001', messages: [{ role: 'user', content: '推进沙盒' }], options: {} },
    })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/module4/call', expect.any(Object)))
    expect(fetch).not.toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.any(Object))
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
