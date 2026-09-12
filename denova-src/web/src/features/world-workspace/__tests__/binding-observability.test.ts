import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindingRemovalImpact,
  bindingStoredStatus,
  bindingUsages,
  type BindingUsageRef,
} from '../binding-observability'
import type { World, WorldAssetBinding } from '../types'

function binding(over: Partial<WorldAssetBinding> = {}): WorldAssetBinding {
  return {
    bindingId: 'b',
    masterItemId: 'm',
    recordKind: 'character_template',
    semanticType: 'character',
    nameSnapshot: '绑定',
    tagsSnapshot: [],
    boundAt: '',
    ...over,
  }
}

function world(over: Partial<World> = {}): World {
  return {
    id: 'w1', schemaVersion: 1, name: '世界', status: 'active',
    bindings: [], characters: [], locations: [], factions: [], timeline: [],
    createdAt: '', updatedAt: '',
    ...over,
  }
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('bindingUsages', () => {
  it('角色绑定被一个角色引用', () => {
    const w = world({
      bindings: [binding({ bindingId: 'bc' })],
      characters: [{ id: 'c1', bindingId: 'bc', displayName: '角色甲' }],
    })
    const u = bindingUsages(w, 'bc')
    expect(u.exists).toBe(true)
    expect(u.scope).toBe('entity')
    expect(u.characters).toEqual([{ entityKind: 'character', entityId: 'c1', entityName: '角色甲' }])
    expect(u.locations).toHaveLength(0)
    expect(u.factions).toHaveLength(0)
  })

  it('同一 entity binding 可被多个角色、地点、势力同时共享引用，且顺序稳定', () => {
    const w = world({
      bindings: [binding({ bindingId: 'shared', semanticType: 'other', scope: 'entity' })],
      characters: [
        { id: 'c2', bindingId: 'shared', displayName: '角色乙' },
        { id: 'c1', bindingId: 'shared', displayName: '角色甲' },
        { id: 'cX', displayName: '无绑定' },
      ],
      locations: [
        { id: 'l2', bindingId: 'shared', name: '地点乙' },
        { id: 'l1', bindingId: 'shared', name: '地点甲' },
      ],
      factions: [{ id: 'f1', bindingId: 'shared', name: '势力甲' }],
    })
    const u = bindingUsages(w, 'shared')
    expect(u.characters.map((r) => r.entityId)).toEqual(['c2', 'c1']) // 保持 World 数组原顺序
    expect(u.locations.map((r) => r.entityId)).toEqual(['l2', 'l1'])
    expect(u.factions.map((r) => r.entityId)).toEqual(['f1'])
    const all: BindingUsageRef[] = [...u.characters, ...u.locations, ...u.factions]
    expect(all).toHaveLength(5)
    // 多对多：不存在单一 owner 字段
    all.forEach((r) => {
      expect(r).not.toHaveProperty('ownerId')
      expect(r).not.toHaveProperty('references')
    })
  })

  it('world scope 无实体引用时仍识别为 world 且保留（不是 orphan）', () => {
    const w = world({
      bindings: [binding({ bindingId: 'bw', semanticType: 'rule', scope: 'world' })],
    })
    const u = bindingUsages(w, 'bw')
    expect(u.exists).toBe(true)
    expect(u.scope).toBe('world')
    expect([...u.characters, ...u.locations, ...u.factions]).toHaveLength(0)
    const impact = bindingRemovalImpact(w, 'bw')
    expect(impact.hasEntityImpact).toBe(false)
    expect(impact.isOrphanCandidate).toBe(false)
  })

  it('旧绑定缺省 scope 时按 semanticType 推导（character→entity；rule→world）', () => {
    const entityWorld = world({ bindings: [binding({ bindingId: 'be', scope: undefined })] })
    expect(bindingUsages(entityWorld, 'be').scope).toBe('entity')
    const ruleWorld = world({ bindings: [binding({ bindingId: 'br', semanticType: 'rule', scope: undefined })] })
    expect(bindingUsages(ruleWorld, 'br').scope).toBe('world')
  })

  it('不存在的 bindingId：exists=false、scope=null、引用全空', () => {
    const w = world({ characters: [{ id: 'c1', bindingId: 'other', displayName: 'x' }] })
    const u = bindingUsages(w, 'missing')
    expect(u.exists).toBe(false)
    expect(u.scope).toBeNull()
    expect(u.characters).toHaveLength(0)
    const impact = bindingRemovalImpact(w, 'missing')
    expect(impact.exists).toBe(false)
    expect(impact.binding).toBeNull()
    expect(impact.isOrphanCandidate).toBe(false)
    expect(impact.hasEntityImpact).toBe(false)
  })

  it('无引用路径返回稳定的空数组引用', () => {
    const w = world({ bindings: [binding({ bindingId: 'bw', scope: 'world' })] })
    const a = bindingUsages(w, 'bw')
    const b = bindingUsages(w, 'bw')
    expect(a.characters).toBe(b.characters)
    expect(a.locations).toBe(b.locations)
    expect(a.factions).toBe(b.factions)
  })
})

describe('bindingRemovalImpact', () => {
  it('entity scope 无引用 → 待清理候选；列出将解除的实体 id 但不执行修改', () => {
    const w = world({ bindings: [binding({ bindingId: 'be' })] })
    const impact = bindingRemovalImpact(w, 'be')
    expect(impact.scope).toBe('entity')
    expect(impact.isOrphanCandidate).toBe(true)
    expect(impact.detachedCharacterIds).toEqual([])
    expect(impact.hasEntityImpact).toBe(false)
    // World 未被修改
    expect(w.bindings).toHaveLength(1)
  })

  it('共享绑定时返回全部将解除引用的角色/地点/势力 id', () => {
    const w = world({
      bindings: [binding({ bindingId: 's', scope: 'entity' })],
      characters: [{ id: 'c1', bindingId: 's', displayName: '甲' }, { id: 'c2', bindingId: 's', displayName: '乙' }],
      locations: [{ id: 'l1', bindingId: 's', name: '地' }],
      factions: [{ id: 'f1', bindingId: 's', name: '势' }],
    })
    const impact = bindingRemovalImpact(w, 's')
    expect(impact.detachedCharacterIds).toEqual(['c1', 'c2'])
    expect(impact.detachedLocationIds).toEqual(['l1'])
    expect(impact.detachedFactionIds).toEqual(['f1'])
    expect(impact.hasEntityImpact).toBe(true)
    expect(impact.isOrphanCandidate).toBe(false) // 仍有引用，不是 orphan
    // 实体上的 bindingId 仍然存在（只计算，不解绑）
    expect(w.characters.every((c) => c.bindingId === 's')).toBe(true)
  })

  it('结果对象不含 ownerId / references 反向索引设计', () => {
    const w = world({ bindings: [binding({ bindingId: 'b' })] })
    const impact = bindingRemovalImpact(w, 'b')
    expect(impact).not.toHaveProperty('ownerId')
    expect(impact).not.toHaveProperty('references')
    expect(Object.keys(impact).sort()).toEqual([
      'binding', 'bindingId', 'detachedCharacterIds', 'detachedFactionIds',
      'detachedLocationIds', 'exists', 'hasEntityImpact', 'isOrphanCandidate',
      'scope', 'usages',
    ].sort())
  })
})

describe('bindingStoredStatus', () => {
  it('masterRevision 缺失 / 空串 / 纯空白 → unchecked；非空 → baseline', () => {
    expect(bindingStoredStatus(binding({ masterRevision: undefined }))).toBe('unchecked')
    expect(bindingStoredStatus(binding({ masterRevision: '' }))).toBe('unchecked')
    expect(bindingStoredStatus(binding({ masterRevision: '   ' }))).toBe('unchecked')
    expect(bindingStoredStatus(binding({ masterRevision: 'sha256:abc' }))).toBe('baseline')
  })

  it('存储状态只有 unchecked/baseline，绝不产出联网健康态', () => {
    const status = bindingStoredStatus(binding({ masterRevision: 'sha256:abc' }))
    expect(['unchecked', 'baseline']).toContain(status)
    // baseline 不等于 latest：这里不做任何联网判定
    expect(status).not.toBe('latest')
    expect(status).not.toBe('stale')
    expect(status).not.toBe('missing')
    expect(status).not.toBe('unavailable')
    expect(status).not.toBe('checking')
  })
})

describe('纯函数与副作用边界', () => {
  it('调用三个函数不修改输入 World（结构与引用保持）', () => {
    const w = world({
      bindings: [binding({ bindingId: 's', scope: 'entity', masterRevision: 'r' })],
      characters: [{ id: 'c1', bindingId: 's', displayName: '甲' }],
    })
    const snapshot = structuredClone(w)
    const origBinding = w.bindings[0]
    const origChar = w.characters[0]
    bindingUsages(w, 's')
    bindingRemovalImpact(w, 's')
    bindingStoredStatus(w.bindings[0])
    expect(w).toEqual(snapshot)
    // 绑定与实体对象引用未被替换（与调用前捕获的同一对象比较）
    expect(w.bindings[0]).toBe(origBinding)
    expect(w.characters[0]).toBe(origChar)
  })

  it('派生结果的共享引用在类型上是只读的', () => {
    const w = world({
      bindings: [binding({ bindingId: 's', scope: 'world' })],
    })
    const impact = bindingRemovalImpact(w, 's')
    // 这些断言用于锁定派生结果不能成为修改 World 的旁路；仅做类型检查，不执行。
    if (false) {
      // @ts-expect-error BindingRemovalImpact.binding 必须是只读视图
      impact.binding!.nameSnapshot = 'mutated'
      // @ts-expect-error BindingUsages 的引用组必须是只读数组
      impact.usages.characters.push({ entityKind: 'character', entityId: 'c', entityName: 'c' })
    }
  })

  it('不触发网络、浏览器存储或 Master 详情请求', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const w = world({
      bindings: [binding({ bindingId: 's', scope: 'entity' })],
      characters: [{ id: 'c1', bindingId: 's', displayName: '甲' }],
    })
    bindingUsages(w, 's')
    bindingRemovalImpact(w, 's')
    bindingStoredStatus(w.bindings[0])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
  })
})
