const LOCAL_TRANSLATOR_URL = 'http://127.0.0.1:8097/api/denova/translator/translate'

export type LoreTranslationField = 'name' | 'brief_description' | 'content'

export interface LoreTranslationRequest {
  target_language: 'zh-CN'
  context: {
    item_id: string
    item_name: string
    item_type: string
  }
  fields: Partial<Record<LoreTranslationField, string>>
}

export interface LoreTranslationResponse {
  ok: boolean
  model: string
  fields: Partial<Record<LoreTranslationField, string>>
  translated_fields: LoreTranslationField[]
  skipped_fields: LoreTranslationField[]
  failed_fields?: Array<{ field: LoreTranslationField; error: string }>
}

export type TranslationJobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'pending_review' | 'applied' | 'conflict' | 'failed' | 'cancelled' | 'deleted'
export type TranslationJobMode = 'name_zh' | 'faithful_zh'
export type TranslationApplyPolicy = 'auto_apply_metadata' | 'review_content' | 'master_auto' | 'master_review'

export interface TranslationJobInput {
  item_id: string
  item_name: string
  field: string
  source_text: string
  base_revision: string
  mode: TranslationJobMode
  apply_policy: TranslationApplyPolicy
  source_sha256?: string
  import_id?: string
  source_id?: string
  source_revision?: string
  master_item_id?: string
}

export interface TranslationJob {
  id: string
  workspace: string
  item_id: string
  item_name: string
  field: string
  mode: TranslationJobMode
  apply_policy: TranslationApplyPolicy
  source_sha256: string
  source_text?: string
  base_revision: string
  status: TranslationJobStatus
  translation?: string
  model: string
  attempts: number
  error: string
  created_at: string
  updated_at: string
  completed_at?: string
  import_id?: string
  source_id?: string
  source_revision?: string
  master_item_id?: string
  quality_status?: 'pass' | 'needs_review' | 'failed' | ''
  quality_codes?: string[]
  quality_reason?: string
  quality_contract_version?: number
}

export interface TranslationQueueStatus {
  ok: boolean
  schema_version: number
  active_id: string
  pause_reasons: Array<'manual' | 'game'>
  paused: boolean
  counts: Partial<Record<TranslationJobStatus, number>>
  jobs: TranslationJob[]
  created?: string[]
  skipped?: string[]
}

export interface LoreTranslationError {
  ok: false
  code: string
  error: string
}

export class LoreTranslationError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LoreTranslationError'
    this.code = code
  }
}

export async function translateLoreFields(
  request: LoreTranslationRequest,
  signal?: AbortSignal,
): Promise<LoreTranslationResponse> {
  let response: Response
  try {
    response = await fetch(LOCAL_TRANSLATOR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    throw new LoreTranslationError(
      'bridge_offline',
      '本地翻译服务未启动，请先启动叙界本地服务。',
    )
  }

  let payload: LoreTranslationResponse | LoreTranslationError
  try {
    payload = await response.json()
  } catch {
    throw new LoreTranslationError('invalid_response', '翻译服务返回了无法解析的响应')
  }

  if (!response.ok || !payload.ok) {
    const errorPayload = payload as LoreTranslationError
    const code = errorPayload.code || 'translation_failed'
    const message = errorPayload.error || `翻译请求失败（HTTP ${response.status}）`
    throw new LoreTranslationError(code, message)
  }

  return payload as LoreTranslationResponse
}

async function localTranslationJSON<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:8097${path}`, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new LoreTranslationError('bridge_offline', '本地翻译服务未启动，请先启动叙界本地服务。')
  }
  const payload = await response.json().catch(() => null) as ({ ok?: boolean; code?: string; error?: string } & T) | null
  if (!response.ok || !payload?.ok) {
    throw new LoreTranslationError(payload?.code || 'translation_failed', payload?.error || `翻译请求失败（HTTP ${response.status}）`)
  }
  return payload
}

export function createTranslationJobs(workspace: string, jobs: TranslationJobInput[]): Promise<TranslationQueueStatus> {
  return localTranslationJSON('/api/denova/translator/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, jobs }),
  })
}

export function getTranslationQueue(workspace = ''): Promise<TranslationQueueStatus> {
  return localTranslationJSON(`/api/denova/translator/jobs?workspace=${encodeURIComponent(workspace)}`)
}

export function getTranslationJob(id: string): Promise<TranslationJob & { ok: true }> {
  return localTranslationJSON(`/api/denova/translator/jobs/${encodeURIComponent(id)}`)
}

export function setTranslationQueuePaused(paused: boolean, reason: 'manual' | 'game'): Promise<TranslationQueueStatus> {
  return localTranslationJSON(`/api/denova/translator/queue/${paused ? 'pause' : 'resume'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
  })
}

export function cancelTranslationJob(id: string): Promise<TranslationJob & { ok: true }> {
  return localTranslationJSON(`/api/denova/translator/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export function deleteTranslationJob(id: string): Promise<TranslationJob & { ok: true }> {
  return localTranslationJSON(`/api/denova/translator/jobs/${encodeURIComponent(id)}/delete`, { method: 'POST' })
}

export function retryTranslationJob(id: string): Promise<TranslationJob & { ok: true }> {
  return localTranslationJSON(`/api/denova/translator/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' })
}

export function resolveTranslationJob(id: string, status: 'applied' | 'conflict' | 'cancelled', error = ''): Promise<TranslationJob & { ok: true }> {
  return localTranslationJSON(`/api/denova/translator/jobs/${encodeURIComponent(id)}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, error }),
  })
}
