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
  // 提案项的 sourceRefIds 解析为 masterItemId 集合（供实体↔绑定匹配）。
  const masterIdsOf = (sourceRefIds: string[]): string[] => {
    const out: string[] = []
    for (const id of sourceRefIds) {
      const ref = refById.get(id)
      if (ref && ref.kind === 'master_field' && ref.masterItemId) out.push(ref.masterItemId)
    }
    return out
  }

  const candidateByMasterId = new Map<string, ProposedBindingCandidate>()
  const bindingByCandidateId = new Map<string, WorldAssetBinding>()
  for (const c of proposal.bindingCandidates) {
    if (!choices.adoptedBindingCandidateIds.includes(c.bindingCandidateId)) continue
    candidateByMasterId.set(c.masterItemId, c)
    bindingByCandidateId.set(c.bindingCandidateId, bindingFromCandidate(c))
  }

  // 找到提案项匹配到的实体绑定候选（只绑定语义一致的候选）。
  const bindEntity = (sourceRefIds: string[], semantic: WorldAssetBinding['semanticType']): string | undefined => {
    for (const mid of masterIdsOf(sourceRefIds)) {
      const cand = candidateByMasterId.get(mid)
      if (cand && cand.semanticType === semantic && bindingByCandidateId.has(cand.bindingCandidateId)) {
        return bindingByCandidateId.get(cand.bindingCandidateId)!.bindingId
      }
    }
    return undefined
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

  // 世界设定：setting 采纳则汇总其采纳规则 + tone（可被 settingOverride.tone 覆盖）。
  let worldSetting: WorldSetting | undefined
  const adoptedRules: string[] = []
  if (proposal.setting && adopted(proposal.setting.proposalItemId)) {
    for (const r of proposal.setting.rules) {
      if (!adopted(r.proposalItemId)) continue
      const text = ((choices.edits[r.proposalItemId] as WorldEditableRule | undefined)?.text ?? r.text).trim()
      if (text) adoptedRules.push(text)
    }
  }
  const tone = choices.settingOverride?.tone ?? proposal.setting?.tone
  if (adoptedRules.length > 0 || (tone && tone.trim())) {
    worldSetting = { rules: adoptedRules, ...(tone && tone.trim() ? { tone: tone.trim() } : {}) }
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
