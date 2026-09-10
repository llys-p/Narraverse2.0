import { describe, expect, it } from 'vitest'
import { mergeProposalIntoDraft, proposalToWorldCreateInput } from '../world-proposal'
import type {
  ProposalChoices,
  StructureProposal,
  WorldAssetBinding,
  WorldCharacter,
  WorldCreateInput,
} from '../types'

const BASE: WorldCreateInput = {
  name: '测试世界',
  tagline: '一句话',
  genre: '玄幻',
  summary: '概述',
  coverColor: '#64748b',
}

function proposal(overrides: Partial<StructureProposal> = {}): StructureProposal {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-10T00:00:00Z',
    sourceRefs: [
      { id: 's0', kind: 'master_field', masterItemId: 'char-1', masterRevision: 'sha256:x', fieldPath: 'character.name', label: '艾兰妮' },
      { id: 's1', kind: 'master_field', masterItemId: 'lore-1', masterRevision: 'sha256:y', fieldPath: 'lorebook.name', label: '僵尸末日生存' },
    ],
    bindingCandidates: [
      { bindingCandidateId: 'bc-char', recordKind: 'character_template', semanticType: 'character', masterItemId: 'char-1', nameSnapshot: '艾兰妮', tagsSnapshot: [], masterRevision: 'sha256:x', scope: 'entity' },
      { bindingCandidateId: 'bc-lore', recordKind: 'lorebook_template', semanticType: 'other', masterItemId: 'lore-1', nameSnapshot: '僵尸末日生存', tagsSnapshot: [], masterRevision: 'sha256:y', scope: 'world' },
    ],
    setting: {
      proposalItemId: 'set-1',
      sourceRefIds: ['s1'],
      confidence: 'medium',
      tone: '黑暗',
      rules: [{ proposalItemId: 'rule-1', sourceRefIds: ['s1'], confidence: 'low', text: '魔法有代价' }],
    },
    characters: [
      { proposalItemId: 'char-1', sourceRefIds: ['s0'], confidence: 'high', displayName: '艾兰妮', role: 'major' },
    ],
    locations: [],
    factions: [],
    ...overrides,
  }
}

function choices(overrides: Partial<ProposalChoices> = {}): ProposalChoices {
  return {
    decisions: {},
    adoptedBindingCandidateIds: [],
    edits: {},
    ...overrides,
  }
}

describe('proposalToWorldCreateInput', () => {
  it('entity binding requires an adopted entity reference; bindingId ≠ bindingCandidateId', () => {
    const p = proposal()
    const c = choices({
      decisions: { 'char-1': 'adopt' },
      adoptedBindingCandidateIds: ['bc-char'],
    })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.bindings ?? []).toHaveLength(1)
    const binding = (input.bindings ?? [])[0]
    expect(binding.bindingId).not.toBe('bc-char') // bindingId 与 bindingCandidateId 区分
    expect(binding.masterItemId).toBe('char-1') // master 信息来自服务端盖章
    expect(binding.recordKind).toBe('character_template')
    expect(binding.scope).toBe('entity')
    expect(input.characters ?? []).toHaveLength(1)
    expect((input.characters ?? [])[0].bindingId).toBe(binding.bindingId)
  })

  it('drops an adopted entity binding with no adopted entity reference', () => {
    const p = proposal()
    const c = choices({ adoptedBindingCandidateIds: ['bc-char'] }) // 未采纳角色
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.bindings ?? []).toHaveLength(0)
    expect(input.characters ?? []).toHaveLength(0)
  })

  it('world-scope binding is retained with zero entity reference', () => {
    const p = proposal()
    const c = choices({ adoptedBindingCandidateIds: ['bc-lore'] })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.bindings ?? []).toHaveLength(1)
    expect((input.bindings ?? [])[0].scope).toBe('world')
    expect((input.bindings ?? [])[0].semanticType).toBe('other')
  })

  it('adopts setting + only adopted rules, and applies rule text edit', () => {
    const p = proposal()
    const c = choices({
      decisions: { 'set-1': 'adopt', 'rule-1': 'adopt' },
      edits: { 'rule-1': { text: '魔法必然有代价' } },
    })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.worldSetting).toBeDefined()
    expect(input.worldSetting!.tone).toBe('黑暗')
    expect(input.worldSetting!.rules).toEqual(['魔法必然有代价'])
  })

  it('采纳 setting 时 settingOverride.tone 覆盖 AI 基调，未采纳规则仍为空', () => {
    const p = proposal()
    const c = choices({ decisions: { 'set-1': 'adopt' }, settingOverride: { tone: '轻松' } })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.worldSetting?.tone).toBe('轻松')
    expect(input.worldSetting?.rules).toEqual([])
  })

  it('character edits only affect world-editable fields', () => {
    const p = proposal()
    const c = choices({
      decisions: { 'char-1': 'adopt' },
      adoptedBindingCandidateIds: ['bc-char'],
      edits: { 'char-1': { displayName: '改名', role: 'npc', worldNote: '备注' } },
    })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect((input.characters ?? [])[0].displayName).toBe('改名')
    expect((input.characters ?? [])[0].role).toBe('npc')
    expect((input.characters ?? [])[0].worldNote).toBe('备注')
  })

  it('carries base fields through to the create input', () => {
    const input = proposalToWorldCreateInput(proposal(), choices(), BASE)
    expect(input.name).toBe('测试世界')
    expect(input.genre).toBe('玄幻')
  })

  // ---- 修复任务 B：setting 采纳门控 ----

  it('未采纳 setting 时不写入 tone/rules（settingOverride 亦不生效）', () => {
    const p = proposal()
    const c = choices({
      decisions: { 'rule-1': 'adopt' }, // setting 未采纳，仅规则被采纳
      edits: { 'rule-1': { text: '被采纳的规则' } },
      settingOverride: { tone: '用户改的基调' },
    })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.worldSetting).toBeUndefined()
  })

  it('采纳 setting 时才写入 tone 与已采纳规则', () => {
    const p = proposal()
    const c = choices({ decisions: { 'set-1': 'adopt', 'rule-1': 'adopt' } })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.worldSetting?.tone).toBe('黑暗')
    expect(input.worldSetting?.rules).toEqual(['魔法有代价'])
  })

  // ---- 修复任务 B：多来源实体不自动绑定 ----

  it('实体只来自唯一 Master 来源时允许生成 binding', () => {
    const p = proposal()
    const c = choices({ decisions: { 'char-1': 'adopt' }, adoptedBindingCandidateIds: ['bc-char'] })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.characters?.[0].bindingId).toBeDefined()
    expect(input.bindings).toHaveLength(1)
  })

  it('实体来自多个 Master 来源时不自动绑定（binding 候选一并丢弃）', () => {
    const p = proposal({
      sourceRefs: [
        { id: 's0', kind: 'master_field', masterItemId: 'char-1', masterRevision: 'sha256:x', fieldPath: 'character.name', label: 'A' },
        { id: 's1', kind: 'master_field', masterItemId: 'char-2', masterRevision: 'sha256:y', fieldPath: 'character.name', label: 'B' },
      ],
      bindingCandidates: [
        { bindingCandidateId: 'bc-1', recordKind: 'character_template', semanticType: 'character', masterItemId: 'char-1', nameSnapshot: 'A', tagsSnapshot: [], masterRevision: 'sha256:x', scope: 'entity' },
        { bindingCandidateId: 'bc-2', recordKind: 'character_template', semanticType: 'character', masterItemId: 'char-2', nameSnapshot: 'B', tagsSnapshot: [], masterRevision: 'sha256:y', scope: 'entity' },
      ],
      characters: [
        { proposalItemId: 'char-1', sourceRefIds: ['s0', 's1'], confidence: 'high', displayName: '综合角色' },
      ],
    })
    const c = choices({ decisions: { 'char-1': 'adopt' }, adoptedBindingCandidateIds: ['bc-1', 'bc-2'] })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.characters).toHaveLength(1)
    expect(input.characters?.[0].bindingId).toBeUndefined()
    expect(input.bindings).toEqual([])
  })
})

// ---- 修复任务 B：合并策略（保留用户已有草稿） ----

function manualBinding(masterItemId: string, bindingId: string, name: string): WorldAssetBinding {
  return {
    bindingId, masterItemId, recordKind: 'character_template', semanticType: 'character',
    nameSnapshot: name, tagsSnapshot: [], masterRevision: 'sha256:' + masterItemId,
    scope: 'entity', boundAt: '2026-09-10T00:00:00Z',
  }
}

describe('mergeProposalIntoDraft', () => {
  it('手动角色与 AI 角色同时存在（不覆盖用户草稿）', () => {
    const manualChar: WorldCharacter = { id: 'manual-1', bindingId: 'b-manual', displayName: '手动角色' }
    const draft = {
      bindings: [manualBinding('char-1', 'b-manual', '手动角色')],
      characters: [manualChar],
      locations: [], factions: [], tone: '', rules: [] as string[],
    }
    const aiInput: WorldCreateInput = {
      name: 'AI 世界',
      bindings: [manualBinding('char-2', 'b-ai', 'AI角色')],
      characters: [{ id: 'ai-1', bindingId: 'b-ai', displayName: 'AI角色' }],
    }
    const merged = mergeProposalIntoDraft(draft, aiInput)
    expect(merged.characters.map((c) => c.displayName)).toEqual(['手动角色', 'AI角色'])
    expect(merged.bindings.map((b) => b.masterItemId)).toEqual(['char-1', 'char-2'])
  })

  it('AI 与用户绑定同一 masterItemId 时不重复建 binding，并重映射实体 bindingId', () => {
    const draft = {
      bindings: [manualBinding('char-1', 'b-manual', '手动角色')],
      characters: [{ id: 'manual-1', bindingId: 'b-manual', displayName: '手动角色' }],
      locations: [], factions: [], tone: '', rules: [] as string[],
    }
    const aiInput: WorldCreateInput = {
      name: 'AI 世界',
      bindings: [manualBinding('char-1', 'b-ai-dup', '再次绑定')],
      characters: [{ id: 'ai-1', bindingId: 'b-ai-dup', displayName: 'AI同名角色' }],
    }
    const merged = mergeProposalIntoDraft(draft, aiInput)
    expect(merged.bindings).toHaveLength(1)
    expect(merged.bindings[0].bindingId).toBe('b-manual')
    // 悬空引用被修复：AI 角色改指既有 binding
    expect(merged.characters).toHaveLength(2)
    expect(merged.characters[1].bindingId).toBe('b-manual')
  })

  it('保留用户已填 tone/rules，AI 规则按并集追加且去重', () => {
    const draft = { bindings: [], characters: [], locations: [], factions: [], tone: '用户基调', rules: ['用户规则', '魔法有代价'] }
    const aiInput: WorldCreateInput = {
      name: 'AI 世界',
      worldSetting: { tone: 'AI基调', rules: ['魔法有代价', 'AI新规则'] },
    }
    const merged = mergeProposalIntoDraft(draft, aiInput)
    expect(merged.tone).toBe('用户基调')
    expect(merged.rules).toEqual(['用户规则', '魔法有代价', 'AI新规则'])
  })

  it('用户未填 tone 时采用 AI tone；空占位规则行被丢弃', () => {
    const draft = { bindings: [], characters: [], locations: [], factions: [], tone: '', rules: [''] }
    const aiInput: WorldCreateInput = { name: 'AI 世界', worldSetting: { tone: 'AI基调', rules: ['AI规则'] } }
    const merged = mergeProposalIntoDraft(draft, aiInput)
    expect(merged.tone).toBe('AI基调')
    expect(merged.rules).toEqual(['AI规则'])
  })

  it('重复应用同一 AI 结果不产生重复实体', () => {
    const draft = { bindings: [], characters: [], locations: [], factions: [], tone: '', rules: [] as string[] }
    const aiInput: WorldCreateInput = {
      name: 'AI 世界',
      bindings: [manualBinding('char-9', 'b-9', '角色9')],
      characters: [{ id: 'ai-9', bindingId: 'b-9', displayName: '角色9' }],
    }
    const once = mergeProposalIntoDraft(draft, aiInput)
    const twice = mergeProposalIntoDraft(once, aiInput)
    expect(twice.bindings).toHaveLength(1)
    expect(twice.characters).toHaveLength(1)
  })
})
