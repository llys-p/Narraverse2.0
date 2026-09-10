// Phase 2B.2：Proposal → WorldCreateInput 的确定性转换（纯函数，集中单测）。
// 规则（docs/plans/WORLD_WORKSPACE_PHASE2B2_IMPLEMENTATION_PLAN.md v1.2 §3.4）：
//   - bindingCandidateId 与 bindingId 区分：bindingId 在此处才生成；
//   - master 信息（recordKind/semanticType/masterItemId/masterRevision/scope）全部来自服务端盖章的 bindingCandidates；
//   - 绝不采用模型自由字段；只读服务端增强后的 proposal；
//   - entity 作用域绑定必须有采纳的实体引用，否则丢弃（避免后端“实体作用域绑定缺少实体引用”400）。
import { newClientId } from './world-factory'
import type {
  ProposalChoices,
  ProposedBindingCandidate,
  StructureProposal,
  WorldAssetBinding,
  WorldCharacter,
  WorldCreateInput,
  WorldEditableCharacter,
  WorldEditableFaction,
  WorldEditableLocation,
  WorldEditableRule,
  WorldFaction,
  WorldLocation,
  WorldSetting,
} from './types'

/** 由服务端盖章的绑定候选确定性生成 binding（bindingId 在确认时生成）。 */
export function bindingFromCandidate(candidate: ProposedBindingCandidate): WorldAssetBinding {
  return {
    bindingId: newClientId(),
    masterItemId: candidate.masterItemId,
    recordKind: candidate.recordKind,
    semanticType: candidate.semanticType,
    nameSnapshot: candidate.nameSnapshot,
    tagsSnapshot: candidate.tagsSnapshot ?? [],
    masterRevision: candidate.masterRevision,
    scope: candidate.scope,
    boundAt: new Date().toISOString(),
  }
}

export type ProposalBaseInput = Pick<
  WorldCreateInput,
  'name' | 'tagline' | 'genre' | 'summary' | 'coverColor' | 'primaryBookPath' | 'primaryInteractiveStoryId'
>

/**
 * 把用户确认后的 ProposalChoices 转换为一次性 WorldCreateInput。
 * 该函数是唯一读取 ProposalChoices 的地方；confidence/reason/sourceRefs 不进入 World。
 */
export function proposalToWorldCreateInput(
  proposal: StructureProposal,
  choices: ProposalChoices,
  base: ProposalBaseInput,
): WorldCreateInput {
  const adopted = (proposalItemId: string) => choices.decisions[proposalItemId] === 'adopt'

  const refById = new Map(proposal.sourceRefs.map((r) => [r.id, r]))
  // 提案项的 sourceRefIds 解析为**去重后的** masterItemId 集合（供实体↔绑定匹配）。
  const masterIdsOf = (sourceRefIds: string[]): string[] => {
    const seen = new Set<string>()
    for (const id of sourceRefIds) {
      const ref = refById.get(id)
      if (ref && ref.kind === 'master_field' && ref.masterItemId) seen.add(ref.masterItemId)
    }
    return [...seen]
  }

  const candidateByMasterId = new Map<string, ProposedBindingCandidate>()
  const bindingByCandidateId = new Map<string, WorldAssetBinding>()
  for (const c of proposal.bindingCandidates) {
    if (!choices.adoptedBindingCandidateIds.includes(c.bindingCandidateId)) continue
    candidateByMasterId.set(c.masterItemId, c)
    bindingByCandidateId.set(c.bindingCandidateId, bindingFromCandidate(c))
  }

  // 实体绑定：仅当该实体只来自**唯一一个** Master 来源时才自动绑定；
  // 多个来源综合出的实体（或仅来自用户片段）不自动绑定，交由用户后续手工处理。
  const bindEntity = (sourceRefIds: string[], semantic: WorldAssetBinding['semanticType']): string | undefined => {
    const masters = masterIdsOf(sourceRefIds)
    if (masters.length !== 1) return undefined
    const cand = candidateByMasterId.get(masters[0])
    if (!cand || cand.semanticType !== semantic || !bindingByCandidateId.has(cand.bindingCandidateId)) return undefined
    return bindingByCandidateId.get(cand.bindingCandidateId)!.bindingId
  }

  const usedBindingCandidateIds = new Set<string>()
  const characters: WorldCharacter[] = []
  for (const p of proposal.characters) {
    if (!adopted(p.proposalItemId)) continue
    const edit = choices.edits[p.proposalItemId] as WorldEditableCharacter | undefined
    const bindingId = bindEntity(p.sourceRefIds, 'character')
    if (bindingId) {
      for (const c of proposal.bindingCandidates) {
        if (bindingByCandidateId.get(c.bindingCandidateId)?.bindingId === bindingId) usedBindingCandidateIds.add(c.bindingCandidateId)
      }
    }
    characters.push({
      id: newClientId(),
      bindingId,
      displayName: edit?.displayName ?? p.displayName,
      role: edit?.role ?? p.role,
      worldNote: edit?.worldNote ?? p.worldNote,
    })
  }

  const locations: WorldLocation[] = []
  for (const p of proposal.locations) {
    if (!adopted(p.proposalItemId)) continue
    const edit = choices.edits[p.proposalItemId] as WorldEditableLocation | undefined
    const bindingId = bindEntity(p.sourceRefIds, 'location')
    if (bindingId) {
      for (const c of proposal.bindingCandidates) {
        if (bindingByCandidateId.get(c.bindingCandidateId)?.bindingId === bindingId) usedBindingCandidateIds.add(c.bindingCandidateId)
      }
    }
    locations.push({
      id: newClientId(),
      bindingId,
      name: edit?.name ?? p.name,
      description: edit?.description ?? p.description,
      tags: edit?.tags ?? p.tags,
    })
  }

  const factions: WorldFaction[] = []
  for (const p of proposal.factions) {
    if (!adopted(p.proposalItemId)) continue
    const edit = choices.edits[p.proposalItemId] as WorldEditableFaction | undefined
    const bindingId = bindEntity(p.sourceRefIds, 'faction')
    if (bindingId) {
      for (const c of proposal.bindingCandidates) {
        if (bindingByCandidateId.get(c.bindingCandidateId)?.bindingId === bindingId) usedBindingCandidateIds.add(c.bindingCandidateId)
      }
    }
    factions.push({
      id: newClientId(),
      bindingId,
      name: edit?.name ?? p.name,
      description: edit?.description ?? p.description,
    })
  }

  // 组装最终 bindings：entity 作用域绑定只有被采纳实体引用时才发出（避免悬空引用）。
  const bindings: WorldAssetBinding[] = []
  for (const c of proposal.bindingCandidates) {
    if (!choices.adoptedBindingCandidateIds.includes(c.bindingCandidateId)) continue
    const binding = bindingByCandidateId.get(c.bindingCandidateId)!
    if (binding.scope === 'entity' && !usedBindingCandidateIds.has(c.bindingCandidateId)) continue
    bindings.push(binding)
  }

  // 世界设定门控：未采纳 setting 时**不得**写入 tone/rules（settingOverride 一并不生效）。
  // 采纳 setting 后才汇总其被采纳的规则与 tone（tone 可被 settingOverride.tone 覆盖）。
  let worldSetting: WorldSetting | undefined
  if (proposal.setting && adopted(proposal.setting.proposalItemId)) {
    const adoptedRules: string[] = []
    for (const r of proposal.setting.rules) {
      if (!adopted(r.proposalItemId)) continue
      const text = ((choices.edits[r.proposalItemId] as WorldEditableRule | undefined)?.text ?? r.text).trim()
      if (text) adoptedRules.push(text)
    }
    const tone = (choices.settingOverride?.tone ?? proposal.setting.tone ?? '').trim()
    if (adoptedRules.length > 0 || tone) {
      worldSetting = { rules: adoptedRules, ...(tone ? { tone } : {}) }
    }
  }

  return {
    name: base.name,
    tagline: base.tagline,
    genre: base.genre,
    summary: base.summary,
    coverColor: base.coverColor,
    primaryBookPath: base.primaryBookPath,
    primaryInteractiveStoryId: base.primaryInteractiveStoryId,
    worldSetting,
    bindings,
    characters,
    locations,
    factions,
  }
}

/** 创建向导草稿中会被 AI 提案影响的部分（用户已有输入必须保留）。 */
export interface CreateDraft {
  bindings: WorldAssetBinding[]
  characters: WorldCharacter[]
  locations: WorldLocation[]
  factions: WorldFaction[]
  tone: string
  rules: string[]
}

export const EMPTY_CREATE_DRAFT: CreateDraft = {
  bindings: [],
  characters: [],
  locations: [],
  factions: [],
  tone: '',
  rules: [],
}

/**
 * 把 AI 应用结果**合并**进用户已有草稿：保留用户输入，AI 结果只做增量。
 * - binding 按 masterItemId 去重（一个世界一个 masterItemId 一个 binding）；重复时复用既有 bindingId，
 *   并重映射 AI 实体的 bindingId，避免悬空引用导致后端 400；
 * - 实体按 `bindingId|名称` 去重后追加，用户已有实体一律保留；
 * - tone 仅在用户未填写时采用 AI 值；rules 取并集（用户已有优先，去重）。
 */
export function mergeProposalIntoDraft(draft: CreateDraft, input: WorldCreateInput): CreateDraft {
  const bindings: WorldAssetBinding[] = [...draft.bindings]
  const bindingIdByMaster = new Map(bindings.map((b) => [b.masterItemId, b.bindingId]))
  const idRemap = new Map<string, string>()

  for (const incoming of input.bindings ?? []) {
    const existingBindingId = bindingIdByMaster.get(incoming.masterItemId)
    if (existingBindingId) {
      idRemap.set(incoming.bindingId, existingBindingId)
      continue
    }
    bindingIdByMaster.set(incoming.masterItemId, incoming.bindingId)
    idRemap.set(incoming.bindingId, incoming.bindingId)
    bindings.push(incoming)
  }
  const remap = (bindingId?: string) => (bindingId ? idRemap.get(bindingId) ?? bindingId : undefined)

  const characters: WorldCharacter[] = [...draft.characters]
  const characterKeys = new Set(characters.map((c) => `${c.bindingId ?? ''}|${c.displayName}`))
  for (const incoming of input.characters ?? []) {
    const merged = { ...incoming, bindingId: remap(incoming.bindingId) }
    const key = `${merged.bindingId ?? ''}|${merged.displayName}`
    if (characterKeys.has(key)) continue
    characterKeys.add(key)
    characters.push(merged)
  }

  const locations: WorldLocation[] = [...draft.locations]
  const locationKeys = new Set(locations.map((l) => `${l.bindingId ?? ''}|${l.name}`))
  for (const incoming of input.locations ?? []) {
    const merged = { ...incoming, bindingId: remap(incoming.bindingId) }
    const key = `${merged.bindingId ?? ''}|${merged.name}`
    if (locationKeys.has(key)) continue
    locationKeys.add(key)
    locations.push(merged)
  }

  const factions: WorldFaction[] = [...draft.factions]
  const factionKeys = new Set(factions.map((f) => `${f.bindingId ?? ''}|${f.name}`))
  for (const incoming of input.factions ?? []) {
    const merged = { ...incoming, bindingId: remap(incoming.bindingId) }
    const key = `${merged.bindingId ?? ''}|${merged.name}`
    if (factionKeys.has(key)) continue
    factionKeys.add(key)
    factions.push(merged)
  }

  const incomingTone = (input.worldSetting?.tone ?? '').trim()
  const tone = draft.tone.trim() ? draft.tone : incomingTone
  // 用户未填写任何规则时丢弃空占位行，直接采用 AI 规则；否则保留用户规则并追加 AI 规则（去重）。
  const rules = draft.rules.some((r) => r.trim()) ? [...draft.rules] : []
  const ruleSet = new Set(rules.map((r) => r.trim()).filter(Boolean))
  for (const rule of input.worldSetting?.rules ?? []) {
    const text = rule.trim()
    if (text && !ruleSet.has(text)) {
      ruleSet.add(text)
      rules.push(text)
    }
  }

  return { bindings, characters, locations, factions, tone, rules }
}
