import { fetchAPI, jsonHeaders, parseSSEStream, readErrorMessage, requestJSON } from './client'
import type { LoreClassificationApplyRequest, LoreClassificationPreview, LoreClassificationPreviewRequest, LoreImagesGenerateRequest, LoreItem, LoreItemImageGenerateRequest, LoreItemInput, LoreTypeApplyResult, SSEEvent } from './types'

export async function getLoreItems(): Promise<LoreItem[]> {
  const data = await requestJSON<{ items: LoreItem[] }>('/api/lore/items')
  return data.items || []
}

export async function createLoreItem(item: Partial<LoreItemInput>, workspace?: string): Promise<LoreItem> {
  return requestJSON('/api/lore/items', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ ...item, ...(workspace ? { workspace } : {}) }),
  })
}

export async function updateLoreItem(id: string, item: Partial<LoreItemInput>, baseRevision?: string, workspace?: string): Promise<LoreItem> {
  return requestJSON(`/api/lore/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ ...item, ...(baseRevision ? { base_revision: baseRevision } : {}), ...(workspace ? { workspace } : {}) }),
  })
}

/**
 * 删除可携带目标书籍身份：服务端在当前书与请求书籍不一致时返回 409，
 * 避免切书后仍在途的删除请求写到另一本书。省略 workspace 时保持既有行为。
 */
export async function deleteLoreItem(id: string, workspace?: string): Promise<void> {
  await requestJSON(`/api/lore/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...(workspace ? { headers: jsonHeaders, body: JSON.stringify({ workspace }) } : {}),
  })
}

export async function previewLoreClassification(input: LoreClassificationPreviewRequest = {}): Promise<LoreClassificationPreview> {
  return requestJSON('/api/lore/classification/preview', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

export async function applyLoreClassification(input: LoreClassificationApplyRequest): Promise<LoreTypeApplyResult> {
  return requestJSON('/api/lore/classification/apply', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

export interface BookOverviewOrganizeUsage {
  resident_count: number
  selected_ids: string[]
  unknown_ids?: string[]
  include_outline: boolean
  outline_found: boolean
  draft_chars: number
  missing: string[]
}

export interface BookOverviewOrganizeResult {
  draft: string
  used: BookOverviewOrganizeUsage
}

export async function organizeBookOverview(input: {
  current_draft: string
  selected_lore_ids: string[]
  include_outline: boolean
}): Promise<BookOverviewOrganizeResult> {
  return requestJSON('/api/book/overview/organize', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
}

export async function generateLoreItemImage(id: string, input: LoreItemImageGenerateRequest = {}, workspace?: string): Promise<LoreItem> {
  return requestJSON(`/api/lore/items/${encodeURIComponent(id)}/image/generate`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ ...input, ...(workspace ? { workspace } : {}) }),
  })
}

export async function clearLoreItemImage(id: string, workspace?: string): Promise<LoreItem> {
  return requestJSON(`/api/lore/items/${encodeURIComponent(id)}/image`, {
    method: 'DELETE',
    ...(workspace ? { headers: jsonHeaders, body: JSON.stringify({ workspace }) } : {}),
  })
}

export async function uploadLoreItemImages(id: string, workspace: string, files: File[]): Promise<LoreItem> {
  const form = new FormData()
  form.append('workspace', workspace)
  files.forEach((file) => form.append('files', file))
  return requestJSON(`/api/lore/items/${encodeURIComponent(id)}/images`, {
    method: 'POST',
    body: form,
  })
}

export async function removeLoreItemImage(id: string, workspace: string, imagePath: string): Promise<LoreItem> {
  return requestJSON(`/api/lore/items/${encodeURIComponent(id)}/images`, {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ workspace, image_path: imagePath }),
  })
}

export async function streamLoreImagesGenerate(input: LoreImagesGenerateRequest, signal?: AbortSignal): Promise<ReadableStream<SSEEvent>> {
  const res = await fetchAPI('/api/lore/images/generate/stream', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
    signal,
  })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res))
  }
  if (!res.body) {
    throw new Error('No response stream')
  }
  return parseSSEStream(res.body)
}

export async function abortLoreImagesGenerate(): Promise<void> {
  await requestJSON('/api/lore/images/generate/abort', { method: 'POST' })
}
