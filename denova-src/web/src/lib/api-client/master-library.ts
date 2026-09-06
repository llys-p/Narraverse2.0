import { requestJSON } from './client'
import { createTranslationJobs, type TranslationJobInput } from './local-translation'
import type { MaterialImportResult, MasterTranslationTarget } from './material-library'

export type MasterAssetAvailability = 'staging' | 'usable'
export type MasterPipelineStatusName = 'waiting' | 'running' | 'completed' | 'warning' | 'review_required' | 'failed' | 'stale' | 'skipped'

export interface MasterPipelineIssue {
  id: string
  stage: string
  code: string
  severity: 'blocking' | 'warning'
  blocking: boolean
  message: string
  reason?: string
}

export interface MasterPipelineNode {
  key: 'archive' | 'parse' | 'normalize' | 'translation' | 'check' | 'usable' | 'instantiate' | string
  status: MasterPipelineStatusName
  input_revision?: string
  output_revision?: string
  inferred: boolean
  reason?: string
  issue_ids?: string[]
}

export interface MasterTranslationStatus {
  total_fields: number
  active_fields: number
  pending_fields: number
  review_fields: number
  failed_fields: number
  content_version_kind: Record<string, number>
}

export interface MasterPipelineStatus {
  availability: MasterAssetAvailability
  nodes: MasterPipelineNode[]
  issues: MasterPipelineIssue[]
  translation: MasterTranslationStatus
  usage_count: number
}

export interface MasterAssetSummary {
  master_item_id: string
  name: string
  description?: string
  nested_entry_count: number
  record_kind: string
  semantic_type: string
  source_id: string
  source_name: string
  source_revision: string
  master_revision: string
  availability: MasterAssetAvailability
  usage_count: number
  pipeline: MasterPipelineStatus
}

export interface MasterAssetList {
  assets: MasterAssetSummary[]
  total: number
}

export interface MasterTranslationVersionView {
  version: Record<string, unknown>
  content_version_kind: 'hy_mt_active' | 'polish_candidate' | 'polished_active' | string
}

export interface MasterAssetDetail {
  summary: MasterAssetSummary
  item: Record<string, unknown>
  source: Record<string, unknown>
  source_revision: Record<string, unknown>
  translations: MasterTranslationVersionView[]
  usages: Array<Record<string, unknown>>
}

export interface MasterProposal {
  proposal_id: string
  operation_id: string
  kind: 'recovery' | 'polish' | string
  stage: string
  apply_mode: 'auto' | 'confirm' | string
  status: 'proposed' | 'validated' | 'candidate_ready' | 'applied' | 'conflict' | 'rejected' | string
  master_item_id: string
  field_path: string
  import_id: string
  original: string
  current_translation?: string
  patch: { field_path: string; translation: string }
  input_revision: string
  source_sha256: string
  base_translation_version?: string
  risk: string
  issue_code?: string
  reason?: string
  protected_token_override?: boolean
  agent_run_id?: string
  recovery_attempt?: number
  applied_translation_version_id?: string
  created_at: string
  updated_at: string
}

export function fetchMasterAssetProposals(masterItemID: string): Promise<{ proposals: MasterProposal[] }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/proposals`)
}

export function createMasterProposal(masterItemID: string, input: Partial<MasterProposal> & { field_path: string; translation?: string }): Promise<{ proposal: MasterProposal }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/proposals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
}

export function validateMasterProposal(proposalID: string, options: { allowProtectedTokenMismatch?: boolean } = {}): Promise<{ proposal: MasterProposal }> {
  return requestJSON(`/api/library/proposals/${encodeURIComponent(proposalID)}/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow_protected_token_mismatch: Boolean(options.allowProtectedTokenMismatch) }),
  })
}

export function applyMasterProposal(proposalID: string, confirmed = false, forceConflict = false, allowProtectedTokenMismatch = false): Promise<{ proposal: MasterProposal; translation: Record<string, unknown> }> {
  return requestJSON(`/api/library/proposals/${encodeURIComponent(proposalID)}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed, force_conflict: forceConflict, allow_protected_token_mismatch: allowProtectedTokenMismatch }),
  })
}

export function rejectMasterProposal(proposalID: string): Promise<{ proposal: MasterProposal }> {
  return requestJSON(`/api/library/proposals/${encodeURIComponent(proposalID)}/reject`, { method: 'POST' })
}

export interface MasterProposalBatchResult {
  applied_count: number
  results: Array<{ proposal_id: string; status: string; error?: string; translation_version_id?: string }>
}

export function applyMasterProposals(masterItemID: string, proposalIDs: string[], confirmedHighRisk = false, forceConflicts = false, allowProtectedTokenMismatch = false): Promise<MasterProposalBatchResult> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/proposals/batch-apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal_ids: proposalIDs, confirmed_high_risk: confirmedHighRisk, force_conflicts: forceConflicts, allow_protected_token_mismatch: allowProtectedTokenMismatch }),
  })
}

export interface MasterProposalBatchRejectResult {
  rejected_count: number
  results: Array<{ proposal_id: string; status: string; error?: string }>
}

export function rejectMasterProposals(masterItemID: string, proposalIDs: string[]): Promise<MasterProposalBatchRejectResult> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/proposals/batch-reject`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal_ids: proposalIDs }),
  })
}

export function startMasterAgent(masterItemID: string, fieldPath: string, kind: 'recovery' | 'polish', message = ''): Promise<{ task_id: string; status: string }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/agent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field_path: fieldPath, kind, message }),
  })
}

export async function listMasterAssets(options: {
  query?: string
  recordKind?: string
  semanticType?: string
  availability?: MasterAssetAvailability
  limit?: number
  offset?: number
} = {}): Promise<MasterAssetList> {
  const params = new URLSearchParams()
  if (options.query) params.set('q', options.query)
  if (options.recordKind) params.set('record_kind', options.recordKind)
  if (options.semanticType) params.set('semantic_type', options.semanticType)
  if (options.availability) params.set('availability', options.availability)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  const suffix = params.toString()
  return requestJSON<MasterAssetList>(`/api/library/assets${suffix ? `?${suffix}` : ''}`)
}

export function fetchMasterAsset(masterItemID: string): Promise<MasterAssetDetail> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}`)
}

export function fetchMasterAssetPipeline(masterItemID: string): Promise<MasterPipelineStatus> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/pipeline`)
}

export function fetchMasterAssetTranslations(masterItemID: string): Promise<{ translations: MasterTranslationVersionView[] }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/translations`)
}

export function fetchMasterAssetUsages(masterItemID: string): Promise<{ usages: Array<Record<string, unknown>> }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/usages`)
}

export function instantiateMasterAsset(masterItemID: string): Promise<MaterialImportResult> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/instances`, { method: 'POST' })
}

export function updateMasterAssetDescription(masterItemID: string, description: string): Promise<{ item: Record<string, unknown> }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/description`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  })
}

export function updateMasterAssetFields(masterItemID: string, expectedRevision: string, fields: Record<string, string>): Promise<{ item: Record<string, unknown> }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/fields`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, fields }),
  })
}

export function addMasterLorebookEntry(masterItemID: string, expectedRevision: string, input: { name: string; content: string; keywords: string[]; secondary_keys: string[] }): Promise<{ item: Record<string, unknown> }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, ...input }),
  })
}

export interface MasterAssetAdventureUsage {
  used: boolean
  has_new_version: boolean
  loaded_revision?: string
  current_revision?: string
}

export interface MasterAssetSyncResult {
  master_item_id: string
  updated_lore_ids: string[]
  previous_revision?: string
  loaded_revision?: string
  skipped: boolean
  message?: string
}

/** 当前冒险是否使用了该资产、是否有新版本可同步。后端判定，前端不得用 usages.length 代替。 */
export function fetchMasterAssetAdventureUsage(masterItemID: string): Promise<{ usage: MasterAssetAdventureUsage }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/adventure-usage`)
}

/** 把总库当前生效工作版本重投影到当前冒险的既有实例，不会新建实例。 */
export function syncMasterAssetToAdventure(
  masterItemID: string,
): Promise<{ result: MasterAssetSyncResult; usage?: MasterAssetAdventureUsage }> {
  return requestJSON(`/api/library/assets/${encodeURIComponent(masterItemID)}/sync-adventure`, { method: 'POST' })
}

export async function enqueueMasterTranslationTargets(workspace: string, targets: MasterTranslationTarget[]): Promise<void> {
  if (!workspace || targets.length === 0) return
  const jobs: TranslationJobInput[] = targets.filter((target) => target.status !== 'active').map((target) => ({
    item_id: target.master_item_id,
    master_item_id: target.master_item_id,
    item_name: target.item_name,
    field: target.field_path,
    source_text: target.source_text,
    source_sha256: target.source_sha256,
    base_revision: target.source_revision,
    mode: target.mode,
    apply_policy: target.apply_policy,
    import_id: target.import_id,
    source_id: target.source_id,
    source_revision: target.source_revision,
  }))
  for (let index = 0; index < jobs.length; index += 100) await createTranslationJobs(workspace, jobs.slice(index, index + 100))
}
