import { jsonHeaders, requestJSON } from '@/lib/api-client'
import type {
  ProposalEnvelope,
  World,
  WorldCreateInput,
  WorldEnvelope,
  WorldListEnvelope,
  WorldStatus,
  WorldStructureAnalysisRequest,
} from './types'
import type { PreviewWorldContextRequest, WorldContextPreviewEnvelope } from './world-context'

function encode(id: string): string {
  return encodeURIComponent(id)
}

/** GET /api/worlds —— 扫描派生的摘要列表 + 损坏文件告警。 */
export function listWorlds(status?: WorldStatus | 'all'): Promise<WorldListEnvelope> {
  const q = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''
  return requestJSON<WorldListEnvelope>(`/api/worlds${q}`)
}

/** GET /api/worlds/:id —— 世界详情与当前 revision。 */
export function getWorld(id: string): Promise<WorldEnvelope> {
  return requestJSON<WorldEnvelope>(`/api/worlds/${encode(id)}`)
}

/** POST /api/worlds —— 一次原子创建完整初始世界。 */
export function createWorld(input: WorldCreateInput): Promise<WorldEnvelope> {
  return requestJSON<WorldEnvelope>(`/api/worlds`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

/** PUT /api/worlds/:id —— 整文档 CAS 替换，expectedRevision 为读到的内容哈希。 */
export function updateWorld(
  id: string,
  expectedRevision: string,
  world: World,
): Promise<WorldEnvelope> {
  return requestJSON<WorldEnvelope>(`/api/worlds/${encode(id)}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ expected_revision: expectedRevision, world }),
  })
}

/** POST /api/worlds/:id/archive —— 归档或恢复（撤销），同样带 revision。 */
export function archiveWorld(
  id: string,
  expectedRevision: string,
  archived: boolean,
): Promise<WorldEnvelope> {
  return requestJSON<WorldEnvelope>(`/api/worlds/${encode(id)}/archive`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ archived, expected_revision: expectedRevision }),
  })
}

/** POST /api/world-proposals —— 创建向导受控 AI 结构分析（前端不得直调 /api/model/chat）。 */
export function analyzeWorldStructure(
  input: WorldStructureAnalysisRequest,
  signal?: AbortSignal,
): Promise<ProposalEnvelope> {
  return requestJSON<ProposalEnvelope>('/api/world-proposals', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
    signal,
  })
}

/**
 * POST /api/worlds/:id/context-preview —— 只读世界上下文预览（3.1A1/A2）。
 * 只读取已保存 World + revision 派生 UI Projection；不创建 runContext、不调模型、不写 World。
 */
export function previewWorldContext(
  id: string,
  body: PreviewWorldContextRequest,
  signal?: AbortSignal,
): Promise<WorldContextPreviewEnvelope> {
  return requestJSON<WorldContextPreviewEnvelope>(`/api/worlds/${encode(id)}/context-preview`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
    signal,
  })
}
