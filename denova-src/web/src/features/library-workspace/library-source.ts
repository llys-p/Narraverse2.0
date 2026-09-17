import type { MasterAssetSummary, WorkLibraryItemInput } from '@/lib/api-client'

const ITEM_TYPES = new Set(['character', 'world', 'location', 'faction', 'rule', 'item', 'other'])

/** Master 原件只被引用，不复制正文，也不把本库设为原件的第二真源。 */
export function masterToReferenceInput(asset: MasterAssetSummary): WorkLibraryItemInput {
  return {
    name: asset.name,
    type: ITEM_TYPES.has(asset.semantic_type) ? asset.semantic_type : 'other',
    origin: 'reference',
    source: {
      kind: 'master', id: asset.master_item_id, revision: asset.master_revision || '', label: asset.name,
    },
    loadMode: 'auto',
    importance: 'important',
    tags: [...(asset.tags ?? [])],
  }
}
