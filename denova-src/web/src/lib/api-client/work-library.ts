import { jsonHeaders, requestJSON } from './client'

// 作品设定库（L1）前端 wire 类型与调用。
//
// 命名空间 `/api/work-libraries` 与既有 `/api/library/*`（Master 公共素材）刻意区分：
// 这里是用户自己的作品设定库，与书籍和 World 无关，因此在没有书的状态下也能调用。
//
// 字段名与 `denova-src/internal/library/types.go` 的 JSON tag 一一对应；
// 词表（类型/档位/来源类型…）由服务端下发，前端不硬编码，避免“UI 能选但保存被拒”。

export type WorkLibraryLoadMode = 'resident' | 'auto' | 'manual'
export type WorkLibraryOrigin = 'original' | 'adaptation' | 'reference'
export type WorkLibraryPurpose = 'any' | 'writing' | 'game' | 'narraverse' | 'sandbox' | 'mixed'

export interface WorkLibrarySourceRef {
  kind: string
  id?: string
  revision?: string
  locator?: string
  label?: string
  /** 服务端核对的派生标记：来源版本可能已变化。客户端只读。 */
  updated?: boolean
}

export interface WorkLibraryEventDetail {
  order: number
  era: string
  category: string
  participantItemIds?: string[]
  locationItemId?: string
}

export interface WorkLibraryItem {
  id: string
  enabled: boolean
  type: string
  typeSource?: string
  name: string
  importance: string
  tags?: string[]
  briefDescription?: string
  keywords?: string[]
  loadMode: WorkLibraryLoadMode
  content?: string
  origin: WorkLibraryOrigin
  source?: WorkLibrarySourceRef | null
  fields?: Record<string, string> | null
  event?: WorkLibraryEventDetail | null
  createdAt: string
  updatedAt: string
}

export interface WorkLibraryRelation {
  id: string
  fromItemId: string
  toItemId: string
  kind: string
  label?: string
  note?: string
  since?: string
  until?: string
  createdAt: string
  updatedAt: string
}

export interface WorkLibrary {
  id: string
  schemaVersion: number
  name: string
  summary?: string
  purpose: WorkLibraryPurpose | string
  tone?: string
  startingPoint?: string
  items: WorkLibraryItem[]
  relations: WorkLibraryRelation[]
  createdAt: string
  updatedAt: string
}

export interface WorkLibrarySummary {
  id: string
  name: string
  summary?: string
  purpose: string
  tone?: string
  itemCount: number
  eventCount: number
  relationCount: number
  referenceCount: number
  residentCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkLibraryLoadWarning {
  file: string
  id?: string
  reason: string
}

export interface WorkLibraryEnvelope {
  library: WorkLibrary
  revision: string
}

export interface WorkLibraryListEnvelope {
  libraries: WorkLibrarySummary[]
  warnings: WorkLibraryLoadWarning[]
}

export interface WorkLibraryTimelineEntry {
  itemId: string
  title: string
  era: string
  order: number
  category: string
  enabled: boolean
  summary?: string
  participants?: string[]
  locationId?: string
}

export interface WorkLibraryImpact {
  itemId: string
  itemName: string
  relations: WorkLibraryRelation[]
  relationsCount?: number
  events: WorkLibraryTimelineEntry[]
}

export interface WorkLibraryItemInput {
  id?: string
  enabled?: boolean
  type?: string
  typeSource?: string
  name?: string
  importance?: string
  tags?: string[]
  briefDescription?: string
  keywords?: string[]
  loadMode?: string
  content?: string
  origin?: string
  source?: WorkLibrarySourceRef | null
  fields?: Record<string, string> | null
  event?: WorkLibraryEventDetail | null
  /** 条目级并发基线：服务端条目 updatedAt；不一致返回 409 revision_conflict。 */
  baseUpdatedAt?: string
}

export interface WorkLibraryRelationInput {
  id?: string
  fromItemId?: string
  toItemId?: string
  kind?: string
  label?: string
  note?: string
  since?: string
  until?: string
}

export interface WorkLibraryMetaPatch {
  name?: string
  summary?: string
  purpose?: string
  tone?: string
  startingPoint?: string
}

export interface WorkLibraryVocabulary {
  itemTypes: string[]
  baseItemTypes: string[]
  loadModes: string[]
  importanceLevels: string[]
  origins: string[]
  sourceKinds: string[]
  relationKinds: string[]
  eventCategories: string[]
  purposes: string[]
}

export interface WorkLibraryItemMutationEnvelope {
  item: WorkLibraryItem
  revision: string
}

export interface WorkLibraryRelationMutationEnvelope {
  relation: WorkLibraryRelation
  revision: string
}

export interface WorkLibraryDeleteItemResult {
  deletedId: string
  removedRelationIds: string[]
  updatedEventIds: string[]
  revision: string
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

/** GET /api/work-libraries —— 列表 + 损坏文件告警。 */
export function listWorkLibraries(): Promise<WorkLibraryListEnvelope> {
  return requestJSON<WorkLibraryListEnvelope>('/api/work-libraries')
}

/** GET /api/work-libraries/vocabulary —— 服务端词表。 */
export async function fetchWorkLibraryVocabulary(): Promise<WorkLibraryVocabulary> {
  const data = await requestJSON<{ vocabulary: WorkLibraryVocabulary }>('/api/work-libraries/vocabulary')
  return data.vocabulary
}

/** GET /api/work-libraries/:id —— 库详情与当前 revision。 */
export function getWorkLibrary(id: string): Promise<WorkLibraryEnvelope> {
  return requestJSON<WorkLibraryEnvelope>(`/api/work-libraries/${encode(id)}`)
}

/** POST /api/work-libraries —— 创建独立库（不需要先建书）。 */
export function createWorkLibrary(input: {
  name: string
  summary?: string
  purpose?: string
  tone?: string
  startingPoint?: string
}): Promise<WorkLibraryEnvelope> {
  return requestJSON<WorkLibraryEnvelope>('/api/work-libraries', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

/** PATCH /api/work-libraries/:id —— 库元信息 CAS 保存。 */
export function updateWorkLibraryMeta(
  id: string,
  expectedRevision: string,
  patch: WorkLibraryMetaPatch,
): Promise<WorkLibraryEnvelope> {
  return requestJSON<WorkLibraryEnvelope>(`/api/work-libraries/${encode(id)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ expected_revision: expectedRevision, patch }),
  })
}

/** DELETE /api/work-libraries/:id —— 删库需要 expected_revision。 */
export function deleteWorkLibrary(id: string, expectedRevision: string): Promise<{ deleted: boolean }> {
  return requestJSON(`/api/work-libraries/${encode(id)}?expected_revision=${encode(expectedRevision)}`, {
    method: 'DELETE',
  })
}

/** GET /api/work-libraries/:id/timeline —— 由事件条目派生的时间线。 */
export async function getWorkLibraryTimeline(id: string): Promise<WorkLibraryTimelineEntry[]> {
  const data = await requestJSON<{ timeline: WorkLibraryTimelineEntry[] }>(`/api/work-libraries/${encode(id)}/timeline`)
  return data.timeline ?? []
}

/** POST /api/work-libraries/:id/items —— 新建条目。 */
export function createWorkLibraryItem(
  id: string,
  input: WorkLibraryItemInput,
): Promise<WorkLibraryItemMutationEnvelope> {
  return requestJSON<WorkLibraryItemMutationEnvelope>(`/api/work-libraries/${encode(id)}/items`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

/** PATCH /api/work-libraries/:id/items/:itemId —— 保存条目（条目级 CAS）。 */
export function updateWorkLibraryItem(
  id: string,
  itemId: string,
  input: WorkLibraryItemInput,
): Promise<WorkLibraryItemMutationEnvelope> {
  return requestJSON<WorkLibraryItemMutationEnvelope>(
    `/api/work-libraries/${encode(id)}/items/${encode(itemId)}`,
    { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(input) },
  )
}

/** DELETE /api/work-libraries/:id/items/:itemId[?cascade=true] */
export function deleteWorkLibraryItem(
  id: string,
  itemId: string,
  cascade: boolean,
): Promise<WorkLibraryDeleteItemResult> {
  const suffix = cascade ? '?cascade=true' : ''
  return requestJSON<WorkLibraryDeleteItemResult>(
    `/api/work-libraries/${encode(id)}/items/${encode(itemId)}${suffix}`,
    { method: 'DELETE' },
  )
}

/** GET /api/work-libraries/:id/items/:itemId/impact —— 删除前影响预览。 */
export async function getWorkLibraryItemImpact(id: string, itemId: string): Promise<WorkLibraryImpact> {
  const data = await requestJSON<{ impact: WorkLibraryImpact }>(
    `/api/work-libraries/${encode(id)}/items/${encode(itemId)}/impact`,
  )
  return data.impact
}

/** POST /api/work-libraries/:id/relations —— 新建库内关系。 */
export function createWorkLibraryRelation(
  id: string,
  input: WorkLibraryRelationInput,
): Promise<WorkLibraryRelationMutationEnvelope> {
  return requestJSON<WorkLibraryRelationMutationEnvelope>(`/api/work-libraries/${encode(id)}/relations`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

/** PATCH /api/work-libraries/:id/relations/:relationId */
export function updateWorkLibraryRelation(
  id: string,
  relationId: string,
  input: WorkLibraryRelationInput,
): Promise<WorkLibraryRelationMutationEnvelope> {
  return requestJSON<WorkLibraryRelationMutationEnvelope>(
    `/api/work-libraries/${encode(id)}/relations/${encode(relationId)}`,
    { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(input) },
  )
}

/** DELETE /api/work-libraries/:id/relations/:relationId */
export function deleteWorkLibraryRelation(id: string, relationId: string): Promise<{ deleted: boolean; revision: string }> {
  return requestJSON(`/api/work-libraries/${encode(id)}/relations/${encode(relationId)}`, { method: 'DELETE' })
}
