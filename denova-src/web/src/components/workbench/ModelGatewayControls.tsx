import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Wifi } from 'lucide-react'
import { APIError } from '@/lib/api-client/client'
import { fetchModelStatus, testModel, type ModelGatewayStatus, type ModelGatewayTestResult, type ModelModule } from '@/lib/api-client/model-gateway'

const MODULE_LABELS: Record<ModelModule, string> = {
  writing: '写作模式',
  game: '游戏模式',
  narraverse: '叙界',
  module4: '开放沙盒',
}

interface ModelGatewayControlsProps {
  module: ModelModule
  compact?: boolean
}

/** One safe, module-scoped control shared by all four entry points. */
export function ModelGatewayControls({ module, compact = false }: ModelGatewayControlsProps) {
  const [status, setStatus] = useState<ModelGatewayStatus | null>(null)
  const [testResult, setTestResult] = useState<ModelGatewayTestResult | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'test' | null>(null)
  const [message, setMessage] = useState('尚未检查')

  useEffect(() => {
    setStatus(null)
    setTestResult(null)
    setMessage('尚未检查')
  }, [module])

  const refresh = async () => {
    setBusy('refresh')
    try {
      const nextStatus = await fetchModelStatus(module)
      setStatus(nextStatus)
      setTestResult(null)
      setMessage(nextStatus.configured ? '共享模型已配置' : '共享模型未配置')
    } catch (error) {
      setMessage(safeErrorMessage(error, '状态刷新失败'))
    } finally {
      setBusy(null)
    }
  }

  const runTest = async () => {
    setBusy('test')
    try {
      const result = await testModel(module)
      setTestResult(result)
      setMessage(result.ok ? `API 正常 · ${result.latency_ms}ms` : result.message)
    } catch (error) {
      setTestResult(null)
      setMessage(safeErrorMessage(error, 'API 测试失败'))
    } finally {
      setBusy(null)
    }
  }

  const label = MODULE_LABELS[module]
  // A complete-looking configuration is not the same as a working provider
  // connection. Once a real test has run, its result must take precedence so
  // an upstream 401/404 cannot still render as a healthy green status.
  const isHealthy = testResult ? testResult.ok : false
  const isKnownFailure = testResult ? !testResult.ok : status?.configured === false
  const StatusIcon = busy ? Loader2 : isHealthy ? CheckCircle2 : isKnownFailure ? AlertCircle : Wifi
  const statusClass = isHealthy
    ? 'text-emerald-500'
    : isKnownFailure
      ? 'text-amber-500'
      : 'text-[var(--nova-text-faint)]'

  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 rounded-[var(--nova-radius)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] text-[11px] text-[var(--nova-text-muted)] ${compact ? 'px-1.5 py-1' : 'px-2 py-1'}`}
      data-testid={`model-gateway-controls-${module}`}
      title={`${label} · ${message}`}
    >
      <StatusIcon className={`h-3.5 w-3.5 shrink-0 ${statusClass} ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
      {!compact && <span className="hidden max-w-28 truncate xl:inline">AI · {label}</span>}
      {!compact && <span className="hidden max-w-48 truncate 2xl:inline">{message}</span>}
      <span className="sr-only" role="status" aria-live="polite">{message}</span>
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-[var(--nova-text-faint)] transition-colors hover:bg-[var(--nova-hover)] hover:text-[var(--nova-text)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void refresh()}
        disabled={busy !== null}
        aria-label="刷新模型状态"
        title={`刷新${label}模型状态`}
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rounded border border-[var(--nova-border)] px-1.5 py-0.5 text-[var(--nova-text-muted)] transition-colors hover:bg-[var(--nova-hover)] hover:text-[var(--nova-text)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void runTest()}
        disabled={busy !== null}
        aria-label="测试 API"
        title={`测试${label} API`}
      >
        {busy === 'test' ? '测试中' : '测试 API'}
      </button>
    </div>
  )
}

function safeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof APIError && error.message) return error.message
  return fallback
}
