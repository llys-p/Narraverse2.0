import { describe, expect, it } from 'vitest'
import { proposalToWorldCreateInput } from '../world-proposal'
import type {
  ProposalChoices,
  StructureProposal,
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

  it('settingOverride.tone wins and rules stay empty when not adopted', () => {
    const p = proposal()
    const c = choices({ settingOverride: { tone: '轻松' } })
    const input = proposalToWorldCreateInput(p, c, BASE)
    expect(input.worldSetting!.tone).toBe('轻松')
    expect(input.worldSetting!.rules).toEqual([])
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
})
