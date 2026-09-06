import { type TranslationJob, type TranslationQueueStatus } from './local-translation'
import { requestJSON } from './client'
import type { MasterAssetDetail, MasterPipelineStatus } from './master-library'

export type MasterTaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'retrying'
export type MasterContentVersionStatus = 'original' | 'hy_mt_active' | 'polish_candidate' | 'polished_active'

export interface MasterTranslationFieldRuntime {
  field_path: string
  task_status: MasterTaskStatus
  content_version_status: MasterContentVersionStatus
  translation_version?: string
  failure_reason?: string
  review_required: boolean
  input_revision?: string
  source_sha256?: string
  task_id?: string
  model?: string
  attempts?: number
  updated_at?: string
  final_failure?: boolean
  recovery_status?: 'waiting_for_runtime' | 'eligible' | 'agent_running' | 'proposal_ready' | 'applying' | 'revalidating' | 'recovered' | 'needs_user' | 'failed' | string
  candidate_translation?: string
  quality_status?: 'pass' | 'needs_review' | 'failed' | ''
  quality_codes?: string[]
  quality_reason?: string
}

export interface MasterTranslationRuntime {
  fields: MasterTranslationFieldRuntime[]
  active_fields: number
  total_fields: number
  review_fields: number
  failed_fields: number
  queue_paused: boolean
  runtime_available: boolean
  runtime_error?: string
}

/** Read-only merge of Master content versions and the live 8097 queue. */
export async function fetchMasterTranslationRuntime(detail: MasterAssetDetail): Promise<MasterTranslationRuntime> {
	try {
    return await requestJSON<MasterTranslationRuntime>(`/api/library/assets/${encodeURIComponent(detail.summary.master_item_id)}/runtime`)
	} catch (error) {
    const runtime = buildMasterTranslationRuntime(detail, { paused: false, jobs: [] })
    return {
      ...runtime,
      runtime_available: false,
      runtime_error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function buildMasterTranslationRuntime(detail: MasterAssetDetail, queue: Pick<TranslationQueueStatus, 'paused' | 'jobs'>): MasterTranslationRuntime {
  const fieldsRecord = detail.item.fields
  const entries = fieldsRecord && typeof fieldsRecord === 'object' && !Array.isArray(fieldsRecord)
    ? Object.entries(fieldsRecord)
    : []
  const versions = detail.translations
  const fields = entries
    .filter(([, field]) => Boolean(field && typeof field === 'object' && !Array.isArray(field) && (field as Record<string, unknown>).needs_translation === true))
    .map(([fieldPath, rawField]) => {
      const field = rawField as Record<string, unknown>
      const activeVersionID = typeof field.active_translation_version_id === 'string' ? field.active_translation_version_id : undefined
      const activeVersion = versions.find((entry) => stringValue(entry.version, 'translation_version_id') === activeVersionID)
      const jobs = queue.jobs
        .filter((job) => job.master_item_id === detail.summary.master_item_id && job.field === fieldPath)
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
      const job = jobs.at(-1)
      const contentVersionStatus = contentVersionStatusOf(field, activeVersion?.content_version_kind)
      return {
        field_path: fieldPath,
        task_status: taskStatusOf(job, Boolean(activeVersionID)),
        content_version_status: contentVersionStatus,
        translation_version: activeVersionID,
        failure_reason: job?.error || undefined,
        review_required: job?.status === 'pending_review',
        input_revision: job?.base_revision || job?.source_revision || stringValue(activeVersion?.version, 'source_revision'),
        source_sha256: job?.source_sha256 || stringValue(activeVersion?.version, 'source_sha256'),
        task_id: job?.id,
        model: job?.model || stringValue(activeVersion?.version, 'model'),
        final_failure: false,
        candidate_translation: job?.translation,
        quality_status: job?.quality_status,
        quality_codes: job?.quality_codes,
        quality_reason: job?.quality_reason,
      } satisfies MasterTranslationFieldRuntime
    })
  return {
    fields,
    active_fields: fields.filter((field) => field.content_version_status !== 'original').length,
    total_fields: fields.length,
    review_fields: fields.filter((field) => field.review_required).length,
    failed_fields: fields.filter((field) => field.task_status === 'failed').length,
    queue_paused: queue.paused,
    runtime_available: true,
  }
}

function taskStatusOf(job: TranslationJob | undefined, hasActiveVersion: boolean): MasterTaskStatus {
  if (!job) return hasActiveVersion ? 'completed' : 'queued'
  if (job.status === 'queued') return 'queued'
  if (job.status === 'running') return 'running'
  if (job.status === 'paused') return 'paused'
  if (job.status === 'failed' || job.status === 'conflict' || job.status === 'cancelled') return 'failed'
  if (job.status === 'pending_review' || job.status === 'completed' || job.status === 'applied') return 'completed'
  return 'retrying'
}

function contentVersionStatusOf(field: Record<string, unknown>, inferred?: string): MasterContentVersionStatus {
  const activeKind = typeof field.active_kind === 'string' ? field.active_kind : undefined
  if (activeKind === 'hy_mt_active' || activeKind === 'polish_candidate' || activeKind === 'polished_active') return activeKind
  if (inferred === 'hy_mt_active' || inferred === 'polish_candidate' || inferred === 'polished_active') return inferred
  return 'original'
}

function stringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

export function masterTranslationSummaryStatus(runtime: MasterTranslationRuntime, pipeline: MasterPipelineStatus) {
  if (!runtime.runtime_available) return 'unavailable' as const
  if (runtime.failed_fields > 0) return 'needs_attention' as const
  if (runtime.review_fields > 0) return 'needs_confirmation' as const
  if (runtime.active_fields < runtime.total_fields) return 'processing' as const
  if (pipeline.translation.total_fields === 0) return 'not_required' as const
  return 'completed' as const
}
