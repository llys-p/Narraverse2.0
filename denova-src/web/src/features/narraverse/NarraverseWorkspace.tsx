import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useWorldContextHost } from '@/features/world-context-runtime/WorldContextHostProvider'
import { useIframeWorldContextLaunch, type IframeWorldConsumer } from '@/features/world-context-runtime/IframeWorldContextLaunchProvider'
import { useIframeLibraryContextLaunch } from '@/features/library-context-runtime/IframeLibraryContextLaunchProvider'

const READY_TIMEOUT_MS = 6000
const MESSAGE_TEXT_LIMIT = 32_000
const MESSAGE_TOTAL_BYTES = 96 * 1024

type NarraverseInbound = {
  source: 'narraverse'
  version: 1 | 2
  type: 'ready' | 'switch-mode' | 'module4-closed' | 'model-call-request'
  payload?: unknown
}

type HostOutboundType = 'theme-changed' | 'locale-changed' | 'visibility-changed' | 'module4-open' | 'model-call-result' | 'world-context-changed'

interface NarraverseWorkspaceProps {
  visible: boolean
  openModule4?: boolean
  onModule4Close?: () => void
  onSwitchMode: (mode: 'ide' | 'interactive') => void
}

type LoadStatus = 'loading' | 'ready' | 'error'
type ContextState = 'none' | 'active' | 'degraded'
type ModelCall = {
  requestId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  options: { maxTokens?: number; temperature?: number }
}

function iframeOrigin(): string {
  const url = new URL(window.location.origin)
  url.hostname = 'localhost'
  return url.origin
}

function iframeSource(): string {
  const url = new URL('/narraverse/index.html', iframeOrigin())
  url.searchParams.set('embedded', 'denova')
  url.searchParams.set('host_origin', window.location.origin)
  url.searchParams.set('v', '20260915-host-proxy-v2')
  return url.toString()
}

function randomFrameInstance(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function parseModelCall(payload: unknown): ModelCall | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const wire = payload as Record<string, unknown>
  if (!exactKeys(wire, ['requestId', 'messages', 'options'])) return null
  if (typeof wire.requestId !== 'string' || wire.requestId.length < 16 || wire.requestId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(wire.requestId)) return null
  if (!Array.isArray(wire.messages) || wire.messages.length < 1 || wire.messages.length > 64) return null
  let totalBytes = 0
  const messages: ModelCall['messages'] = []
  for (const item of wire.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const message = item as Record<string, unknown>
    if (!exactKeys(message, ['role', 'content'])) return null
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') return null
    if (typeof message.content !== 'string' || message.content.length === 0 || Array.from(message.content).length > MESSAGE_TEXT_LIMIT) return null
    totalBytes += new TextEncoder().encode(message.content).byteLength
    messages.push({ role: message.role, content: message.content })
  }
  if (totalBytes > MESSAGE_TOTAL_BYTES) return null
  const optionsWire = wire.options == null ? {} : wire.options
  if (!optionsWire || typeof optionsWire !== 'object' || Array.isArray(optionsWire) || !exactKeys(optionsWire as Record<string, unknown>, ['maxTokens', 'temperature'])) return null
  const options = optionsWire as Record<string, unknown>
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || Number(options.maxTokens) < 1 || Number(options.maxTokens) > 8192)) return null
  if (options.temperature !== undefined && (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) return null
  return { requestId: wire.requestId, messages, options: { maxTokens: options.maxTokens as number | undefined, temperature: options.temperature as number | undefined } }
}

async function readJSON(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text()
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {} } catch { return {} }
}

export function NarraverseWorkspace({ visible, openModule4 = false, onModule4Close = () => {}, onSwitchMode }: NarraverseWorkspaceProps) {
  const { t, i18n } = useTranslation()
  const { theme, resolvedTheme } = useTheme()
  const host = useWorldContextHost()
  const launches = useIframeWorldContextLaunch()
  const libraryLaunches = useIframeLibraryContextLaunch()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyTimerRef = useRef<number | null>(null)
  const frameInstanceRef = useRef(randomFrameInstance())
  const boundRef = useRef<Record<IframeWorldConsumer, boolean>>({ narraverse: false, module4: false })
  const bindInFlightRef = useRef<Record<IframeWorldConsumer, Promise<boolean> | null>>({ narraverse: null, module4: null })
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [retryNonce, setRetryNonce] = useState(0)
  const [ready, setReady] = useState(false)
  const [contextState, setContextState] = useState<ContextState>('none')
  const targetOrigin = useMemo(iframeOrigin, [])
  const src = useMemo(iframeSource, [retryNonce])

  const postHostMessage = useCallback((type: HostOutboundType, payload: Record<string, unknown>, version: 1 | 2 = 1) => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage({ source: 'denova', version, type, payload }, targetOrigin)
  }, [targetOrigin])

  const effectiveTheme = resolvedTheme || theme
  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'zh-CN'
  const syncHostContext = useCallback(() => {
    if (effectiveTheme === 'light' || effectiveTheme === 'dark') postHostMessage('theme-changed', { theme: effectiveTheme })
    postHostMessage('locale-changed', { locale })
    postHostMessage('visibility-changed', { visible })
    postHostMessage('module4-open', { open: openModule4 })
  }, [effectiveTheme, locale, openModule4, postHostMessage, visible])

  const unbindFrame = useCallback((frameInstance: string, consumers: readonly IframeWorldConsumer[]) => {
    for (const consumer of consumers) {
      void fetch(`/api/world-context/host/${consumer}/unbind`, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameInstance }),
      })
    }
  }, [])

  const bindConsumer = useCallback(async (consumer: IframeWorldConsumer, forceBare = false) => {
    if (host.state !== 'ready' || !ready) return false
    const activeBind = bindInFlightRef.current[consumer]
    if (activeBind) {
      await activeBind
      if (!forceBare && !launches.pending[consumer] && !libraryLaunches.pending[consumer] && boundRef.current[consumer]) return true
      return bindConsumer(consumer, forceBare)
    }
    const operation = (async () => {
    // B4a：世界与库背景互斥——后带入者获胜（launchedAt 裁决），败者 pending 在绑定成功后清除。
    const worldLaunch = forceBare ? null : launches.pending[consumer]
    const libraryLaunch = forceBare ? null : libraryLaunches.pending[consumer]
    let launch = worldLaunch
    let library = libraryLaunch
    if (launch && library) {
      if (library.launchedAt >= launch.launchedAt) {
        launch = null
      } else {
        library = null
      }
    }
    if (!launch && !library && boundRef.current[consumer]) return true
    const body: Record<string, unknown> = { frameInstance: frameInstanceRef.current }
    if (launch) {
      body.world_context = { worldId: launch.worldId, expectedWorldRevision: launch.expectedWorldRevision, selection: launch.selection }
    }
    if (library) {
      // 库 Ref 三字段（camelCase，与写作/游戏同一冻结 wire）只提交给同源宿主端；
      // consumer/scopeKey 由服务端派生，iframe 与响应都拿不到 Ref 与运行身份。
      body.library_context = { libraryId: library.libraryId, expectedRevision: library.expectedRevision, manualItemIds: library.manualItemIds }
    }
    try {
      const response = await fetch(`/api/world-context/host/${consumer}/bind`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await readJSON(response)
      if (!response.ok) {
        setContextState('degraded')
        postHostMessage('world-context-changed', { consumer, state: 'degraded', code: String(data.code || 'context_unavailable') }, 2)
        return false
      }
      boundRef.current[consumer] = true
      if (launch) launches.take(consumer)
      if (library) libraryLaunches.take(consumer)
      if (worldLaunch && libraryLaunch) {
        // 互斥裁决的败者 pending 不保留，避免下一次绑定意外复现旧背景。
        if (!launch) launches.clear(consumer)
        if (!library) libraryLaunches.clear(consumer)
      }
      const summary = (data.contextSummary && typeof data.contextSummary === 'object')
        ? data.contextSummary as { state?: unknown } : { state: 'none' }
      const nextState = summary.state === 'active' || summary.state === 'degraded' ? summary.state : 'none'
      setContextState(nextState)
      postHostMessage('world-context-changed', { consumer, ...summary }, 2)
      return true
    } catch {
      setContextState('degraded')
      postHostMessage('world-context-changed', { consumer, state: 'degraded', code: 'host_unavailable' }, 2)
      return false
    }
    })()
    bindInFlightRef.current[consumer] = operation
    try {
      return await operation
    } finally {
      if (bindInFlightRef.current[consumer] === operation) bindInFlightRef.current[consumer] = null
    }
  }, [host.state, launches, libraryLaunches, postHostMessage, ready])

  useEffect(() => {
    if (ready && host.state === 'ready') void bindConsumer('narraverse')
  }, [bindConsumer, host.state, launches.pending.narraverse, libraryLaunches.pending.narraverse, ready])

  useEffect(() => {
    if (ready && host.state === 'ready' && openModule4) void bindConsumer('module4')
  }, [bindConsumer, host.state, launches.pending.module4, libraryLaunches.pending.module4, openModule4, ready])

  useEffect(() => {
    if (openModule4 || !boundRef.current.module4) return
    boundRef.current.module4 = false
    unbindFrame(frameInstanceRef.current, ['module4'])
  }, [openModule4, unbindFrame])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow || event.origin !== targetOrigin) return
      const data = event.data as NarraverseInbound | undefined
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || !exactKeys(data as unknown as Record<string, unknown>, ['source', 'version', 'type', 'payload'])
        || data.source !== 'narraverse' || (data.version !== 1 && data.version !== 2)) return
      if (data.type === 'ready') {
        if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
        setStatus('ready')
        setReady(true)
        syncHostContext()
        return
      }
      if (data.type === 'switch-mode') {
        const mode = (data.payload as { mode?: string } | undefined)?.mode
        if (mode === 'ide' || mode === 'interactive') onSwitchMode(mode)
        return
      }
      if (data.type === 'module4-closed') {
        onModule4Close()
        return
      }
      if (data.version !== 2 || data.type !== 'model-call-request') return
      const request = parseModelCall(data.payload)
      if (!request) {
        const requestId = typeof (data.payload as { requestId?: unknown } | undefined)?.requestId === 'string'
          ? String((data.payload as { requestId: string }).requestId) : ''
        postHostMessage('model-call-result', { requestId, ok: false, code: 'consumer_not_trusted', message: '模型请求格式无效' }, 2)
        return
      }
      if (host.state !== 'ready') {
        setContextState('degraded')
        postHostMessage('model-call-result', { requestId: request.requestId, ok: false, code: 'host_unavailable', message: '宿主代理不可用，本次将使用无世界背景模式' }, 2)
        return
      }
      const consumer: IframeWorldConsumer = openModule4 ? 'module4' : 'narraverse'
      void bindConsumer(consumer).then((bound) => {
        if (!bound) {
          postHostMessage('model-call-result', { requestId: request.requestId, ok: false, code: 'host_unavailable', message: '宿主代理不可用' }, 2)
          return null
        }
        return fetch(`/api/world-context/host/${consumer}/call`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frameInstance: frameInstanceRef.current, messages: request.messages, options: request.options }),
        })
      }).then(async (response) => {
        if (!response) return
        const result = await readJSON(response)
        const summary = result.contextSummary && typeof result.contextSummary === 'object'
          ? result.contextSummary as { state?: unknown } : null
        if (summary) setContextState(summary.state === 'active' || summary.state === 'degraded' ? summary.state : 'none')
        postHostMessage('model-call-result', response.ok
          ? { requestId: request.requestId, ok: true, content: String(result.content || ''), contextSummary: result.contextSummary }
          : { requestId: request.requestId, ok: false, code: String(result.code || 'upstream_error'), message: String(result.error || '共享模型请求失败') }, 2)
      }).catch(() => {
        setContextState('degraded')
        postHostMessage('model-call-result', { requestId: request.requestId, ok: false, code: 'host_unavailable', message: '宿主代理不可用' }, 2)
      })
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [bindConsumer, host.state, onModule4Close, onSwitchMode, openModule4, postHostMessage, syncHostContext, targetOrigin])

  useEffect(() => {
    setStatus('loading')
    setReady(false)
    setContextState('none')
    boundRef.current = { narraverse: false, module4: false }
    if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
    readyTimerRef.current = window.setTimeout(() => {
      readyTimerRef.current = null
      setStatus((current) => current === 'loading' ? 'error' : current)
    }, READY_TIMEOUT_MS)
    return () => { if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current) }
  }, [retryNonce])

  useEffect(() => {
    if (host.state === 'unavailable') setContextState('degraded')
  }, [host.state])

  useEffect(() => { if (effectiveTheme === 'light' || effectiveTheme === 'dark') postHostMessage('theme-changed', { theme: effectiveTheme }) }, [effectiveTheme, postHostMessage])
  useEffect(() => { postHostMessage('locale-changed', { locale }) }, [locale, postHostMessage])
  useEffect(() => { postHostMessage('visibility-changed', { visible }) }, [postHostMessage, visible])
  useEffect(() => { postHostMessage('module4-open', { open: openModule4 }) }, [openModule4, postHostMessage])

  useEffect(() => () => {
    const consumers = (['narraverse', 'module4'] as const).filter((consumer) => boundRef.current[consumer])
    unbindFrame(frameInstanceRef.current, consumers)
  }, [unbindFrame])

  const retry = useCallback(() => {
    const previousFrame = frameInstanceRef.current
    const consumers = (['narraverse', 'module4'] as const).filter((consumer) => boundRef.current[consumer])
    boundRef.current = { narraverse: false, module4: false }
    unbindFrame(previousFrame, consumers)
    frameInstanceRef.current = randomFrameInstance()
    setRetryNonce((nonce) => nonce + 1)
  }, [unbindFrame])

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-[var(--nova-bg)]">
      <iframe key={retryNonce} ref={iframeRef} src={src} title={t('workbench.narraverse.workspaceLabel')}
        aria-label={t('workbench.narraverse.workspaceLabel')} onLoad={syncHostContext} onError={() => setStatus('error')}
        className="h-full w-full border-0" />
      {status === 'ready' ? (
        <div
          data-testid="iframe-world-context-state"
          className="pointer-events-none absolute right-3 top-3 rounded-full border border-[var(--nova-border)] bg-[var(--nova-surface)]/90 px-2.5 py-1 text-[11px] text-[var(--nova-text-muted)] shadow-sm backdrop-blur"
        >
          {t(`workbench.narraverse.context.${contextState}`)}
        </div>
      ) : null}
      {status === 'loading' && (
        <div aria-hidden={!visible} className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-[var(--nova-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /><span>{t('workbench.narraverse.loading')}</span>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="h-5 w-5 text-[var(--nova-danger-border)]" />
          <div className="text-xs text-[var(--nova-text-muted)]">{t('workbench.narraverse.error')}</div>
          <button type="button" onClick={retry} className="nova-nav-item inline-flex items-center gap-1.5 rounded-[var(--nova-radius)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-1.5 text-xs text-[var(--nova-text-muted)] hover:text-[var(--nova-text)]">
            <RefreshCw className="h-3.5 w-3.5" />{t('workbench.narraverse.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
