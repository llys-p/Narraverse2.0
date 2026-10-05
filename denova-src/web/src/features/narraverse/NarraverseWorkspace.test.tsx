import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarraverseWorkspace } from '@/features/narraverse/NarraverseWorkspace'

const themeMock = vi.hoisted(() => ({ theme: 'dark', resolvedTheme: 'dark' }))
const runtimeMocks = vi.hoisted(() => ({
  hostState: 'ready' as 'checking' | 'ready' | 'unavailable',
  pending: { narraverse: null as null | Record<string, unknown>, module4: null as null | Record<string, unknown> },
  take: vi.fn(),
  libraryPending: { narraverse: null as null | Record<string, unknown>, module4: null as null | Record<string, unknown> },
  libraryTake: vi.fn(),
  libraryClear: vi.fn(),
  worldClear: vi.fn(),
}))

vi.mock('next-themes', () => ({
  useTheme: () => themeMock,
}))
vi.mock('@/features/world-context-runtime/WorldContextHostProvider', () => ({
  useWorldContextHost: () => ({ state: runtimeMocks.hostState, migration: null }),
}))
vi.mock('@/features/world-context-runtime/IframeWorldContextLaunchProvider', () => ({
  useIframeWorldContextLaunch: () => ({ pending: runtimeMocks.pending, take: runtimeMocks.take, launch: vi.fn(), clear: runtimeMocks.worldClear }),
}))
vi.mock('@/features/library-context-runtime/IframeLibraryContextLaunchProvider', () => ({
  useIframeLibraryContextLaunch: () => ({
    pending: runtimeMocks.libraryPending,
    take: (consumer: 'narraverse' | 'module4') => {
      runtimeMocks.libraryTake(consumer)
      const current = runtimeMocks.libraryPending[consumer]
      // 原地清除：组件闭包持有的是同一个 pending 对象引用。
      runtimeMocks.libraryPending[consumer] = null
      return current
    },
    launch: vi.fn(),
    clear: runtimeMocks.libraryClear,
  }),
}))

describe('NarraverseWorkspace', () => {
  beforeEach(() => {
    vi.useRealTimers()
    themeMock.theme = 'dark'
    themeMock.resolvedTheme = 'dark'
    runtimeMocks.hostState = 'ready'
    runtimeMocks.pending = { narraverse: null, module4: null }
    runtimeMocks.take.mockReset()
    runtimeMocks.libraryPending = { narraverse: null, module4: null }
    runtimeMocks.libraryTake.mockReset()
    runtimeMocks.libraryClear.mockReset()
    runtimeMocks.worldClear.mockReset()
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

  function renderWorkspace(overrides: {
    visible?: boolean
    onSwitchMode?: (mode: 'ide' | 'interactive') => void
    onOpenModelSettings?: () => void
  } = {}) {
    const onSwitchMode = overrides.onSwitchMode ?? vi.fn()
    const onOpenModelSettings = overrides.onOpenModelSettings ?? vi.fn()
    const result = render(
      <NarraverseWorkspace
        visible={overrides.visible ?? true}
        onSwitchMode={onSwitchMode}
        onOpenModelSettings={onOpenModelSettings}
      />,
    )
    const iframe = result.container.querySelector('iframe') as HTMLIFrameElement
    return { ...result, iframe, onSwitchMode, onOpenModelSettings }
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
    expect(url.searchParams.get('v')).toBe('20261004-platform-model-v3')
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

    rerender(<NarraverseWorkspace visible openModule4 onModule4Close={onModule4Close} onSwitchMode={vi.fn()} onOpenModelSettings={vi.fn()} />)
    expect(postMessage).toHaveBeenCalledWith({
      source: 'denova', version: 1, type: 'module4-open', payload: { open: true },
    }, targetOrigin())

    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'module4-closed' })
    expect(onModule4Close).toHaveBeenCalledTimes(1)
  })

  it('notifies the iframe when narraverse becomes visible again', () => {
    const { iframe, rerender } = renderWorkspace({ visible: false })
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    rerender(<NarraverseWorkspace visible onSwitchMode={vi.fn()} onOpenModelSettings={vi.fn()} />)

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

  it('reports a bilingual generation failure and sends no model call when the host is unavailable', () => {
    runtimeMocks.hostState = 'unavailable'
    const { iframe } = renderWorkspace()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')
    vi.mocked(fetch).mockClear()

    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'hostnotready00001', messages: [{ role: 'user', content: '继续' }], options: {} } })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'model-call-result',
      payload: expect.objectContaining({
        requestId: 'hostnotready00001', ok: false, code: 'host_unavailable',
        message: expect.stringMatching(/未生成.*平台连接.*nothing was generated.*platform connection/i),
      }),
    }), targetOrigin())
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/call'), expect.anything())
  })

  it('opens the platform model settings only for a bare v2 command from the trusted frame', () => {
    const onOpenModelSettings = vi.fn()
    const { iframe } = renderWorkspace({ onOpenModelSettings })

    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'open-model-settings', payload: {} })
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1)

    // v1 信封不承载这条命令
    dispatchFromIframe(iframe, { source: 'narraverse', version: 1, type: 'open-model-settings', payload: {} })
    // 携带任何参数都必须丢弃：跳转目标只能由宿主固定，不能由 iframe 指定
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'open-model-settings', payload: { url: 'https://example.invalid' } })
    // 跨源与错误信封同样忽略
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'open-model-settings', payload: {} }, 'http://127.0.0.1:9999')
    dispatchFromIframe(iframe, { source: 'denova', version: 2, type: 'open-model-settings', payload: {} })
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('example.invalid'), expect.anything())
  })

  it('keeps a late answer tied to its own request when the sandbox opens mid-flight', async () => {
    let resolveNarraverseCall: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/narraverse/call')) {
        return new Promise<Response>((resolve) => { resolveNarraverseCall = resolve })
      }
      if (path.endsWith('/module4/call')) {
        return new Response(JSON.stringify({ content: '沙盒结果', contextSummary: { state: 'none' } }), { status: 200 })
      }
      if (path.endsWith('/bind')) return new Response(JSON.stringify({ contextSummary: { state: 'none' } }), { status: 200 })
      return new Response('', { status: 204 })
    }))

    const { iframe, rerender } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    await act(async () => {})
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')

    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'aaaaaaaaaaaaaaaa', messages: [{ role: 'user', content: '叙界请求' }], options: {} },
    })
    await act(async () => {})
    expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.objectContaining({ method: 'POST' }))

    // 叙界请求仍在途时打开放开沙盒，第二条请求必须走沙盒自己的 consumer
    rerender(<NarraverseWorkspace visible openModule4 onSwitchMode={vi.fn()} onOpenModelSettings={vi.fn()} />)
    await act(async () => {})
    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'bbbbbbbbbbbbbbbb', messages: [{ role: 'user', content: '沙盒请求' }], options: {} },
    })
    await act(async () => {})
    expect(fetch).toHaveBeenCalledWith('/api/world-context/host/module4/call', expect.objectContaining({ method: 'POST' }))
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'model-call-result', payload: expect.objectContaining({ requestId: 'bbbbbbbbbbbbbbbb', ok: true, content: '沙盒结果' }),
    }), targetOrigin())

    // 迟到的叙界响应只回到叙界自己的 requestId，不会被并入沙盒那一轮
    await act(async () => { resolveNarraverseCall?.(new Response(JSON.stringify({ content: '叙界结果', contextSummary: { state: 'none' } }), { status: 200 })) })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'model-call-result', payload: expect.objectContaining({ requestId: 'aaaaaaaaaaaaaaaa', ok: true, content: '叙界结果' }),
    }), targetOrigin())
    const results = postMessage.mock.calls
      .map((call) => call[0] as { payload?: { requestId?: string } })
      .filter((message) => message.payload && message.payload.requestId)
    expect(results.map((message) => message.payload?.requestId)).toEqual(['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'])
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
    const view = render(<NarraverseWorkspace visible openModule4 onSwitchMode={vi.fn()} onOpenModelSettings={vi.fn()} />)
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

  it('binds the library carrier and waits for it before the first call without sending the ref downstream', async () => {
    runtimeMocks.libraryPending = {
      narraverse: { libraryId: 'lib-9', expectedRevision: 'sha256:r9', manualItemIds: ['m1'], libraryName: '叙界库', revisionLabel: 'sha256:r9', selectedCount: 1, launchedAt: 100 },
      module4: null,
    }
    const deferredBind: { resolve?: (response: Response) => void } = {}
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/bind')) return new Promise<Response>((resolve) => { deferredBind.resolve = resolve })
      if (path.endsWith('/narraverse/call')) return new Response(JSON.stringify({ content: '生成结果', contextSummary: { state: 'active' } }), { status: 200 })
      return new Response('', { status: 204 })
    })
    const { iframe } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/bind', expect.any(Object)))
    const bindBody = JSON.parse(String((vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/narraverse/bind'))?.[1] as RequestInit).body))
    expect(bindBody.library_context).toEqual({ libraryId: 'lib-9', expectedRevision: 'sha256:r9', manualItemIds: ['m1'] })
    expect(bindBody).not.toHaveProperty('world_context')
    expect(JSON.stringify(bindBody)).not.toContain('scopeKey')

    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'libraryfirstcall1', messages: [{ role: 'user', content: '继续' }], options: {} },
    })
    await act(async () => { await Promise.resolve() })
    expect(fetch).not.toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.any(Object))

    deferredBind.resolve?.(new Response(JSON.stringify({ contextSummary: { state: 'active', libraryName: '叙界库', revisionLabel: 'sha256:r9', selectedCount: 1 } }), { status: 200 }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/call', expect.any(Object)))
    const callBody = JSON.parse(String((vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/narraverse/call'))?.[1] as RequestInit).body))
    // 库 Ref 只交给宿主 bind；模型代理请求里绝不出现库引用或运行身份。
    expect(JSON.stringify(callBody)).not.toContain('lib-9')
    expect(JSON.stringify(callBody)).not.toContain('scopeKey')
    expect(runtimeMocks.libraryTake).toHaveBeenCalledWith('narraverse')
  })

  it('prefers the library carrier when the library launch is the later one', async () => {
    runtimeMocks.pending = {
      narraverse: { worldId: 'w1', expectedWorldRevision: 'sha256:r1', selection: {}, worldName: '世界', selectedCount: 1, launchedAt: 100 },
      module4: null,
    }
    runtimeMocks.libraryPending = {
      narraverse: { libraryId: 'lib-9', expectedRevision: 'sha256:r9', manualItemIds: [], libraryName: '叙界库', revisionLabel: 'sha256:r9', selectedCount: 0, launchedAt: 200 },
      module4: null,
    }
    const { iframe } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/bind', expect.any(Object)))
    const bindBody = JSON.parse(String((vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/narraverse/bind'))?.[1] as RequestInit).body))
    expect(bindBody.library_context).toEqual({ libraryId: 'lib-9', expectedRevision: 'sha256:r9', manualItemIds: [] })
    expect(bindBody).not.toHaveProperty('world_context')
    // 败者 pending 被清除，避免下一次绑定意外复现旧背景。
    await waitFor(() => expect(runtimeMocks.worldClear).toHaveBeenCalledWith('narraverse'))
  })

  it('keeps the world carrier when the world launch is the later one', async () => {
    runtimeMocks.pending = {
      narraverse: { worldId: 'w1', expectedWorldRevision: 'sha256:r1', selection: {}, worldName: '世界', selectedCount: 1, launchedAt: 300 },
      module4: null,
    }
    runtimeMocks.libraryPending = {
      narraverse: { libraryId: 'lib-9', expectedRevision: 'sha256:r9', manualItemIds: [], libraryName: '叙界库', revisionLabel: 'sha256:r9', selectedCount: 0, launchedAt: 200 },
      module4: null,
    }
    const { iframe } = renderWorkspace()
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/narraverse/bind', expect.any(Object)))
    const bindBody = JSON.parse(String((vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/narraverse/bind'))?.[1] as RequestInit).body))
    expect(bindBody.world_context).toEqual(expect.objectContaining({ worldId: 'w1' }))
    expect(bindBody).not.toHaveProperty('library_context')
    await waitFor(() => expect(runtimeMocks.libraryClear).toHaveBeenCalledWith('narraverse'))
  })

  it('binds the module4 consumer with the library carrier when the sandbox opens with a pending sandbox library', async () => {
    runtimeMocks.libraryPending = {
      narraverse: null,
      module4: { libraryId: 'lib-4', expectedRevision: 'sha256:r4', manualItemIds: ['m4'], libraryName: '沙盒库', revisionLabel: 'sha256:r4', selectedCount: 1, launchedAt: 150 },
    }
    const view = render(<NarraverseWorkspace visible openModule4 onSwitchMode={vi.fn()} onOpenModelSettings={vi.fn()} />)
    const iframe = view.container.querySelector('iframe') as HTMLIFrameElement
    dispatchFromIframe(iframe, { source: 'narraverse', version: 2, type: 'ready', payload: {} })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/module4/bind', expect.any(Object)))
    const bindCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/module4/bind'))
    const bindBody = JSON.parse(String((bindCall?.[1] as RequestInit).body))
    expect(bindBody.library_context).toEqual({ libraryId: 'lib-4', expectedRevision: 'sha256:r4', manualItemIds: ['m4'] })
    expect(bindBody).not.toHaveProperty('world_context')
    expect(runtimeMocks.libraryTake).toHaveBeenCalledWith('module4')
    // 沙盒模型调用走 module4 路由，库 Ref 不进入代理请求。
    dispatchFromIframe(iframe, {
      source: 'narraverse', version: 2, type: 'model-call-request',
      payload: { requestId: 'module4library0001', messages: [{ role: 'user', content: '推进沙盒' }], options: {} },
    })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/world-context/host/module4/call', expect.any(Object)))
    const callBody = JSON.parse(String((vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/module4/call'))?.[1] as RequestInit).body))
    expect(JSON.stringify(callBody)).not.toContain('lib-4')
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
