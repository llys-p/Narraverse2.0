import { jsonHeaders, requestJSON } from './client'

/** 构思草稿：书籍创建前的可恢复草稿，确认之前不会出现在书目或任何书籍资料里。 */
export type IdeationOrigin = 'source' | 'user' | 'ai'
export type IdeationScope = 'all' | 'overview' | 'items' | 'relation'

export interface IdeationSourceEntry {
  id: string
  name: string
  content: string
  keywords?: string[]
  role?: string
  truncated?: boolean
}

export interface IdeationSource {
  id: string
  kind: 'lorebook' | 'character_card'
  name: string
  file_name?: string
  content_hash: string
  entries: IdeationSourceEntry[]
  warnings?: string[]
  added_at: string
}

export interface IdeationTurn {
  role: 'user' | 'assistant'
  content: string
  at: string
  generated?: boolean
}

export interface IdeationDirection {
  summary: string
  genre?: string
  tone?: string
  conflict?: string
  cast?: string[]
  updated_by?: string
  updated_at?: string
}

export interface IdeationCandidateItem {
  ref: string
  name: string
  type: string
  content: string
  brief_description?: string
  keywords?: string[]
  load_mode: 'resident' | 'auto' | 'manual'
  character_tier?: string
  origin: IdeationOrigin
  source_refs?: string[]
  open_notes?: string
  excluded?: boolean
  edited_by_user?: boolean
}

export interface IdeationCandidateRelation {
  ref: string
  source_ref: string
  target_ref: string
  label: string
  note?: string
  origin: IdeationOrigin
  source_refs?: string[]
  excluded?: boolean
}

export interface IdeationCandidatePackage {
  title?: string
  book_name_suggestions?: string[]
  synopsis?: string
  overview: string
  items: IdeationCandidateItem[]
  relations?: IdeationCandidateRelation[]
  open_questions?: string[]
  keep_source_entries?: string[]
  generated_at?: string
  direction_revision?: number
  revision?: number
}

export interface IdeationCommitStage {
  name: string
  status: 'pending' | 'done'
  detail?: string
  finished_at?: string
}

export interface IdeationCommitReceipt {
  draft_id: string
  status: 'complete' | 'incomplete'
  workspace_path?: string
  title: string
  stages: IdeationCommitStage[]
  item_ids?: Record<string, string>
  overview_revision?: string
  message: string
}

export interface IdeationDraft {
  id: string
  status: 'ideating' | 'committed' | 'abandoned'
  created_at: string
  updated_at: string
  locale?: string
  idea?: string
  title?: string
  author?: string
  description?: string
  sources: IdeationSource[]
  turns: IdeationTurn[]
  direction: IdeationDirection
  direction_revision: number
  candidates?: IdeationCandidatePackage | null
  commit?: {
    request_id: string
    title: string
    workspace_path?: string
    stages: IdeationCommitStage[]
    item_ids?: Record<string, string>
    overview_revision?: string
    created_at: string
    completed_at?: string
  }
}

export interface IdeationDraftListEntry {
  id: string
  status: string
  title?: string
  idea?: string
  source_count: number
  turn_count: number
  has_candidates: boolean
  commit_stage?: string
  created_at: string
  updated_at: string
}

export interface IdeationDraftResult {
  draft: IdeationDraft
  revision: string
  model_error?: string
}

export interface IdeationCommitResult {
  receipt: IdeationCommitReceipt
  draft: IdeationDraft
}

/** 候选包在传输时只带服务端认识的字段，避免前端展示字段变成后端契约。 */
export function toCandidatePayload(pkg: IdeationCandidatePackage) {
  return {
    title: pkg.title ?? '',
    book_name_suggestions: pkg.book_name_suggestions ?? [],
    synopsis: pkg.synopsis ?? '',
    overview: pkg.overview,
    items: pkg.items.map((item) => ({
      ref: item.ref,
      name: item.name,
      type: item.type,
      content: item.content,
      brief_description: item.brief_description ?? '',
      keywords: item.keywords ?? [],
      load_mode: item.load_mode,
      character_tier: item.character_tier ?? '',
      origin: item.origin,
      source_refs: item.source_refs ?? [],
      open_notes: item.open_notes ?? '',
      excluded: Boolean(item.excluded),
    })),
    relations: (pkg.relations ?? []).map((relation) => ({
      ref: relation.ref,
      source_ref: relation.source_ref,
      target_ref: relation.target_ref,
      label: relation.label,
      note: relation.note ?? '',
      origin: relation.origin,
      source_refs: relation.source_refs ?? [],
      excluded: Boolean(relation.excluded),
    })),
    open_questions: pkg.open_questions ?? [],
    keep_source_entries: pkg.keep_source_entries ?? [],
  }
}

const draftPath = (id: string) => `/api/book-ideation/drafts/${encodeURIComponent(id)}`

export async function createIdeationDraft(input: { idea: string; locale: string }): Promise<IdeationDraftResult> {
  return requestJSON('/api/book-ideation/drafts', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ idea: input.idea, locale: input.locale }),
  })
}

export async function listIdeationDrafts(): Promise<IdeationDraftListEntry[]> {
  const data = await requestJSON<{ drafts?: IdeationDraftListEntry[] }>('/api/book-ideation/drafts')
  return data.drafts ?? []
}

export async function getIdeationDraft(id: string): Promise<IdeationDraftResult> {
  return requestJSON(draftPath(id))
}

export async function updateIdeationDraft(
  id: string,
  baseRevision: string,
  patch: {
    title?: string
    author?: string
    description?: string
    idea?: string
    direction?: { summary?: string; genre?: string; tone?: string; conflict?: string; cast?: string[] }
  },
): Promise<IdeationDraftResult> {
  const body: Record<string, unknown> = { base_revision: baseRevision }
  for (const key of ['title', 'author', 'description', 'idea'] as const) {
    if (patch[key] !== undefined) body[key] = patch[key]
  }
  if (patch.direction) body.direction = patch.direction
  return requestJSON(draftPath(id), { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body) })
}

export async function addIdeationSource(input: {
  id: string
  baseRevision: string
  fileName: string
  content: string
}): Promise<IdeationDraftResult> {
  return requestJSON(draftPath(input.id) + '/sources', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      base_revision: input.baseRevision,
      file_name: input.fileName,
      content: input.content,
    }),
  })
}

export async function removeIdeationSource(input: {
  id: string
  baseRevision: string
  sourceId: string
}): Promise<IdeationDraftResult> {
  return requestJSON(`${draftPath(input.id)}/sources/${encodeURIComponent(input.sourceId)}/remove`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ base_revision: input.baseRevision }),
  })
}

export async function sendIdeationMessage(input: {
  id: string
  baseRevision: string
  content: string
}): Promise<IdeationDraftResult> {
  return requestJSON(`${draftPath(input.id)}/messages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ base_revision: input.baseRevision, content: input.content }),
  })
}

export async function generateIdeationCandidates(input: {
  id: string
  baseRevision: string
  scope: IdeationScope
  refs?: string[]
}): Promise<IdeationDraftResult> {
  return requestJSON(`${draftPath(input.id)}/generate`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      base_revision: input.baseRevision,
      scope: input.scope,
      refs: input.refs ?? [],
    }),
  })
}

export async function saveIdeationCandidates(input: {
  id: string
  baseRevision: string
  package: IdeationCandidatePackage
}): Promise<IdeationDraftResult> {
  return requestJSON(`${draftPath(input.id)}/candidates`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({
      base_revision: input.baseRevision,
      package: toCandidatePayload(input.package),
    }),
  })
}

export async function commitIdeationDraft(input: {
  id: string
  baseRevision: string
  requestId: string
}): Promise<IdeationCommitResult> {
  return requestJSON(`${draftPath(input.id)}/commit`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ base_revision: input.baseRevision, request_id: input.requestId }),
  })
}

export async function abandonIdeationDraft(id: string, baseRevision: string): Promise<IdeationDraftResult> {
  return requestJSON(`${draftPath(id)}/abandon`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ base_revision: baseRevision }),
  })
}
