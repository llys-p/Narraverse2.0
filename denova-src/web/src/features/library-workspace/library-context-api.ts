import { jsonHeaders, requestJSON } from '@/lib/api-client/client'
import type { WorkLibraryEventDetail, WorkLibraryRelation } from '@/lib/api-client'

/** L2 preview wire contract; no runtime/model control fields. */
export interface LibraryPreviewRequest {
  expectedRevision: string
  manualItemIds: string[]
  autoItemIds: string[]
  catalogOffset: number
  catalogLimit: number
}
export interface LibraryPreview {
  libraryId: string
  revision: string
  name: string
  summary: string
  tone: string
  startingPoint: string
  catalog: {
    items: { itemId: string; name: string; type: string; briefDescription?: string; tags: string[]; keywords: string[] }[]
    total: number
    offset: number
    nextOffset?: number
  }
  loaded: { itemId: string; name: string; type: string; loadMode: string; origin: string; content: string;
    fields: Record<string, string>; event?: WorkLibraryEventDetail; sourceRevision?: string }[]
  relations: WorkLibraryRelation[]
  issues: { itemId: string; code: string }[]
  budget: { bytes: number; estimatedTokens: number; maxBytes: number; maxEstimatedTokens: number }
}
export function previewWorkLibrary(id: string, request: LibraryPreviewRequest): Promise<LibraryPreview> {
  return requestJSON(`/api/work-libraries/${encodeURIComponent(id)}/context-preview`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify(request),
  })
}
