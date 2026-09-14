/**
 * Phase 3.2-A6：写作运行时世界背景的前端 wire 契约（与后端冻结契约对齐）。
 *
 * 边界：
 *   - 这里的类型只用于「一次请求 / 一次 SSE 状态事件」，全部是运行时派生数据；
 *   - 不写 localStorage/sessionStorage/IndexedDB，不进 Zustand，刷新即丢；
 *   - 不包含 Snapshot/ModelView/runContextId/scopeKey/fingerprint/handle 等内部对象，
 *     analysisHandle 只是不透明短 token，成功启动后不长期保存；
 *   - World 仍是唯一持久化真源。
 */
import type { WorldContextSelection } from '@/features/world-workspace/world-context'
import type { WritingWorldContextRef } from './WorldContextLaunchProvider'

/** §6.2 冻结的运行状态；degraded 与 none 不允许混写。 */
export type WorldContextRunState = 'none' | 'bound' | 'active' | 'degraded'

/** analysisHandle 的单列裁定结果，绝不伪装成 context_state=degraded。 */
export type AnalysisHandleStatus =
  | 'consumed'
  | 'ignored_invalid'
  | 'ignored_expired'
  | 'ignored_consumed'
  | 'ignored_conflict'

/** SSE `world_context_state` 数据事件与 context-analysis 响应共用的脱敏摘要。 */
export interface WorldContextRunStatus {
  state: WorldContextRunState
  worldName?: string
  revisionLabel?: string
  selectedCount?: number
  errorCode?: string
  analysisHandleStatus?: AnalysisHandleStatus
}

/**
 * 构造 POST /api/chat 与 /api/chat/context-analysis 的 world_context 请求体（camelCase）。
 * 直接复用已保存 Ref，不重新投影、不补全正文。
 */
export function toWorldContextRequestBody(ref: WritingWorldContextRef): WritingWorldContextRef {
  return {
    worldId: ref.worldId,
    expectedWorldRevision: ref.expectedWorldRevision,
    selection: ref.selection satisfies WorldContextSelection,
  }
}

/** 安全解析 SSE / 响应里的世界背景状态，未知 state 一律降级为 unavailable 展示而非崩溃。 */
export function normalizeWorldContextStatus(data: unknown): WorldContextRunStatus | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  const state = raw.state
  if (state !== 'none' && state !== 'bound' && state !== 'active' && state !== 'degraded') {
    return null
  }
  const status: WorldContextRunStatus = { state }
  if (typeof raw.worldName === 'string') status.worldName = raw.worldName
  if (typeof raw.revisionLabel === 'string') status.revisionLabel = raw.revisionLabel
  if (typeof raw.selectedCount === 'number') status.selectedCount = raw.selectedCount
  if (typeof raw.errorCode === 'string') status.errorCode = raw.errorCode
  if (
    raw.analysisHandleStatus === 'consumed' ||
    raw.analysisHandleStatus === 'ignored_invalid' ||
    raw.analysisHandleStatus === 'ignored_expired' ||
    raw.analysisHandleStatus === 'ignored_consumed' ||
    raw.analysisHandleStatus === 'ignored_conflict'
  ) {
    status.analysisHandleStatus = raw.analysisHandleStatus
  }
  return status
}
