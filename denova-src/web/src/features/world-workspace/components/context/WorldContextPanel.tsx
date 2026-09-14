import { useTranslation } from 'react-i18next'
import { PenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { World } from '../../types'
import { WorldContextPreviewResult } from '../WorldContextPreviewResult'
import { BindingOverview } from './BindingOverview'
import { WorldContextPreview } from './WorldContextPreview'
import { WorldContextSelection, selectionBlocksPreview } from './WorldContextSelection'
import type {
  ContextPreviewState,
  WorldContextConsumer,
  WorldContextSelection as Selection,
  WorldContextUIView,
  WorldConsoleSectionId,
} from '../../world-context'

export type ContextPreviewPanelState = ContextPreviewState

/**
 * Phase 3.1B：World Console 的“世界上下文”分区 UI（编排，不持有网络/状态机）。
 *
 * 生命周期、请求序号、selection/consumer 状态由 WorldConsolePage 与既有
 * useWorldContextPreview hook 持有；本组件只负责组合：
 * - 选择控件（B1）；
 * - “生成预览”按钮（dirty / 超限 / 加载中禁用，点击只回调一次）；
 * - idle/loading/error 复用 WorldContextPreviewResult；ready/stale 用详细分段视图。
 * 不发 Master 详情请求、不调模型、不访问持久化、不创建 runContext。
 */
interface WorldContextPanelProps {
  world: World
  dirty: boolean
  consumer: WorldContextConsumer
  selection: Selection
  state: ContextPreviewState
  preview: WorldContextUIView | null
  error: Error | null
  onConsumerChange: (consumer: WorldContextConsumer) => void
  onSelectionChange: (selection: Selection) => void
  onGenerate: () => void
  onJumpSection: (section: WorldConsoleSectionId) => void
  /**
   * Phase 3.1C2b：移除 Binding 的唯一出口，由 WorldConsolePage 落到 mutate。
   * 本组件不做任何确认或世界修改，只把 BindingOverview 的决定向上转交。
   * 保持可选是受 C2b 白名单所限（既有 WorldContextPanel 测试不在白名单内）；
   * 未提供时 BindingOverview 不显示移除入口，控制台真实链路必须提供。
   */
  onRemoveBinding?: (bindingId: string) => void
  /**
   * Phase 3.2-A5：显式「带入写作」。由 WorldConsolePage 实现：dirty/超限/无已保存
   * revision/无主书时不应提供；切主书成功后才写入 LaunchProvider 并切到写作模式。
   * 未提供时不显示入口（普通预览不强制进入运行态）。
   */
  onLaunchWriting?: () => void
  launchWritingPending?: boolean
}

export function WorldContextPanel({
  world,
  dirty,
  consumer,
  selection,
  state,
  preview,
  error,
  onConsumerChange,
  onSelectionChange,
  onGenerate,
  onJumpSection,
  onRemoveBinding,
  onLaunchWriting,
  launchWritingPending = false,
}: WorldContextPanelProps) {
  const { t } = useTranslation()
  const loading = state === 'loading'
  const overflow = selectionBlocksPreview(selection)
  const generateDisabled = loading || overflow || dirty
  const showDetail = (state === 'ready' || state === 'stale') && preview
  // 只在写作 consumer 下提供「带入写作」；dirty/超限/切书进行中禁用。
  const showLaunch = consumer === 'writing' && Boolean(onLaunchWriting)
  const launchDisabled = generateDisabled || launchWritingPending

  return (
    <div data-testid="world-context-panel" className="mx-auto flex max-w-3xl flex-col gap-4">
      <WorldContextSelection
        world={world}
        consumer={consumer}
        selection={selection}
        onConsumerChange={onConsumerChange}
        onChange={onSelectionChange}
      />

      <BindingOverview world={world} onRemoveBinding={onRemoveBinding} />

      {dirty ? (
        <p data-testid="context-blocked-dirty" className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          {t('worldWorkspace.context.blockedDirty')}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={generateDisabled} onClick={onGenerate}>
          {loading ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
          {loading ? t('worldWorkspace.context.generating') : t('worldWorkspace.context.generate')}
        </Button>
        {showLaunch ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-icon="inline-start"
            data-testid="context-launch-writing"
            disabled={launchDisabled}
            onClick={onLaunchWriting}
          >
            {launchWritingPending ? <Spinner className="size-3.5" /> : <PenLine className="size-3.5" />}
            {t('worldWorkspace.context.launchWriting')}
          </Button>
        ) : null}
      </div>

      {showDetail ? (
        <WorldContextPreview
          view={preview}
          state={state === 'stale' ? 'stale' : 'ready'}
          world={world}
          onJumpSection={onJumpSection}
        />
      ) : (
        <WorldContextPreviewResult state={state} preview={preview} error={error} />
      )}
    </div>
  )
}
