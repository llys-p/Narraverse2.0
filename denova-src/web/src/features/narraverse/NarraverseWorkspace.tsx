import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'

/**
 * 叙界在 Denova 工作区中的持久嵌入容器。
 *
 * - iframe 地址固定为同源 `/narraverse/index.html?embedded=denova&v=20260906-model-gateway-v1`，禁止写死盘符/端口/localhost。
 * - iframe 全高、无边框，占满内容区；切换模式只改变可见性，组件只挂载一次、不销毁。
 * - 仅接收来自当前 iframe 且同源的 postMessage；首期只处理 ready / switch-mode / module4-closed。
 * - 宿主（Denova）向 iframe 发送 theme-changed / locale-changed，单向同步主题与语言。
 *
 * 消息协议 v1：
 *   { source: 'narraverse'|'denova', version: 1, type, payload? }
 */

const NARRAVERSE_IFRAME_SRC = '/narraverse/index.html?embedded=denova&v=20260906-model-gateway-v1'
const READY_TIMEOUT_MS = 6000

type NarraverseInbound = {
  source: 'narraverse'
  version: 1
  type: 'ready' | 'switch-mode' | 'module4-closed'
  payload?: Record<string, unknown>
}

type HostOutboundType = 'theme-changed' | 'locale-changed' | 'visibility-changed' | 'module4-open'

interface NarraverseWorkspaceProps {
  /** 当前是否处于叙界路由（用于决定是否需要展示加载/错误遮罩的最终态）。 */
  visible: boolean
  /** Denova 顶层“开放沙盒”入口是否打开 iframe 内的 Module4。 */
  openModule4?: boolean
  /** Module4 在 iframe 内关闭后返回叙界首页。 */
  onModule4Close?: () => void
  /** 叙界请求切回写作或游戏模式。目标只允许 ide / interactive。 */
  onSwitchMode: (mode: 'ide' | 'interactive') => void
}

type LoadStatus = 'loading' | 'ready' | 'error'

export function NarraverseWorkspace({ visible, openModule4 = false, onModule4Close = () => {}, onSwitchMode }: NarraverseWorkspaceProps) {
  const { t } = useTranslation()
  const { i18n } = useTranslation()
  const { theme, resolvedTheme } = useTheme()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyTimerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [retryNonce, setRetryNonce] = useState(0)

  const postHostMessage = useCallback((type: HostOutboundType, payload: Record<string, unknown>) => {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    try {
      iframe.contentWindow.postMessage({
        source: 'denova',
        version: 1,
        type,
        payload,
      }, window.location.origin)
    } catch (error) {
      console.warn('[NarraverseWorkspace] postMessage 失败', { type, error })
    }
  }, [])

  const effectiveTheme = resolvedTheme || theme
  const locale = i18n.language && i18n.language.startsWith('en') ? 'en-US' : 'zh-CN'
  const syncHostContext = useCallback(() => {
    if (effectiveTheme === 'light' || effectiveTheme === 'dark') {
      postHostMessage('theme-changed', { theme: effectiveTheme })
    }
    postHostMessage('locale-changed', { locale })
    postHostMessage('visibility-changed', { visible })
    postHostMessage('module4-open', { open: openModule4 })
  }, [effectiveTheme, locale, openModule4, postHostMessage, visible])

  // 接收叙界 iframe 的消息（仅同源 + 当前 iframe）。
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      if (event.origin !== window.location.origin) return
      const data = event.data as NarraverseInbound | undefined
      if (!data || data.source !== 'narraverse' || data.version !== 1) return

      if (data.type === 'ready') {
        if (readyTimerRef.current !== null) {
          window.clearTimeout(readyTimerRef.current)
          readyTimerRef.current = null
        }
        setStatus('ready')
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
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onSwitchMode, syncHostContext])

  // 每次重新加载 iframe：重置为加载态，并设置 ready 超时兜底，避免卡在转圈。
  useEffect(() => {
    setStatus('loading')
    if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
    readyTimerRef.current = window.setTimeout(() => {
      readyTimerRef.current = null
      setStatus((current) => (current === 'loading' ? 'error' : current))
    }, READY_TIMEOUT_MS)
    return () => {
      if (readyTimerRef.current !== null) {
        window.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
      }
    }
  }, [retryNonce])

  // 向叙界同步主题变化。
  useEffect(() => {
    if (effectiveTheme !== 'light' && effectiveTheme !== 'dark') return
    postHostMessage('theme-changed', { theme: effectiveTheme })
  }, [effectiveTheme, postHostMessage])

  // 向叙界同步语言变化。
  useEffect(() => {
    postHostMessage('locale-changed', { locale })
  }, [locale, postHostMessage])

  useEffect(() => {
    postHostMessage('visibility-changed', { visible })
  }, [postHostMessage, visible])

  useEffect(() => {
    postHostMessage('module4-open', { open: openModule4 })
  }, [openModule4, postHostMessage])

  const handleIframeError = useCallback(() => {
    setStatus('error')
    if (readyTimerRef.current !== null) {
      window.clearTimeout(readyTimerRef.current)
      readyTimerRef.current = null
    }
  }, [])

  const retry = useCallback(() => {
    setRetryNonce((nonce) => nonce + 1)
  }, [])

  const showLoading = status === 'loading'
  const showError = status === 'error'

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-[var(--nova-bg)]">
      <iframe
        // key 随 retryNonce 变化以强制重新加载
        key={retryNonce}
        ref={iframeRef}
        src={NARRAVERSE_IFRAME_SRC}
        title={t('workbench.narraverse.workspaceLabel')}
        aria-label={t('workbench.narraverse.workspaceLabel')}
        onLoad={syncHostContext}
        onError={handleIframeError}
        className="h-full w-full border-0"
      />
      {showLoading && (
        <div
          aria-hidden={!visible}
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-[var(--nova-text-muted)]"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('workbench.narraverse.loading')}</span>
        </div>
      )}
      {showError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="h-5 w-5 text-[var(--nova-danger-border)]" />
          <div className="text-xs text-[var(--nova-text-muted)]">{t('workbench.narraverse.error')}</div>
          <button
            type="button"
            onClick={retry}
            className="nova-nav-item inline-flex items-center gap-1.5 rounded-[var(--nova-radius)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-3 py-1.5 text-xs text-[var(--nova-text-muted)] hover:text-[var(--nova-text)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('workbench.narraverse.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
