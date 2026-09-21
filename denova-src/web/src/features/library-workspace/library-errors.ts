import { APIError, type WorkLibraryImpact } from '@/lib/api-client'
import { isRevisionConflict } from '@/lib/revision-conflict'

// 设定库错误的分类与纯派生逻辑。
//
// 单独成文件的原因：这些判断决定“保留草稿并提示重新加载”还是“普通报错”，
// 属于最容易出错、也最值得单测的部分，不依赖 React。

export type WorkLibraryErrorKind =
  | 'conflict'
  | 'item_in_use'
  | 'reference_read_only'
  | 'validation'
  | 'not_found'
  | 'duplicate_relation'
  | 'self_relation'
  | 'unknown'

/** 服务端下发的稳定错误 code（`{"error": "...", "code": "..."}`）。 */
export function workLibraryErrorCode(error: unknown): string | undefined {
  if (error instanceof APIError && typeof error.code === 'string' && error.code) return error.code
  return undefined
}

/** 把错误归类到具体的用户可见处理方式。 */
export function classifyWorkLibraryError(error: unknown): WorkLibraryErrorKind {
  // 并发冲突优先判断：它要走“保留草稿 + 重新加载”，不能按普通失败处理。
  if (isRevisionConflict(error)) return 'conflict'
  switch (workLibraryErrorCode(error)) {
    case 'item_in_use':
      return 'item_in_use'
    case 'reference_read_only':
      return 'reference_read_only'
    case 'duplicate_relation':
      return 'duplicate_relation'
    case 'self_relation':
      return 'self_relation'
    case 'validation_failed':
    case 'invalid_id':
      return 'validation'
    case 'not_found':
    case 'item_not_found':
    case 'relation_not_found':
      return 'not_found'
    default:
      return 'unknown'
  }
}

/** 服务端返回的删除影响明细（仅 item_in_use 时存在）。 */
export function workLibraryErrorImpact(error: unknown): WorkLibraryImpact | null {
  if (!(error instanceof APIError)) return null
  const payload = error.payload as Record<string, unknown> | undefined
  const impact = payload?.impact
  if (!impact || typeof impact !== 'object') return null
  return impact as WorkLibraryImpact
}

/** 取服务端错误文案；没有则回落到调用方给的兜底 key。 */
export function workLibraryErrorMessage(error: unknown): string | null {
  if (error instanceof APIError) {
    const payload = error.payload as Record<string, unknown> | undefined
    const message = payload?.error
    if (typeof message === 'string' && message.trim()) return message.trim()
    if (error.message) return error.message
  }
  if (error instanceof Error && error.message) return error.message
  return null
}

/** 该错误是否应当触发“重新加载”入口。 */
export function shouldOfferReload(error: unknown): boolean {
  const kind = classifyWorkLibraryError(error)
  return kind === 'conflict' || kind === 'not_found' || kind === 'unknown'
}

/** 逗号/顿号分隔输入 → 去空白去重的字符串数组（与后端 NormalizeLoreStringList 语义一致）。 */
export function parseListInput(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value.split(/[,，、\n]/)) {
    const item = raw.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 字符串数组 → 逗号分隔输入框文本。 */
export function formatListInput(values: string[] | null | undefined): string {
  return (values ?? []).join(', ')
}

/** 结构化字段 → 可编辑键值行（保持插入顺序，便于用户对照）。 */
export function fieldsToRows(fields: Record<string, string> | null | undefined): Array<{ key: string; value: string }> {
  if (!fields) return []
  return Object.keys(fields).map((key) => ({ key, value: fields[key] ?? '' }))
}

/** 可编辑键值行 → 结构化字段；空键被丢弃，空值保留（表示显式清空）。 */
export function rowsToFields(rows: Array<{ key: string; value: string }>): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 事件顺序输入 → 整数；非法输入返回 0（与后端默认一致），避免把 NaN 写进库。 */
export function parseEventOrder(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(-1000000, Math.min(1000000, parsed))
}
