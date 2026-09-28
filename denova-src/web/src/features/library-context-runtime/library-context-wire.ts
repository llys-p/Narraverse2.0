/**
 * B2b：作品设定库写作背景的前端 wire 契约（与后端 B2a 冻结契约、L3 计划 §8.8 对齐）。
 *
 * 边界：
 *   - 这里的类型只用于「一次请求 / 一次 SSE 状态事件」，全部是运行时派生数据；
 *   - 不写 localStorage/sessionStorage/IndexedDB，不进 Zustand，刷新即丢；
 *   - 只携带已保存库的 Ref（libraryId + expectedRevision + manualItemIds）；
 *     L2 preview 的 autoItemIds 只是预览选择，不进入任何运行授权（B0 §8.2）；
 *   - 不包含 consumer/scopeKey/runContextId/fingerprint 等运行身份字段——
 *     服务端按任务归属派生，传输层对越权键一律 400 拒绝；
 *   - 设定库仍是唯一持久化真源，本文件不修改库、不创建运行、不调用模型。
 */

/** 与后端冻结 wire 对齐的写作库 Ref（camelCase，服务端派生 consumer=writing）。 */
export interface WritingLibraryContextRef {
  libraryId: string
  expectedRevision: string
  manualItemIds: string[]
}

/**
 * 前端运行状态。bound 是本地「已交接、下次发送生效」的待运行语义；
 * active/none 与服务端 `library_context_state` 事件一致（库模式绑定期失败
 * 直接阻断启动，不存在 degraded——B2a 修正轮 §8.8）。
 */
export type LibraryContextRunState = 'none' | 'bound' | 'active'

/** SSE `library_context_state` 数据事件的脱敏摘要（state/libraryName/revisionLabel/selectedCount）。 */
export interface LibraryContextRunStatus {
  state: 'none' | 'active'
  libraryName?: string
  revisionLabel?: string
  selectedCount?: number
}

/**
 * 构造 POST /api/chat 的 library 请求体片段（camelCase，与 L2 preview DTO 一致）。
 * 直接复用已保存 Ref，不重新投影、不补全正文。
 */
export function toLibraryContextRequestBody(ref: WritingLibraryContextRef): {
  libraryId: string
  expectedRevision: string
  manualItemIds: string[]
} {
  return {
    libraryId: ref.libraryId,
    expectedRevision: ref.expectedRevision,
    manualItemIds: [...ref.manualItemIds],
  }
}

/** 安全解析 SSE 里的设定库背景状态；未知 state 一律忽略而非崩溃。 */
export function normalizeLibraryContextState(data: unknown): LibraryContextRunStatus | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  const state = raw.state
  if (state !== 'none' && state !== 'active') return null
  const status: LibraryContextRunStatus = { state }
  if (typeof raw.libraryName === 'string') status.libraryName = raw.libraryName
  if (typeof raw.revisionLabel === 'string') status.revisionLabel = raw.revisionLabel
  if (typeof raw.selectedCount === 'number') status.selectedCount = raw.selectedCount
  return status
}
