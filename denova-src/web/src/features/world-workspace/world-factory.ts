import type {
  WorldAssetBinding,
  WorldCharacter,
  WorldFaction,
  WorldLocation,
  WorldTimelineEntry,
} from './types'

/** 客户端生成 binding/实体 id（uuid）；服务端只校验不重建。 */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 角色模板绑定进入世界时生成独立实例，后续编辑不回写总资料库。 */
export function characterFromBinding(binding: WorldAssetBinding): WorldCharacter {
  return { id: newClientId(), bindingId: binding.bindingId, displayName: binding.nameSnapshot }
}

/** location 顶层资产绑定进入世界时生成地点实例，名称取薄快照，标签同步一次。 */
export function locationFromBinding(binding: WorldAssetBinding): WorldLocation {
  return { id: newClientId(), bindingId: binding.bindingId, name: binding.nameSnapshot, description: '', tags: [...binding.tagsSnapshot] }
}

/** faction 顶层资产绑定进入世界时生成势力实例。 */
export function factionFromBinding(binding: WorldAssetBinding): WorldFaction {
  return { id: newClientId(), bindingId: binding.bindingId, name: binding.nameSnapshot, description: '' }
}

export function emptyCharacter(displayName = ''): WorldCharacter {
  return { id: newClientId(), displayName }
}

export function emptyLocation(): WorldLocation {
  return { id: newClientId(), name: '', description: '' }
}

export function emptyFaction(): WorldFaction {
  return { id: newClientId(), name: '', description: '' }
}

export function emptyTimelineEntry(order: number): WorldTimelineEntry {
  return { id: newClientId(), order, title: '', category: 'canon' }
}

/** 供测试用：稳定的空世界草稿结构（创建走 CreateInput，不生成 id/时间）。 */
export function blankCreateInput() {
  return {
    name: '',
    tagline: '',
    genre: '',
    summary: '',
    worldSetting: { rules: [] as string[], tone: '' },
    bindings: [],
    characters: [],
    locations: [],
    factions: [],
    timeline: [],
  }
}
