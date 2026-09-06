import { requestJSON } from './client'
import type { CharacterCardPreview } from './types'

const MATERIAL_BRIDGE = 'http://127.0.0.1:8097'

export interface NarraverseMaterialRef {
  source_id: string
  name: string
  relative_path: string
  kind: 'character_card' | 'lorebook'
  bytes: number
  sha256: string
  source_ref?: { version: 1; source_id: string; relative_path: string; sha256: string }
}

export interface MaterialPreview {
  kind: 'character_card' | 'lorebook'
  name: string
  entry_count: number
  resident_bytes: number
  truncated: boolean
  warnings: string[]
  character_card?: CharacterCardPreview
}

export type MaterialManagementMode = 'master_managed' | 'unmanaged_direct'

export interface MaterialImportConflict {
  source_record_id: string
  original_target_id: string
  conflict_id: string
  name: string
  reason: string
  action: string
}

export interface MasterTranslationTarget {
  import_id: string
  source_id: string
  source_revision: string
  master_item_id: string
  item_name: string
  field_path: string
  source_text: string
  source_sha256: string
  mode: 'name_zh' | 'faithful_zh'
  apply_policy: 'master_auto' | 'master_review'
  required: boolean
  status: 'queued' | 'pending_review' | 'active'
}

export interface MaterialImportResult {
  kind: 'character_card' | 'lorebook'
  name: string
  entry_count: number
  created_ids: string[]
  updated_ids: string[]
  conflict_ids: string[]
  conflicts: MaterialImportConflict[]
  skipped_ids: string[]
  failed: string[]
  item_ids: string[]
  archive_path: string
  manifest_path: string
  truncated: boolean
  management_mode: MaterialManagementMode
  status: 'pending_translation' | 'ready' | 'instantiated'
  import_id: string
  master_workspace: string
  master_source_id: string
  master_item_ids: string[]
  translation_targets: MasterTranslationTarget[]
}

export interface MasterTranslationApplyRequest {
  import_id: string
  master_item_id: string
  field_path: string
  source_sha256: string
  translation: string
  model: string
  job_id: string
  confirmed: boolean
}

export interface MasterTranslationApplyResponse {
  translation: {
    translation_version_id: string
    activated: boolean
    ready: boolean
  }
  import?: MaterialImportResult
}

async function materialBridgeJSON<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${MATERIAL_BRIDGE}${path}`)
  } catch {
    throw new Error('叙界本地服务未启动，无法读取知识库。')
  }
  const payload = await response.json().catch(() => null) as ({ ok?: boolean; error?: string } & T) | null
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || `读取叙界知识库失败（HTTP ${response.status}）`)
  return payload
}

export async function listNarraverseMaterials(): Promise<NarraverseMaterialRef[]> {
  const data = await materialBridgeJSON<{ materials: NarraverseMaterialRef[] }>('/api/denova/materials')
  return Array.isArray(data.materials) ? data.materials.filter((item): item is NarraverseMaterialRef => Boolean(item && item.source_id)) : []
}

export async function fetchNarraverseMaterial(reference: NarraverseMaterialRef): Promise<File> {
  let response: Response
  try {
    response = await fetch(`${MATERIAL_BRIDGE}/api/denova/materials/${reference.source_id}`)
  } catch {
    throw new Error('叙界本地服务未启动，无法读取知识库。')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || `读取叙界素材失败（HTTP ${response.status}）`)
  }
  return new File([await response.arrayBuffer()], reference.name, { type: reference.name.toLowerCase().endsWith('.png') ? 'image/png' : 'application/json' })
}

export async function previewMaterial(file: File): Promise<MaterialPreview> {
  const form = new FormData()
  form.append('file', file)
  const result = await requestJSON<Partial<MaterialPreview>>('/api/workspace/import-material/preview', { method: 'POST', body: form })
  return {
    kind: result.kind || 'lorebook',
    name: result.name || file.name,
    entry_count: Number.isFinite(result.entry_count) ? Number(result.entry_count) : 0,
    resident_bytes: Number.isFinite(result.resident_bytes) ? Number(result.resident_bytes) : file.size,
    truncated: Boolean(result.truncated),
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === 'string') : [],
    character_card: result.character_card,
  }
}

export async function importMaterial(file: File, options: { sourceId?: string; sourceKind?: string; acceptIncomplete?: boolean; userCharacterName?: string; managementMode?: MaterialManagementMode } = {}): Promise<MaterialImportResult> {
  const form = new FormData()
  form.append('file', file)
  if (options.sourceId) form.append('source_id', options.sourceId)
  if (options.sourceKind) form.append('source_kind', options.sourceKind)
  if (options.acceptIncomplete) form.append('accept_incomplete', 'true')
  if (options.userCharacterName) form.append('user_character_name', options.userCharacterName)
  form.append('management_mode', options.managementMode || 'master_managed')
  const result = await requestJSON<Partial<MaterialImportResult>>('/api/workspace/import-material', { method: 'POST', body: form })
  return normalizeMaterialImportResult(result, file)
}

export async function importMaterialToMaster(file: File, options: { sourceId?: string; sourceKind?: string; acceptIncomplete?: boolean; userCharacterName?: string } = {}): Promise<MaterialImportResult> {
  const form = new FormData()
  form.append('file', file)
  if (options.sourceId) form.append('source_id', options.sourceId)
  if (options.sourceKind) form.append('source_kind', options.sourceKind)
  if (options.acceptIncomplete) form.append('accept_incomplete', 'true')
  if (options.userCharacterName) form.append('user_character_name', options.userCharacterName)
  const result = await requestJSON<Partial<MaterialImportResult>>('/api/library/import-material', { method: 'POST', body: form })
  return normalizeMaterialImportResult(result, file)
}

function normalizeMaterialImportResult(result: Partial<MaterialImportResult>, file: File): MaterialImportResult {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    kind: result.kind || 'lorebook',
    name: result.name || file.name,
    entry_count: Number.isFinite(result.entry_count) ? Number(result.entry_count) : 0,
    created_ids: strings(result.created_ids),
    updated_ids: strings(result.updated_ids),
    conflict_ids: strings(result.conflict_ids),
    conflicts: Array.isArray(result.conflicts)
      ? result.conflicts.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const conflict = value as Partial<MaterialImportConflict>
        if (typeof conflict.conflict_id !== 'string') return []
        return [{
          source_record_id: typeof conflict.source_record_id === 'string' ? conflict.source_record_id : '',
          original_target_id: typeof conflict.original_target_id === 'string' ? conflict.original_target_id : '',
          conflict_id: conflict.conflict_id,
          name: typeof conflict.name === 'string' ? conflict.name : '',
          reason: typeof conflict.reason === 'string' ? conflict.reason : '',
          action: typeof conflict.action === 'string' ? conflict.action : '',
        }]
      })
      : [],
    skipped_ids: strings(result.skipped_ids),
    failed: strings(result.failed),
    item_ids: strings(result.item_ids),
    archive_path: result.archive_path || '',
    manifest_path: result.manifest_path || '',
    truncated: Boolean(result.truncated),
    management_mode: result.management_mode === 'unmanaged_direct' ? 'unmanaged_direct' : 'master_managed',
    status: result.status === 'pending_translation' || result.status === 'ready' ? result.status : 'instantiated',
    import_id: result.import_id || '',
    master_workspace: result.master_workspace || '',
    master_source_id: result.master_source_id || '',
    master_item_ids: strings(result.master_item_ids),
    translation_targets: Array.isArray(result.translation_targets)
      ? result.translation_targets.filter((target): target is MasterTranslationTarget => Boolean(target && typeof target === 'object' && typeof target.master_item_id === 'string' && typeof target.field_path === 'string'))
      : [],
  }
}

export function applyMasterTranslation(request: MasterTranslationApplyRequest): Promise<MasterTranslationApplyResponse> {
  return requestJSON('/api/workspace/import-material/master/translation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
}
